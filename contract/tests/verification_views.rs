mod common;

use common::*;
use near_workspaces::types::NearToken;
use nearling_contract::events::hex;
use serde_json::{Value, json};
use std::{fs, process::Command, time::{SystemTime, UNIX_EPOCH}};

const CHARACTER: &str = "I'm calm and unhurried.";

// spec: add-verification › Pet view contract › запись прочитана
#[tokio::test]
async fn public_views_track_the_record_and_owner_without_writing() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let alice = ctx.account("alice", 10).await?;
    let bob = ctx.account("bob", 10).await?;
    let alice_id = alice.id().to_string();
    let bob_id = bob.id().to_string();

    assert_eq!(ctx.pet_view("0").await?, Value::Null);
    assert_eq!(ctx.nft_token("0").await?, Value::Null);
    assert_eq!(ctx.supply_for(&alice_id).await?, "0");

    let born = ctx.mint(&alice_id, "Pixel", CHARACTER).await?;
    let birth_events = event_logs(&born);
    born.into_result()?;
    let birth: Value = serde_json::from_str(&birth_events[1])?;
    assert_eq!(birth["event"], "pet_born");
    assert_eq!(birth["data"]["token_id"], "0");
    assert_eq!(birth["data"]["character_sha256"].as_str().unwrap().len(), 64);

    let before = ctx.snapshot(&alice_id).await?;
    let record = ctx.pet_view("0").await?;
    let token = ctx.nft_token("0").await?;
    assert_eq!(record["name"], "Pixel");
    assert_eq!(record["character"], CHARACTER);
    assert_eq!(record["owner_id"], alice_id);
    assert_eq!(record["stage"], "Baby");
    assert_eq!(record["traits"], json!([]));
    assert_eq!(record["outfits"], json!([]));
    assert_eq!(record["work_known"], json!([]));
    assert_eq!(token["token_id"], "0");
    assert_eq!(token["owner_id"], alice_id);
    let extra: Value = serde_json::from_str(token["metadata"]["extra"].as_str().unwrap())?;
    assert_eq!(extra, json!({ "stage": "Baby", "traits": [], "outfits": [] }));
    assert_eq!(ctx.supply_for(&alice_id).await?, "1");
    let owned: Value = ctx.contract.view("nft_tokens_for_owner")
        .args_json(json!({ "account_id": alice_id }))
        .await?.json()?;
    assert_eq!(owned.as_array().unwrap().len(), 1);
    assert_eq!(owned[0]["token_id"], "0");
    assert_eq!(ctx.snapshot(&alice_id).await?, before);

    // Exercise the public transfer path: the later views must read the new owner.
    alice.call(ctx.contract.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": bob_id, "token_id": "0" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact().await?.into_result()?;
    let transferred = ctx.snapshot(&bob_id).await?;
    assert_eq!(ctx.pet_view("0").await?["owner_id"], bob_id);
    assert_eq!(ctx.pet_view("0").await?["character"], CHARACTER);
    assert_eq!(ctx.pet_view("0").await?["transfer_generation"], 1);
    assert_eq!(ctx.nft_token("0").await?["owner_id"], bob_id);
    assert_eq!(ctx.snapshot(&bob_id).await?, transferred);
    assert_eq!(ctx.supply_for(&alice_id).await?, "0");
    assert_eq!(ctx.supply_for(&bob_id).await?, "1");
    let bob_owned: Value = ctx.contract.view("nft_tokens_for_owner")
        .args_json(json!({ "account_id": bob_id }))
        .await?.json()?;
    assert_eq!(bob_owned[0]["token_id"], "0");
    bob.call(ctx.contract.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": alice_id, "token_id": "0" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact().await?.into_result()?;
    assert_eq!(ctx.pet_view("0").await?["owner_id"], alice_id);
    assert_eq!(ctx.pet_view("0").await?["transfer_generation"], 2);
    Ok(())
}

// spec: add-verification › Contract code contract › код обновлён
#[tokio::test]
async fn built_wasm_exposes_version_and_source_metadata() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let alice = ctx.account("alice", 10).await?;
    let bob = ctx.account("bob", 10).await?;
    let born = ctx.mint(alice.id().as_str(), "Pixel", CHARACTER).await?;
    let logs = event_logs(&born);
    born.into_result()?;
    let birth: Value = serde_json::from_str(&logs[1])?;
    let birth_hash = birth["data"]["character_sha256"].as_str().unwrap().to_owned();
    let metadata: Value = ctx.contract.view("contract_source_metadata")
        .args_json(json!({}))
        .await?.json()?;
    assert_eq!(metadata["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(metadata["link"], env!("CARGO_PKG_REPOSITORY"));

    // Build a second real wasm from the same source with a new package version. The manifest and
    // lockfile in this temporary copy are changed together; the repo's files stay untouched.
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let current_version = env!("CARGO_PKG_VERSION");
    let (major_minor, patch) = current_version.rsplit_once('.').unwrap();
    let upgraded_version = format!("{major_minor}.{}", patch.parse::<u64>()? + 1);
    let unique = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let copy = std::env::temp_dir().join(format!("nearling-verification-upgrade-{unique}"));
    fs::create_dir_all(copy.join("src"))?;
    for file in ["lib.rs", "pet.rs", "events.rs", "limits.rs"] {
        fs::copy(source.join("src").join(file), copy.join("src").join(file))?;
    }
    fs::copy(source.join("rust-toolchain.toml"), copy.join("rust-toolchain.toml"))?;
    let manifest = fs::read_to_string(source.join("Cargo.toml"))?;
    fs::write(copy.join("Cargo.toml"), manifest.replacen(
        &format!("version = \"{current_version}\""), &format!("version = \"{upgraded_version}\""), 1))?;
    let lock = fs::read_to_string(source.join("Cargo.lock"))?;
    fs::write(copy.join("Cargo.lock"), lock.replace(
        &format!("name = \"nearling-contract\"\nversion = \"{current_version}\""),
        &format!("name = \"nearling-contract\"\nversion = \"{upgraded_version}\""),
    ))?;
    let upgraded_target = source.join("target/verification-upgrade");
    let built = Command::new("cargo").args(["near", "build", "non-reproducible-wasm", "--locked"])
        .env("CARGO_TARGET_DIR", &upgraded_target)
        .current_dir(&copy).output()?;
    anyhow::ensure!(built.status.success(), "updated wasm build failed: {}", String::from_utf8_lossy(&built.stderr));
    let updated_wasm = fs::read(upgraded_target.join("near/nearling_contract.wasm"))?;
    fs::remove_dir_all(copy)?;
    anyhow::ensure!(updated_wasm != wasm(), "updated wasm must change");

    // Simulate an account still holding the pre-verification state, then redeploy and migrate it.
    let pool_before_migration = ctx.pool().await?;
    let state = ctx.read_state().await?;
    anyhow::ensure!(state.ends_with(&[1, 0, 0, 0, b'g']), "new transfer map is the state tail");
    ctx.worker.patch_state(ctx.contract.id(), b"STATE", &state[..state.len() - 5]).await?;
    ctx.contract.as_account().deploy(&updated_wasm).await?.into_result()?;
    ctx.contract.call("migrate_verification").args_json(json!({})).transact().await?.into_result()?;
    assert!(
        pool_before_migration - ctx.pool().await?
            >= u128::from(nearling_contract::limits::TRANSFER_GENERATION_BYTES)
                * 10_000_000_000_000_000_000u128
    );
    let changed: Value = ctx.contract.view("contract_source_metadata").args_json(json!({})).await?.json()?;
    assert_eq!(changed["version"].as_str(), Some(upgraded_version.as_str()));
    assert_eq!(changed["link"], metadata["link"]);
    assert_eq!(ctx.pet_view("0").await?["character"], CHARACTER);
    assert_eq!(ctx.pet_view("0").await?["transfer_generation"], 0);
    alice.call(ctx.contract.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": bob.id(), "token_id": "0" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact().await?.into_result()?;
    assert_eq!(ctx.pet_view("0").await?["transfer_generation"], 1);

    ctx.set_pet("0", |pet| pet.character = "I was rewritten after hatch.".into()).await?;
    let current = ctx.pet_view("0").await?;
    let current_character = current["character"].as_str().unwrap();
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let current_hash = hex(&near_sdk::env::sha256(current_character.as_bytes()));
    assert_ne!(current_hash, birth_hash, "the original birth event detects a changed character");
    Ok(())
}

// spec: add-verification › Pet view contract › запись прочитана × legacy transfer reserve migration
#[tokio::test]
async fn deployed_transfer_map_can_reserve_existing_pets_once() -> anyhow::Result<()> {
    let rich = setup(BIG_POOL).await?;
    rich.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    let birth_cost = BIG_POOL - rich.pool().await?;
    let ctx = setup(birth_cost).await?;
    ctx.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    assert_eq!(ctx.pool().await?, 0);
    let unfunded = ctx
        .contract
        .call("migrate_generation_reserve")
        .args_json(json!({}))
        .transact()
        .await?;
    assert_refused(&unfunded, "pool_empty");
    assert_eq!(ctx.pool().await?, 0);
    ctx.fund(10_000_000_000_000_000_000_000).await?;
    let pool_before = ctx.pool().await?;
    ctx.contract
        .call("migrate_generation_reserve")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    let pool_after = ctx.pool().await?;
    assert!(
        pool_before - pool_after
            >= u128::from(nearling_contract::limits::TRANSFER_GENERATION_BYTES)
                * 10_000_000_000_000_000_000u128
    );
    assert_eq!(ctx.pet_view("0").await?["transfer_generation"], 0);
    let again = ctx
        .contract
        .call("migrate_generation_reserve")
        .args_json(json!({}))
        .transact()
        .await?;
    assert_refused(&again, "already_migrated");
    assert_eq!(ctx.pool().await?, pool_after);
    Ok(())
}

// spec: add-verification › Pet view contract › запись прочитана
#[tokio::test]
async fn a_receipt_is_an_event_and_does_not_add_per_thought_state() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(0, NEAR / 100).await?;
    let before_storage = ctx.storage_usage().await?;
    let thought = json!({
        "model": "Qwen/Qwen3.8-27B",
        "price": "1000000",
        "calls": [{
            "req_sha256": "1".repeat(64),
            "res_sha256": "2".repeat(64),
            "signature": format!("0x{}", "3".repeat(130)),
            "sig_kind": "provider_tee",
            "signer": format!("0x{}", "4".repeat(40)),
            "tokens_in": 10,
            "tokens_out": 20,
            "tokens_reasoning": 0,
            "cut": false
        }]
    });
    let debit = ctx.debit("0", 1, vec![thought.clone()]).await?;
    let logs = event_logs(&debit);
    debit.into_result()?;
    assert_eq!(logs.len(), 1);
    let receipt: Value = serde_json::from_str(&logs[0])?;
    assert_eq!(receipt["standard"], "nearling");
    assert_eq!(receipt["event"], "receipt");
    assert_eq!(receipt["data"]["token_id"], "0");
    assert_eq!(receipt["data"]["debit_id"], 1);
    assert_eq!(receipt["data"]["model"], thought["model"]);
    assert_eq!(receipt["data"]["price"], thought["price"]);
    assert_eq!(receipt["data"]["calls"], thought["calls"]);
    assert_eq!(ctx.pet_view("0").await?["last_debit_id"], 1);
    assert_eq!(ctx.storage_usage().await?, before_storage);
    Ok(())
}
