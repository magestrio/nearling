mod common;

use common::*;
use near_crypto::Signature;
use near_sdk::borsh::{self, BorshDeserialize};
use near_sdk::store::LookupMap;
use near_contract_standards::non_fungible_token::NonFungibleToken;
use nearling_contract::ContractAnyChainV1;
use nearling_contract::any_chain::{SWEEP_ACTIVE_RECORD_BYTES, SWEEP_SEQUENCE_RECORD_BYTES};
use nearling_contract::events::hex;
use nearling_contract::pet::VersionedPet;
use near_workspaces::types::{AccessKey, AccountDetailsPatch, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const BASE_USDC: &str = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SOLANA_USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ROUTE: &str = "0123456789abcdef0123456789abcdef";

fn rlp_bytes(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() == 1 && bytes[0] < 0x80 { return bytes.to_vec(); }
    let mut out = if bytes.len() < 56 { vec![0x80 + bytes.len() as u8] }
        else { vec![0xb8, bytes.len() as u8] };
    out.extend_from_slice(bytes);
    out
}

fn base_payload(token: &str, destination: &str, amount: u64) -> Vec<u8> {
    let to = decode_hex_fixture(token.trim_start_matches("0x"));
    let recipient = decode_hex_fixture(destination.trim_start_matches("0x"));
    let mut call = vec![0xa9, 0x05, 0x9c, 0xbb];
    call.extend_from_slice(&[0; 12]);
    call.extend_from_slice(&recipient);
    call.extend_from_slice(&[0; 24]);
    call.extend_from_slice(&amount.to_be_bytes());
    let mut fields = Vec::new();
    for value in [vec![0x21, 0x05], vec![], vec![1], vec![2], vec![1, 0x86, 0xa0], to, vec![], call] {
        fields.extend_from_slice(&rlp_bytes(&value));
    }
    fields.push(0xc0); // empty access list
    let mut payload = vec![2, 0xf8, fields.len() as u8];
    payload.extend_from_slice(&fields);
    payload
}

fn decode_hex_fixture(text: &str) -> Vec<u8> {
    text.as_bytes().chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()).collect()
}

fn solana_payload(amount: u64) -> Vec<u8> {
    let mint = decode_hex_fixture("c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61");
    let program = decode_hex_fixture("06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9");
    let mut message = vec![1, 0, 2, 5];
    for key in [&[1u8; 32][..], &[2u8; 32][..], &[3u8; 32][..], &mint, &program] {
        message.extend_from_slice(key);
    }
    message.extend_from_slice(&[4; 32]); // recent blockhash
    message.extend_from_slice(&[1, 4, 4, 1, 3, 2, 0, 10, 12]);
    message.extend_from_slice(&amount.to_le_bytes());
    message.push(6); // USDC decimals
    message
}

/// Mutate only the stable prefix; later state-tail fields remain byte-for-byte intact.
#[derive(near_sdk::borsh::BorshDeserialize, near_sdk::borsh::BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct StateThroughPool {
    owner_id: near_sdk::AccountId,
    server_id: near_sdk::AccountId,
    treasury_id: near_sdk::AccountId,
    tokens: NonFungibleToken,
    pets: LookupMap<String, VersionedPet>,
    hatched: LookupMap<near_sdk::AccountId, String>,
    births_day: u64,
    births_today: u32,
    next_token_id: u64,
    pool: u128,
}

async fn zero_pool(ctx: &Ctx) -> anyhow::Result<()> {
    let state = ctx.read_state().await?;
    let mut reader = &state[..];
    let mut prefix = StateThroughPool::deserialize_reader(&mut reader)?;
    prefix.pool = 0;
    let mut patched = borsh::to_vec(&prefix)?;
    patched.extend_from_slice(reader);
    ctx.worker.patch_state(ctx.contract.id(), b"STATE", &patched).await?;
    Ok(())
}

async fn mock_signer(ctx: &Ctx) -> anyhow::Result<Contract> {
    let mut build = cargo_near_build::BuildOpts::default();
    build.manifest_path = Some(cargo_near_build::camino::Utf8PathBuf::from("tests/fixtures/mpc/Cargo.toml"));
    let wasm = std::fs::read(cargo_near_build::build_with_cli(build)
        .map_err(|e| anyhow::anyhow!("MPC fixture build: {e:?}"))?)?;
    let id = "mpc.near".parse()?;
    let key = SecretKey::from_seed(KeyType::ED25519, "mpc.near");
    ctx.worker.patch(&id)
        .account(AccountDetailsPatch::default().balance(NearToken::from_near(10)))
        .access_key(key.public_key(), AccessKey::full_access())
        .code(&wasm).transact().await?;
    let signer = Contract::from_secret_key(id, key, &ctx.worker);
    signer.call("new").transact().await?.into_result()?;
    Ok(signer)
}

async fn implicit_owner(ctx: &Ctx, seed: &str) -> anyhow::Result<(Account, near_crypto::SecretKey, String)> {
    let key = SecretKey::from_seed(KeyType::ED25519, seed);
    let id_hex = hex(key.public_key().key_data());
    let signing_key = near_crypto::SecretKey::from_seed(near_crypto::KeyType::ED25519, seed);
    let id = id_hex.parse()?;
    ctx.worker.patch(&id)
        .account(AccountDetailsPatch::default().balance(NearToken::from_near(2)))
        .access_key(key.public_key(), AccessKey::full_access()).transact().await?;
    Ok((Account::from_secret_key(id, key, &ctx.worker), signing_key, id_hex))
}

async fn approval(ctx: &Ctx, key: &near_crypto::SecretKey, signer: &Contract, args: &Value) -> anyhow::Result<Value> {
    let payload = decode_hex_fixture(args["signing_payload_hex"].as_str().unwrap());
    let signer_id = signer.id().to_string();
    let envelope = json!({
        "contract_id": ctx.contract.id(), "signer_id": signer_id,
        "token_id": args["token_id"], "chain": args["chain"], "path": args["path"],
        "usdc_contract": args["usdc_contract"], "amount_base_units": args["amount_base_units"],
        "destination": args["destination"], "refund_recipient": args["refund_recipient"],
        "route_id": args["route_id"], "sequence": args["sequence"],
        "expiry_ms": args["expiry_ms"],
        "signing_payload_sha256": Sha256::digest(&payload).to_vec(),
    });
    let digest_hex: String = ctx.contract.view("sweep_approval_hash_view")
        .args_json(json!({"envelope": envelope})).await?.json()?;
    let digest: Vec<u8> = digest_hex.as_bytes().chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()).collect();
    let sig = match key.sign(&digest) { Signature::ED25519(sig) => sig.to_bytes(), _ => unreachable!() };
    Ok(json!({"public_key": hex(key.public_key().key_data()), "signature": hex(&sig)}))
}

async fn signer_setup(ctx: &Ctx, signer: &Contract) -> anyhow::Result<()> {
    let denied = ctx.server.call(ctx.contract.id(), "pin_sweep_signer")
        .args_json(json!({"signer_id": signer.id()})).transact().await?;
    assert_refused(&denied, "private");
    let stranger = ctx.account("pin-stranger", 1).await?;
    let denied = stranger.call(ctx.contract.id(), "pin_sweep_signer")
        .args_json(json!({"signer_id": signer.id()})).transact().await?;
    assert_refused(&denied, "private");
    ctx.contract.call("pin_sweep_signer").args_json(json!({"signer_id": signer.id()}))
        .transact().await?.into_result()?;
    let view: Value = ctx.contract.view("sweep_signer_view").await?.json()?;
    assert_eq!(view["signer_id"], signer.id().as_str());
    assert_eq!(view["base_domain_id"], 0);
    assert_eq!(view["solana_domain_id"], 1);
    assert_eq!(view["path_format"], "<chain>:<token_id>");
    assert!(view.get("base_address").is_none());
    let repin = ctx.contract.call("pin_sweep_signer")
        .args_json(json!({"signer_id": signer.id()})).transact().await?;
    assert_refused(&repin, "sweep_signer_already_pinned");
    Ok(())
}

fn base_args(expiry_ms: u64) -> Value {
    json!({"token_id":"0", "chain":"base", "path":"base:0", "usdc_contract":BASE_USDC,
        "amount_base_units": 1_000_000, "destination":"0x1111111111111111111111111111111111111111",
        "refund_recipient":"0x2222222222222222222222222222222222222222",
        "route_id":ROUTE, "sequence":0, "expiry_ms":expiry_ms,
        "signing_payload_hex":hex(&base_payload(BASE_USDC,
            "0x1111111111111111111111111111111111111111", 1_000_000))})
}

async fn send(ctx: &Ctx, args: Value) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(ctx.server.call(ctx.contract.id(), "sweep_sign")
        .args_json(args).gas(Gas::from_tgas(150)).transact().await?)
}

// spec: add-any-chain-feed › Pet sweep authorization contract › valid authorization
// spec: add-any-chain-feed › Pet sweep authorization contract › wrong caller
// spec: add-any-chain-feed › Pet sweep authorization contract › unknown pet
// spec: add-any-chain-feed › Pet sweep authorization contract › wrong or stale owner approval
// spec: add-any-chain-feed › Pet sweep authorization contract › expired or reused approval
// spec: add-any-chain-feed › Pet sweep authorization contract › wrong derivation path
#[tokio::test]
async fn pinned_signer_and_current_owner_bind_every_sweep_byte() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let signer = mock_signer(&ctx).await?;
    let (owner, key, owner_id) = implicit_owner(&ctx, "sweep-owner").await?;
    ctx.mint(&owner_id, "Pixel", "Curious").await?.into_result()?;
    signer_setup(&ctx, &signer).await?;
    let now = ctx.block_timestamp().await? / 1_000_000;
    let mut args = base_args(now + 600_000);
    args["owner_approval"] = approval(&ctx, &key, &signer, &args).await?;

    let mut wrong_path = args.clone();
    wrong_path["path"] = json!("solana:0");
    assert_refused(&send(&ctx, wrong_path).await?, "wrong_sweep_path");
    let mut changed_payload = args.clone();
    changed_payload["signing_payload_hex"] = json!(hex(&base_payload(BASE_USDC,
        "0x1111111111111111111111111111111111111111", 999_999)));
    assert_refused(&send(&ctx, changed_payload).await?, "bad_sweep_payload");
    let mut unknown = args.clone();
    unknown["token_id"] = json!("99");
    assert_refused(&send(&ctx, unknown).await?, "no_pet");
    let mut expired = args.clone();
    expired["expiry_ms"] = json!(now.saturating_sub(1));
    assert_refused(&send(&ctx, expired).await?, "sweep_approval_expired");
    let stranger = ctx.account("sweep-stranger", 2).await?;
    let denied = stranger.call(ctx.contract.id(), "sweep_sign")
        .args_json(args.clone()).transact().await?;
    assert_refused(&denied, "not_server");

    let before_bytes = ctx.storage_usage().await?;
    let before_pool = ctx.pool().await?;
    let success = send(&ctx, args.clone()).await?;
    success.clone().into_result()?;
    let authorized: Value = event_logs(&success).iter()
        .filter_map(|log| serde_json::from_str(log).ok())
        .find(|event: &Value| event["event"] == "cross_chain_sweep_authorized")
        .expect("authorization event missing");
    assert_eq!(authorized["data"]["owner_id"], owner_id);
    assert_eq!(authorized["data"]["refund_recipient"], args["refund_recipient"]);
    let request: Value = signer.view("last_request").await?.json()?;
    assert_eq!(request["path"], "base:0");
    assert_eq!(request["domain_id"], 0);
    // The independent Keccak vector for the canonical EIP-1559 preimage above.
    assert_eq!(request["payload_v2"]["Ecdsa"],
        "beca69d35e377d4b8258dabc9ff69acd54afdddd6e80f9d71806d12a3d6fee23");
    eprintln!("sweep receipts: {:?}", success.outcomes().iter()
        .map(|receipt| (receipt.executor_id.to_string(), receipt.gas_burnt.as_gas()))
        .collect::<Vec<_>>());
    assert!(success.outcomes().iter().all(|receipt| receipt.gas_burnt < Gas::from_tgas(10)));
    let written = ctx.storage_usage().await? - before_bytes;
    eprintln!("sweep records {written} bytes; ceiling {}", SWEEP_ACTIVE_RECORD_BYTES + SWEEP_SEQUENCE_RECORD_BYTES);
    assert!(written <= SWEEP_ACTIVE_RECORD_BYTES + SWEEP_SEQUENCE_RECORD_BYTES);
    assert_eq!(before_pool - ctx.pool().await?, u128::from(SWEEP_ACTIVE_RECORD_BYTES + SWEEP_SEQUENCE_RECORD_BYTES) * 10_000_000_000_000_000_000);
    assert_refused(&send(&ctx, args.clone()).await?, "sweep_already_active");

    owner.call(ctx.contract.id(), "nft_transfer")
        .args_json(json!({"receiver_id":stranger.id(), "token_id":"0", "approval_id":null, "memo":null}))
        .deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    let after_gift: Value = ctx.contract.view("sweep_signer_view").await?.json()?;
    assert_eq!(after_gift["signer_id"], signer.id().as_str());
    assert_eq!(after_gift["path_format"], "<chain>:<token_id>");
    let mut stale = args;
    stale["sequence"] = json!(1);
    assert_refused(&send(&ctx, stale).await?, "not_current_owner");
    Ok(())
}

// spec: add-any-chain-feed › Pet sweep authorization contract › valid authorization
#[tokio::test]
async fn failed_mpc_sign_keeps_no_source_transfer_claim() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let signer = mock_signer(&ctx).await?;
    let (_owner, key, owner_id) = implicit_owner(&ctx, "sweep-owner-fail").await?;
    ctx.mint(&owner_id, "Pixel", "Curious").await?.into_result()?;
    signer_setup(&ctx, &signer).await?;
    signer.call("set_fail_sign").args_json(json!({"fail_sign":true})).transact().await?.into_result()?;
    let now = ctx.block_timestamp().await? / 1_000_000;
    let mut args = base_args(now + 600_000);
    args["owner_approval"] = approval(&ctx, &key, &signer, &args).await?;
    let before_bytes = ctx.storage_usage().await?;
    let result = send(&ctx, args).await?;
    assert!(event_logs(&result).iter().any(|log| log.contains("cross_chain_sweep_authorized")));
    assert!(event_logs(&result).iter().any(|log| log.contains("cross_chain_sweep_sign_failed")));
    assert!(!event_logs(&result).iter().any(|log| log.contains("source_transfer")));
    let sequence_bytes = ctx.storage_usage().await? - before_bytes;
    eprintln!("sweep sequence {sequence_bytes} bytes after failed signature; ceiling {SWEEP_SEQUENCE_RECORD_BYTES}");
    assert!(sequence_bytes <= SWEEP_SEQUENCE_RECORD_BYTES);
    let mut reused = base_args(now + 600_000);
    reused["owner_approval"] = approval(&ctx, &key, &signer, &reused).await?;
    assert_refused(&send(&ctx, reused).await?, "sweep_sequence_used");
    Ok(())
}

// spec: add-any-chain-feed › Pet sweep authorization contract › valid authorization
#[tokio::test]
async fn solana_uses_ed25519_domain_and_exact_pinned_path() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let signer = mock_signer(&ctx).await?;
    let (_owner, key, owner_id) = implicit_owner(&ctx, "sweep-owner-solana").await?;
    ctx.mint(&owner_id, "Pixel", "Curious").await?.into_result()?;
    signer_setup(&ctx, &signer).await?;
    let now = ctx.block_timestamp().await? / 1_000_000;
    let mut args = base_args(now + 600_000);
    args["chain"] = json!("solana");
    args["path"] = json!("solana:0");
    args["usdc_contract"] = json!(SOLANA_USDC);
    args["destination"] = json!("CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8");
    args["signing_payload_hex"] = json!(hex(&solana_payload(1_000_000)));
    args["owner_approval"] = approval(&ctx, &key, &signer, &args).await?;
    send(&ctx, args.clone()).await?.into_result()?;
    let request: Value = signer.view("last_request").await?.json()?;
    assert_eq!(request["path"], "solana:0");
    assert_eq!(request["domain_id"], 1);
    assert_eq!(request["payload_v2"]["Eddsa"], args["signing_payload_hex"]);
    Ok(())
}

// spec: add-any-chain-feed › Pet sweep authorization contract › valid authorization
// spec: add-any-chain-feed › Pet sweep authorization contract › unsupported token or chain
// spec: add-any-chain-feed › Pet sweep authorization contract › excessive sweep
// spec: add-any-chain-feed › Pet sweep authorization contract › missing quote destination
#[tokio::test]
async fn base_rejects_owner_signed_bytes_for_other_transfers() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let signer = mock_signer(&ctx).await?;
    let (_owner, key, owner_id) = implicit_owner(&ctx, "base-payload-owner").await?;
    ctx.mint(&owner_id, "Pixel", "Curious").await?.into_result()?;
    signer_setup(&ctx, &signer).await?;
    let now = ctx.block_timestamp().await? / 1_000_000;
    let standard = base_args(now + 600_000);
    let dest = standard["destination"].as_str().unwrap();
    let cases = [
        base_payload(BASE_USDC, dest, 999_999),
        base_payload("0x1111111111111111111111111111111111111111", dest, 1_000_000),
        base_payload(BASE_USDC, "0x3333333333333333333333333333333333333333", 1_000_000),
        vec![0x11; 32],
    ];
    for payload in cases {
        let mut args = standard.clone();
        args["signing_payload_hex"] = json!(hex(&payload));
        args["owner_approval"] = approval(&ctx, &key, &signer, &args).await?;
        assert_refused(&send(&ctx, args).await?, "bad_sweep_payload");
    }
    let request: Value = signer.view("last_request").await?.json()?;
    assert!(request.is_null());
    Ok(())
}

// spec: add-any-chain-feed › Pet sweep authorization contract › valid authorization
// spec: add-any-chain-feed › Pet sweep authorization contract › unsupported token or chain
#[tokio::test]
async fn solana_rejects_owner_signed_bytes_for_other_transfers() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let signer = mock_signer(&ctx).await?;
    let (_owner, key, owner_id) = implicit_owner(&ctx, "solana-payload-owner").await?;
    ctx.mint(&owner_id, "Pixel", "Curious").await?.into_result()?;
    signer_setup(&ctx, &signer).await?;
    let now = ctx.block_timestamp().await? / 1_000_000;
    let mut standard = base_args(now + 600_000);
    standard["chain"] = json!("solana");
    standard["path"] = json!("solana:0");
    standard["usdc_contract"] = json!(SOLANA_USDC);
    standard["destination"] = json!("CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8");
    let mut wrong_amount = solana_payload(1_000_000);
    let last = wrong_amount.len();
    wrong_amount[last - 9] ^= 1;
    let mut wrong_destination = solana_payload(1_000_000);
    wrong_destination[4 + 2 * 32] ^= 1;
    let mut wrong_program = solana_payload(1_000_000);
    wrong_program[4 + 4 * 32] ^= 1;
    for payload in [wrong_amount, wrong_destination, wrong_program, vec![0x22; 20]] {
        let mut args = standard.clone();
        args["signing_payload_hex"] = json!(hex(&payload));
        args["owner_approval"] = approval(&ctx, &key, &signer, &args).await?;
        assert_refused(&send(&ctx, args).await?, "bad_sweep_payload");
    }
    let request: Value = signer.view("last_request").await?.json()?;
    assert!(request.is_null());
    Ok(())
}

// spec: add-any-chain-feed › Pet sweep authorization contract › excessive sweep
// spec: add-any-chain-feed › Pet sweep authorization contract › duplicate sweep
// spec: add-any-chain-feed › Pet address deposit flow › remainder after sweep
#[tokio::test]
async fn amount_boundary_and_new_approval_after_one_hour() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let signer = mock_signer(&ctx).await?;
    let (_owner, key, owner_id) = implicit_owner(&ctx, "sweep-window-owner").await?;
    ctx.mint(&owner_id, "Pixel", "Curious").await?.into_result()?;
    signer_setup(&ctx, &signer).await?;
    let now = ctx.block_timestamp().await? / 1_000_000;
    let mut args = base_args(now + 600_000);
    for amount in [0, 1_000_001] {
        let mut invalid = args.clone();
        invalid["amount_base_units"] = json!(amount);
        invalid["signing_payload_hex"] = json!(hex(&base_payload(BASE_USDC,
            "0x1111111111111111111111111111111111111111", amount)));
        invalid["owner_approval"] = approval(&ctx, &key, &signer, &invalid).await?;
        assert_refused(&send(&ctx, invalid).await?, "sweep_amount_limit");
    }
    args["owner_approval"] = approval(&ctx, &key, &signer, &args).await?;
    send(&ctx, args.clone()).await?.into_result()?;
    assert_refused(&send(&ctx, args).await?, "sweep_already_active");
    ctx.worker.fast_forward(12_500).await?;
    let later = ctx.block_timestamp().await? / 1_000_000;
    anyhow::ensure!(later > now + 3_600_000, "sandbox did not advance beyond sweep window");
    let mut next = base_args(later + 600_000);
    next["sequence"] = json!(1);
    next["route_id"] = json!("fedcba9876543210fedcba9876543210");
    next["owner_approval"] = approval(&ctx, &key, &signer, &next).await?;
    send(&ctx, next).await?.into_result()?;
    Ok(())
}

// spec: add-any-chain-feed › Pet sweep authorization contract › valid authorization
#[tokio::test]
async fn sweep_needs_project_storage_before_mpc_request() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let signer = mock_signer(&ctx).await?;
    let (_owner, key, owner_id) = implicit_owner(&ctx, "sweep-owner-no-stake").await?;
    ctx.mint(&owner_id, "Pixel", "Curious").await?.into_result()?;
    signer_setup(&ctx, &signer).await?;
    let now = ctx.block_timestamp().await? / 1_000_000;
    let mut args = base_args(now + 600_000);
    args["owner_approval"] = approval(&ctx, &key, &signer, &args).await?;
    zero_pool(&ctx).await?;
    let denied = send(&ctx, args).await?;
    assert_refused(&denied, "sweep_storage_unavailable");
    let request: Value = signer.view("last_request").await?.json()?;
    assert!(request.is_null());
    Ok(())
}

// spec: add-any-chain-feed › Pet sweep authorization contract › valid authorization
#[tokio::test]
async fn stage_two_layout_migrates_without_touching_pets_or_pool() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.mint("alice.near", "Pixel", "Curious").await?.into_result()?;
    let pet = ctx.pet_view("0").await?;
    let pool = ctx.pool().await?;
    let state = ctx.read_state().await?;
    let mut reader = &state[..];
    let old = ContractAnyChainV1::deserialize_reader(&mut reader)?;
    let old_bytes = borsh::to_vec(&old)?;
    assert!(old_bytes.len() < state.len());
    ctx.worker.patch_state(ctx.contract.id(), b"STATE", &old_bytes).await?;
    ctx.contract.call("migrate_any_chain_sweep").transact().await?.into_result()?;
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.pool().await?, pool);
    let signer: Value = ctx.contract.view("sweep_signer_view").await?.json()?;
    assert!(signer["signer_id"].is_null());
    Ok(())
}
