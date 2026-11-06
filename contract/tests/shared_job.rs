mod common;

use common::*;
use near_crypto::{KeyType as CryptoKeyType, SecretKey as CryptoSecretKey, Signature};
use near_sdk::borsh;
use near_workspaces::types::NearToken;
use near_workspaces::types::{KeyType, SecretKey};
use nearling_contract::events::hex;
use nearling_contract::limits::{MAX_THOUGHT_PRICE, SHARED_JOB_MAX_BYTES};
use nearling_contract::shared_job::{
    FundingKind, SharedFunding, SharedJob, SharedJobState, close_intent_message,
};
use serde_json::{Value, json};

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BYTE_COST: u128 = 10_000_000_000_000_000_000;

async fn open(
    ctx: &Ctx,
    token_id: &str,
    hash: &str,
    allowance: u128,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(ctx
        .server
        .call(ctx.contract.id(), "shared_job_open")
        .args_json(json!({"token_id": token_id, "job_hash": hash, "allowance_yocto": allowance.to_string()}))
        .transact()
        .await?)
}

async fn tagged_meal(ctx: &Ctx, hash: &str) -> anyhow::Result<()> {
    let bob = ctx.account("bob", 10).await?;
    bob.call(ctx.contract.id(), "pet_feed")
        .args_json(json!({"token_id":"0", "job_hash":hash}))
        .deposit(NearToken::from_yoctonear(
            nearling_contract::limits::MIN_FEED,
        ))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn start(
    ctx: &Ctx,
    hash: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(ctx
        .server
        .call(ctx.contract.id(), "shared_job_start")
        .args_json(json!({"token_id":"0", "job_hash":hash}))
        .transact()
        .await?)
}

fn approval(ctx: &Ctx, key: &CryptoSecretKey, hash: &str) -> Value {
    let hash_bytes = nearling_contract::events::unhex32(hash).unwrap();
    let message = close_intent_message(ctx.contract.id().as_str(), "0", &hash_bytes);
    let digest = near_sdk::env::sha256(message.as_bytes());
    let signature = match key.sign(&digest) {
        Signature::ED25519(sig) => sig.to_bytes(),
        _ => unreachable!(),
    };
    json!({"public_key":hex(key.public_key().key_data()), "signature":hex(&signature)})
}

async fn close(
    ctx: &Ctx,
    hash: &str,
    owner_approval: Value,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(ctx
        .server
        .call(ctx.contract.id(), "shared_job_close")
        .args_json(json!({"token_id":"0", "job_hash":hash, "owner_approval":owner_approval}))
        .transact()
        .await?)
}

// spec: add-pet-errands › Shared job close contract › wrong closer refused
// spec: add-pet-errands › Shared job close contract › stale close refused
// spec: add-pet-errands › Shared job close contract › premature server close refused
// spec: add-pet-errands › Shared job close contract › invalid owner approval refused
// spec: add-pet-errands › Shared job close contract › owner closes a waiting job
#[tokio::test]
async fn waiting_job_needs_current_owner_approval_and_releases_food_once() -> anyhow::Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let ctx = setup(BIG_POOL).await?;
    let owner = CryptoSecretKey::from_seed(CryptoKeyType::ED25519, "shared-owner");
    let owner_id = hex(owner.public_key().key_data());
    ctx.mint(&owner_id, "Pixel", "Curious forever")
        .await?
        .into_result()?;
    open(&ctx, "0", HASH, MAX_THOUGHT_PRICE)
        .await?
        .into_result()?;
    tagged_meal(&ctx, HASH).await?;
    let pool_before_close = ctx.pool().await?;
    let before = ctx.pet_view("0").await?;
    let missing = close(&ctx, HASH, Value::Null).await?;
    assert_refused(&missing, "owner_approval_required");
    assert_refused(
        &close(&ctx, OTHER_HASH, Value::Null).await?,
        "wrong_job_hash",
    );
    let stranger = CryptoSecretKey::from_seed(CryptoKeyType::ED25519, "shared-stranger");
    assert_refused(
        &close(&ctx, HASH, approval(&ctx, &stranger, HASH)).await?,
        "not_current_owner",
    );
    let mut forged = approval(&ctx, &owner, HASH);
    forged["signature"] = json!("00".repeat(64));
    assert_refused(&close(&ctx, HASH, forged).await?, "bad_owner_approval");
    let wrong = ctx
        .funder
        .call(ctx.contract.id(), "shared_job_close")
        .args_json(
            json!({"token_id":"0", "job_hash":HASH, "owner_approval":approval(&ctx, &owner, HASH)}),
        )
        .transact()
        .await?;
    assert_refused(&wrong, "not_server");
    let with_deposit = ctx
        .server
        .call(ctx.contract.id(), "shared_job_close")
        .args_json(
            json!({"token_id":"0", "job_hash":HASH, "owner_approval":approval(&ctx, &owner, HASH)}),
        )
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(with_deposit.is_failure());
    assert_eq!(ctx.pet_view("0").await?, before);
    let result = close(&ctx, HASH, approval(&ctx, &owner, HASH)).await?;
    let gas = result.outcomes()[1].gas_burnt.as_gas();
    let logs = event_logs(&result);
    result.into_result()?;
    assert_eq!(logs.len(), 1);
    let event: Value = serde_json::from_str(&logs[0])?;
    assert_eq!(event["event"], "shared_job_close");
    assert_eq!(
        event["data"]["linked_near_released"],
        nearling_contract::limits::MIN_FEED.to_string()
    );
    let after = ctx.pet_view("0").await?;
    assert!(after["shared_job"].is_null());
    assert_eq!(after["given_food"], before["given_food"]);
    assert_eq!(
        ctx.pool().await?,
        pool_before_close + u128::from(SHARED_JOB_MAX_BYTES) * BYTE_COST
    );
    assert_refused(
        &close(&ctx, HASH, approval(&ctx, &owner, HASH)).await?,
        "no_shared_job",
    );
    open(&ctx, "0", OTHER_HASH, MAX_THOUGHT_PRICE)
        .await?
        .into_result()?;
    assert_refused(
        &close(&ctx, OTHER_HASH, approval(&ctx, &owner, HASH)).await?,
        "bad_owner_approval",
    );
    eprintln!("shared_job_close waiting gas burnt: {gas}");
    Ok(())
}

// spec: add-pet-errands › Shared job close contract › owner closes a failed run
// spec: add-pet-errands › Shared job close contract › retained approval after memory deletion
// spec: add-pet-errands › Shared job close contract › new owner releases a cleared old job
#[tokio::test]
async fn unpaid_running_job_survives_erasure_and_needs_new_owner_after_gift() -> anyhow::Result<()>
{
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let ctx = setup(BIG_POOL).await?;
    let old = CryptoSecretKey::from_seed(CryptoKeyType::ED25519, "old-shared-owner");
    let new = CryptoSecretKey::from_seed(CryptoKeyType::ED25519, "new-shared-owner");
    let old_id = hex(old.public_key().key_data());
    let new_id = hex(new.public_key().key_data());
    ctx.mint(&old_id, "Pixel", "Curious forever")
        .await?
        .into_result()?;
    open(&ctx, "0", HASH, MAX_THOUGHT_PRICE)
        .await?
        .into_result()?;
    tagged_meal(&ctx, HASH).await?;
    start(&ctx, HASH).await?.into_result()?;
    let old_approval = approval(&ctx, &old, HASH);
    // The browser has retained only this approval; no words are needed to close.
    let old_account = near_workspaces::Account::from_secret_key(
        old_id.parse()?,
        SecretKey::from_seed(KeyType::ED25519, "old-shared-owner"),
        &ctx.worker,
    );
    ctx.funder
        .transfer_near(old_account.id(), NearToken::from_near(1))
        .await?
        .into_result()?;
    old_account
        .call(ctx.contract.id(), "nft_transfer")
        .args_json(json!({"receiver_id":new_id, "token_id":"0", "approval_id":null, "memo":null}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_refused(&close(&ctx, HASH, old_approval).await?, "not_current_owner");
    let before = ctx.pet_view("0").await?;
    let result = close(&ctx, HASH, approval(&ctx, &new, HASH)).await?;
    result.into_result()?;
    let after = ctx.pet_view("0").await?;
    assert!(after["shared_job"].is_null());
    assert_eq!(after["given_food"], before["given_food"]);
    Ok(())
}

// spec: add-pet-errands › Shared job close contract › owner closes a failed run
// spec: add-pet-errands › Shared job close contract › retained approval after memory deletion
#[tokio::test]
async fn current_owner_can_close_unpaid_running_job_without_its_words() -> anyhow::Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let ctx = setup(BIG_POOL).await?;
    let owner = CryptoSecretKey::from_seed(CryptoKeyType::ED25519, "unpaid-shared-owner");
    ctx.mint(
        &hex(owner.public_key().key_data()),
        "Pixel",
        "Curious forever",
    )
    .await?
    .into_result()?;
    open(&ctx, "0", HASH, MAX_THOUGHT_PRICE)
        .await?
        .into_result()?;
    tagged_meal(&ctx, HASH).await?;
    start(&ctx, HASH).await?.into_result()?;
    let retained_approval = approval(&ctx, &owner, HASH);
    let before = ctx.pet_view("0").await?;
    close(&ctx, HASH, retained_approval).await?.into_result()?;
    let after = ctx.pet_view("0").await?;
    assert!(after["shared_job"].is_null());
    assert_eq!(after["given_food"], before["given_food"]);
    let mut late = thought_json(1_000);
    late["job_hash"] = json!(HASH);
    assert_refused(&ctx.debit("0", 1, vec![late]).await?, "no_shared_job");
    Ok(())
}

// spec: add-pet-errands › Shared job close contract › close releases unused food
// spec: add-pet-errands › Shared job close contract › close releases unused food × late debit
#[tokio::test]
async fn settled_job_closes_without_approval_and_cannot_replay_debit() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(0, 0).await?;
    open(&ctx, "0", HASH, MAX_THOUGHT_PRICE)
        .await?
        .into_result()?;
    tagged_meal(&ctx, HASH).await?;
    start(&ctx, HASH).await?.into_result()?;
    let mut paid = thought_json(1_000);
    paid["job_hash"] = json!(HASH);
    ctx.debit("0", 1, vec![paid]).await?.into_result()?;
    let before = ctx.pet_view("0").await?;
    assert_eq!(before["shared_job"]["state"], "settled");
    let pool_before = ctx.pool().await?;
    let result = close(&ctx, HASH, Value::Null).await?;
    let gas = result.outcomes()[1].gas_burnt.as_gas();
    result.into_result()?;
    let after = ctx.pet_view("0").await?;
    assert!(after["shared_job"].is_null());
    assert_eq!(after["given_food"], before["given_food"]);
    assert_eq!(
        ctx.pool().await?,
        pool_before + u128::from(SHARED_JOB_MAX_BYTES) * BYTE_COST
    );
    let mut replay = thought_json(1_000);
    replay["job_hash"] = json!(HASH);
    assert_refused(&ctx.debit("0", 2, vec![replay]).await?, "no_shared_job");
    eprintln!("shared_job_close settled gas burnt: {gas}");
    Ok(())
}

// spec: add-pet-errands › Shared job close contract › close releases unused food × gas and event bound
// spec: add-gift › Pet transfer contract › running shared job on transfer × gas and event bound
#[tokio::test]
async fn measured_shared_lifecycle_stays_within_gas_storage_and_log_limits() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let alice = ctx.account("alice", 20).await?;
    let bob = ctx.account("bob", 20).await?;
    ctx.mint(alice.id().as_str(), "Pixel", "Curious forever")
        .await?
        .into_result()?;
    let storage_before = ctx.storage_usage().await?;
    let pool_before = ctx.pool().await?;
    let mut samples: Vec<(&str, u64, usize)> = Vec::new();
    let opened = open(&ctx, "0", HASH, MAX_THOUGHT_PRICE).await?;
    samples.push((
        "open",
        opened.outcomes()[1].gas_burnt.as_gas(),
        event_logs(&opened).iter().map(|s| s.len() + 11).sum(),
    ));
    opened.into_result()?;
    for n in 0..3 {
        let feeder = format!("{n}{}", "a".repeat(63));
        let fed = ctx
            .server
            .call(ctx.contract.id(), "pet_snack")
            .args_json(json!({"token_id":"0", "feeder":feeder, "kind":"friend", "job_hash":HASH}))
            .transact()
            .await?;
        samples.push((
            "snack",
            fed.outcomes()[1].gas_burnt.as_gas(),
            event_logs(&fed).iter().map(|s| s.len() + 11).sum(),
        ));
        fed.into_result()?;
    }
    let used = ctx.storage_usage().await? - storage_before;
    assert!(used <= SHARED_JOB_MAX_BYTES + 3 * nearling_contract::limits::KNOWN_RECORD_BYTES);
    let started = start(&ctx, HASH).await?;
    samples.push((
        "start",
        started.outcomes()[1].gas_burnt.as_gas(),
        event_logs(&started).iter().map(|s| s.len() + 11).sum(),
    ));
    started.into_result()?;
    let transferred = alice
        .call(ctx.contract.id(), "nft_transfer")
        .args_json(json!({"receiver_id":bob.id(), "token_id":"0", "approval_id":null, "memo":null}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    samples.push((
        "transfer",
        transferred.outcomes()[1].gas_burnt.as_gas(),
        event_logs(&transferred).iter().map(|s| s.len() + 11).sum(),
    ));
    transferred.into_result()?;
    let mut thought = thought_json(MAX_THOUGHT_PRICE);
    thought["model"] = json!("m".repeat(64));
    let mut longest_call = call_json();
    longest_call["signer"] = json!(format!("0x{}", "d".repeat(64)));
    longest_call["tokens_in"] = json!(u32::MAX);
    longest_call["tokens_out"] = json!(u32::MAX);
    longest_call["tokens_reasoning"] = json!(u32::MAX);
    thought["calls"] = json!(vec![longest_call; 4]);
    thought["job_hash"] = json!(HASH);
    let debited = ctx.debit("0", 1, vec![thought]).await?;
    samples.push((
        "debit",
        debited.outcomes()[1].gas_burnt.as_gas(),
        event_logs(&debited).iter().map(|s| s.len() + 11).sum(),
    ));
    debited.into_result()?;
    let closed = close(&ctx, HASH, Value::Null).await?;
    samples.push((
        "close",
        closed.outcomes()[1].gas_burnt.as_gas(),
        event_logs(&closed).iter().map(|s| s.len() + 11).sum(),
    ));
    closed.into_result()?;
    open(&ctx, "0", OTHER_HASH, MAX_THOUGHT_PRICE)
        .await?
        .into_result()?;
    let meal = ctx
        .funder
        .call(ctx.contract.id(), "pet_feed")
        .args_json(json!({"token_id":"0", "job_hash":OTHER_HASH}))
        .deposit(NearToken::from_yoctonear(
            nearling_contract::limits::MIN_FEED,
        ))
        .transact()
        .await?;
    samples.push((
        "feed",
        meal.outcomes()[1].gas_burnt.as_gas(),
        event_logs(&meal).iter().map(|s| s.len() + 11).sum(),
    ));
    meal.into_result()?;
    for (step, gas, bytes) in &samples {
        assert!(*gas < 30_000_000_000_000, "{step} gas");
        assert!(*bytes < 16_384, "{step} log bytes");
        eprintln!("shared lifecycle {step}: gas={gas}, event_bytes={bytes}");
    }
    eprintln!(
        "shared lifecycle funding storage growth={used}, pool before={pool_before}, pool after={}",
        ctx.pool().await?
    );
    Ok(())
}

// spec: add-pet-errands › Shared job start contract › funded job starts
// spec: add-pet-errands › Shared job start contract › wrong starter refused
// spec: add-pet-errands › Shared job start contract › unfunded job refused
// spec: add-pet-errands › Shared job start contract › second start refused
// spec: add-pet-errands › Shared job start contract › wrong start hash refused
#[tokio::test]
async fn only_server_starts_exactly_once_after_full_linked_funding() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(0, 0).await?;
    open(&ctx, "0", HASH, MAX_THOUGHT_PRICE)
        .await?
        .into_result()?;
    let before = ctx.pet_view("0").await?;
    assert_refused(&start(&ctx, HASH).await?, "job_unfunded");
    assert_refused(&start(&ctx, OTHER_HASH).await?, "wrong_job_hash");
    let wrong = ctx
        .funder
        .call(ctx.contract.id(), "shared_job_start")
        .args_json(json!({"token_id":"0", "job_hash":HASH}))
        .transact()
        .await?;
    assert_refused(&wrong, "not_server");
    assert_eq!(ctx.pet_view("0").await?, before);
    tagged_meal(&ctx, HASH).await?;
    let funded = ctx.pet_view("0").await?;
    let started = start(&ctx, HASH).await?;
    let gas = started.outcomes()[1].gas_burnt.as_gas();
    let logs = event_logs(&started);
    started.into_result()?;
    assert_eq!(logs.len(), 1);
    let event: Value = serde_json::from_str(&logs[0])?;
    assert_eq!(event["event"], "shared_job_start");
    assert_eq!(event["data"]["job_hash"], HASH);
    assert_eq!(event["data"]["state"], "running");
    let running = ctx.pet_view("0").await?;
    assert_eq!(running["shared_job"]["state"], "running");
    assert_eq!(running["given_food"], funded["given_food"]);
    let late_meal = ctx
        .funder
        .call(ctx.contract.id(), "pet_feed")
        .args_json(json!({"token_id":"0", "job_hash":HASH}))
        .deposit(NearToken::from_yoctonear(
            nearling_contract::limits::MIN_FEED,
        ))
        .transact()
        .await?;
    assert_refused(&late_meal, "job_not_funding");
    let late_snack = ctx
        .server
        .call(ctx.contract.id(), "pet_snack")
        .args_json(
            json!({"token_id":"0", "feeder":"friend.near", "kind":"friend", "job_hash":HASH}),
        )
        .transact()
        .await?;
    assert_refused(&late_snack, "job_not_funding");
    let with_deposit = ctx
        .server
        .call(ctx.contract.id(), "shared_job_start")
        .args_json(json!({"token_id":"0", "job_hash":HASH}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(with_deposit.is_failure());
    assert_refused(&start(&ctx, HASH).await?, "job_not_funding");
    assert_eq!(ctx.pet_view("0").await?, running);
    println!("shared_job_start gas burnt: {gas}");
    Ok(())
}

// spec: add-pet-errands › Shared job open contract › open a job
#[tokio::test]
async fn opens_one_public_bounded_job_without_moving_food() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(2_000, 3_000).await?;
    let before = ctx.pet_view("0").await?;
    let pool_before = ctx.pool().await?;
    let balance_before = ctx.contract_balance().await?;
    let storage_before = ctx.storage_usage().await?;
    let result = open(&ctx, "0", HASH, MAX_THOUGHT_PRICE).await?;
    let gas = result.outcomes()[1].gas_burnt.as_gas();
    let logs = event_logs(&result);
    result.into_result()?;
    assert_eq!(logs.len(), 1);
    let event: Value = serde_json::from_str(&logs[0])?;
    assert_eq!(event["standard"], "nearling");
    assert_eq!(event["event"], "shared_job_open");
    assert_eq!(event["data"]["token_id"], "0");
    assert_eq!(event["data"]["job_hash"], HASH);
    assert_eq!(event["data"]["allowance"], MAX_THOUGHT_PRICE.to_string());
    assert_eq!(event["data"]["state"], "funding");
    let after = ctx.pet_view("0").await?;
    assert_eq!(after["project_food"], before["project_food"]);
    assert_eq!(after["given_food"], before["given_food"]);
    assert_eq!(after["shared_job"]["hash"], HASH);
    assert_eq!(
        after["shared_job"]["allowance"],
        MAX_THOUGHT_PRICE.to_string()
    );
    assert_eq!(after["shared_job"]["linked_near"], "0");
    assert_eq!(after["shared_job"]["linked_snack"], "0");
    assert_eq!(
        ctx.pool().await?,
        pool_before - u128::from(SHARED_JOB_MAX_BYTES) * BYTE_COST
    );
    assert_eq!(ctx.contract_balance().await?, balance_before);
    assert_eq!(ctx.storage_usage().await? - storage_before, 131);
    println!(
        "shared_job_open gas burnt: {gas}; initial record: 131 bytes; reserved max: {SHARED_JOB_MAX_BYTES} bytes"
    );
    Ok(())
}

// spec: add-pet-errands › Shared job open contract › second job refused
// spec: add-pet-errands › Shared job open contract › wrong opener refused
// spec: add-pet-errands › Shared job open contract › unknown pet refused
// spec: add-pet-errands › Shared job open contract › reserve storage unavailable
// spec: add-pet-errands › Shared job open contract › allowance above thought cap
// spec: add-pet-errands › Shared job open contract › zero allowance refused
#[tokio::test]
async fn refuses_other_openers_and_invalid_or_unfunded_jobs_without_a_write() -> anyhow::Result<()>
{
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(1_000, 2_000).await?;
    let before = ctx.pet_view("0").await?;
    let storage = ctx.storage_usage().await?;
    let pool = ctx.pool().await?;
    let wrong = ctx.funder.call(ctx.contract.id(), "shared_job_open")
        .args_json(json!({"token_id":"0", "job_hash":HASH, "allowance_yocto":MAX_THOUGHT_PRICE.to_string()}))
        .transact().await?;
    assert_refused(&wrong, "not_server");
    assert_refused(&open(&ctx, "404", HASH, MAX_THOUGHT_PRICE).await?, "no_pet");
    assert_refused(&open(&ctx, "0", HASH, 0).await?, "zero_allowance");
    assert_refused(
        &open(&ctx, "0", HASH, MAX_THOUGHT_PRICE + 1).await?,
        "allowance_over_cap",
    );
    assert_eq!(ctx.pet_view("0").await?, before);
    assert_eq!(ctx.storage_usage().await?, storage);
    assert_eq!(ctx.pool().await?, pool);
    ctx.set_pool(0).await?;
    let pool_empty = open(&ctx, "0", HASH, MAX_THOUGHT_PRICE).await?;
    assert_refused(&pool_empty, "pool_empty");
    assert_eq!(ctx.pet_view("0").await?, before);
    assert_eq!(ctx.storage_usage().await?, storage);
    ctx.set_pool(pool).await?;
    open(&ctx, "0", HASH, MAX_THOUGHT_PRICE)
        .await?
        .into_result()?;
    let active = ctx.pet_view("0").await?;
    assert_refused(
        &open(&ctx, "0", OTHER_HASH, MAX_THOUGHT_PRICE).await?,
        "shared_job_active",
    );
    assert_eq!(ctx.pet_view("0").await?, active);
    Ok(())
}

#[tokio::test]
async fn opening_takes_no_attached_deposit() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(0, 0).await?;
    let extra = ctx
        .server
        .call(ctx.contract.id(), "shared_job_open")
        .args_json(json!({"token_id":"0", "job_hash": HASH, "allowance_yocto":"1"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(extra.is_failure());
    assert!(ctx.pet_view("0").await?["shared_job"].is_null());
    Ok(())
}

#[test]
fn max_record_serialization_fits_reserved_stake() {
    let feeder: near_sdk::AccountId = "a".repeat(64).parse().unwrap();
    let job = SharedJob {
        hash: [7; 32],
        allowance: MAX_THOUGHT_PRICE,
        state: SharedJobState::Settled,
        linked_near: 0,
        linked_snack: 0,
        funding: (0..3)
            .map(|_| SharedFunding {
                feeder: feeder.clone(),
                kind: FundingKind::Snack,
                amount: 1,
                spent: 1,
            })
            .collect(),
    };
    let key_bytes = 1 + borsh::to_vec(&"18446744073709551615".to_string())
        .unwrap()
        .len();
    let value_bytes = borsh::to_vec(&job).unwrap().len();
    assert_eq!(key_bytes, 25);
    assert_eq!(value_bytes, 388);
    assert_eq!(key_bytes + value_bytes + 40, SHARED_JOB_MAX_BYTES as usize);
}

#[tokio::test]
async fn v7_migration_keeps_pets_and_showcase_totals() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(NEAR, 3_000).await?;
    ctx.debit("0", 1, vec![thought_json(1_000)])
        .await?
        .into_result()?;
    let pet = ctx.pet_view("0").await?;
    let showcase: Value = ctx.contract.view("showcase_view").await?.json()?;
    let pool = ctx.pool().await?;
    ctx.restore_v7_state().await?;
    let old_bytes = ctx.read_state().await?.len();
    let outsider = ctx
        .funder
        .call(ctx.contract.id(), "migrate_shared_jobs")
        .transact()
        .await?;
    assert_refused(&outsider, "private");
    ctx.contract
        .call("migrate_shared_jobs")
        .transact()
        .await?
        .into_result()?;
    assert_eq!(ctx.read_state().await?.len(), old_bytes + 5);
    assert_eq!(ctx.pet_view("0").await?, pet);
    let after: Value = ctx.contract.view("showcase_view").await?.json()?;
    assert_eq!(after, showcase);
    assert_eq!(ctx.pool().await?, pool);
    let again = ctx.contract.call("migrate_shared_jobs").transact().await?;
    assert!(again.is_failure());
    Ok(())
}
