mod common;

use common::*;
use nearling_contract::limits::{EXPERIENCE_COUNT_BYTES, HIRE_FEE_MIN};
use serde_json::{Value, json};

async fn record(ctx: &Ctx, id: &str) -> anyhow::Result<Value> {
    Ok(ctx
        .contract
        .view("experience_view")
        .args_json(json!({"token_id": id}))
        .await?
        .json()?)
}

fn errand(price: u128) -> Value {
    let mut thought = thought_json(price);
    thought["completed_errand"] = json!(true);
    thought
}

// spec: add-pet-experience › Experience record contract › paid work accepted
#[tokio::test]
async fn accepted_debit_counts_each_paid_work_once_and_keeps_receipts() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(NEAR, 0).await?;
    ctx.mint("bob.near", "Nori", "I am calm.")
        .await?
        .into_result()?;
    let treasury_before = ctx.balance_of(ctx.treasury.id()).await?;
    let price = 300_000_000_000_000_000_000u128;
    let result = ctx
        .debit(
            "0",
            1,
            vec![
                errand(price),
                hired_json(price, "1", Some(("player", HIRE_FEE_MIN, false))),
            ],
        )
        .await?;
    result.into_result()?;
    assert_eq!(record(&ctx, "0").await?["completed_errands"], 1);
    assert_eq!(record(&ctx, "1").await?["paid_hires"], 1);
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await? - treasury_before,
        2 * price
    );
    let replay = ctx.debit("0", 1, vec![errand(price)]).await?;
    assert_refused(&replay, "bad_debit_id");
    assert_eq!(record(&ctx, "0").await?["completed_errands"], 1);
    Ok(())
}

// spec: add-pet-experience › Experience record contract › false work label from stolen server key
#[tokio::test]
async fn server_can_label_a_paid_plain_thought_but_not_a_worker_answer() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(NEAR, 0).await?;
    let accepted = ctx.debit("0", 1, vec![errand(1_000)]).await?;
    assert!(!accepted.is_failure());
    let receipt: Value = event_logs(&accepted)
        .iter()
        .map(|log| serde_json::from_str::<Value>(log).unwrap())
        .find(|event| event["event"] == "receipt")
        .unwrap();
    assert_eq!(receipt["data"]["completed_errand"], true);
    assert_eq!(record(&ctx, "0").await?["completed_errands"], 1);
    let mut invalid = errand(1_000);
    invalid["worker"] = json!("0");
    let refused = ctx.debit("0", 2, vec![invalid]).await?;
    assert_refused(&refused, "errand_with_worker");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(record(&ctx, "0").await?["completed_errands"], 1);
    Ok(())
}

// spec: add-pet-experience › Experience record contract › paid work accepted
#[tokio::test]
async fn zero_price_cannot_create_a_completed_errand_receipt_or_count() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(NEAR, 0).await?;
    let before = ctx.pet_view("0").await?;
    let refused = ctx.debit("0", 1, vec![errand(0)]).await?;
    assert_refused(&refused, "errand_without_payment");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(ctx.pet_view("0").await?, before);
    assert_eq!(record(&ctx, "0").await?["completed_errands"], 0);
    Ok(())
}

// spec: add-pet-experience › Experience record contract › storage pool cannot cover first count
#[tokio::test]
async fn first_count_stakes_exact_bytes_and_short_pool_rolls_back_debit() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(NEAR, 0).await?;
    let pool = ctx.pool().await?;
    let usage = ctx.storage_usage().await?;
    let treasury = ctx.balance_of(ctx.treasury.id()).await?;
    let ordinary = ctx.debit("0", 1, vec![thought_json(1_000)]).await?;
    let ordinary_gas = ordinary.outcomes()[1].gas_burnt.as_gas();
    ordinary.into_result()?;
    ctx.set_pool(0).await?;
    let before = ctx.pet_view("0").await?;
    let refused = ctx.debit("0", 2, vec![errand(1_000)]).await?;
    assert_refused(&refused, "pool_empty");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(ctx.pet_view("0").await?, before);
    assert_eq!(ctx.balance_of(ctx.treasury.id()).await? - treasury, 1_000);
    assert_eq!(record(&ctx, "0").await?["completed_errands"], 0);
    ctx.set_pool(pool).await?;
    let before_usage = ctx.storage_usage().await?;
    let counted = ctx.debit("0", 2, vec![errand(1_000)]).await?;
    let counted_gas = counted.outcomes()[1].gas_burnt.as_gas();
    counted.into_result()?;
    let first_bytes = before_usage.abs_diff(ctx.storage_usage().await?);
    let pool_cost = pool - ctx.pool().await?;
    assert_eq!(
        pool_cost,
        u128::from(EXPERIENCE_COUNT_BYTES) * 10_000_000_000_000_000_000
    );
    assert_eq!(first_bytes, EXPERIENCE_COUNT_BYTES);
    println!(
        "experience first key {first_bytes} bytes; ordinary debit {ordinary_gas} gas; counted debit {counted_gas} gas; initial storage {usage}"
    );
    Ok(())
}

// spec: add-pet-experience › Experience view contract › public read
// spec: add-pet-experience › Experience view contract › unknown pet
#[tokio::test]
async fn public_view_has_zeroes_for_existing_pet_and_none_for_unknown() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(NEAR, 0).await?;
    let view = record(&ctx, "0").await?;
    assert_eq!(view["token_id"], "0");
    assert_eq!(view["paid_hires"], 0);
    assert_eq!(view["completed_errands"], 0);
    assert!(view["counted_since"].as_u64().unwrap() > 0);
    assert!(record(&ctx, "missing").await?.is_null());
    Ok(())
}

// spec: add-pet-experience › Experience view contract › public read
#[tokio::test]
async fn migration_preserves_old_pets_showcase_and_pool_and_starts_new_date() -> anyhow::Result<()>
{
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(NEAR, 0).await?;
    ctx.debit("0", 1, vec![thought_json(1_000)])
        .await?
        .into_result()?;
    let pet = ctx.pet_view("0").await?;
    let showcase: Value = ctx.contract.view("showcase_view").await?.json()?;
    let pool = ctx.pool().await?;
    ctx.restore_v8_state().await?;
    let old_size = ctx.read_state().await?.len();
    let outsider = ctx
        .funder
        .call(ctx.contract.id(), "migrate_experience")
        .transact()
        .await?;
    assert_refused(&outsider, "private");
    ctx.contract
        .call("migrate_experience")
        .transact()
        .await?
        .into_result()?;
    let current = ctx.read_state().await?;
    let _: nearling_contract::Contract = near_sdk::borsh::from_slice(&current)?;
    assert!(current.len() > old_size + 18);
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(
        ctx.contract.view("showcase_view").await?.json::<Value>()?,
        showcase
    );
    assert_eq!(ctx.pool().await?, pool);
    assert_eq!(record(&ctx, "0").await?["completed_errands"], 0);
    assert!(
        record(&ctx, "0").await?["counted_since"].as_u64().unwrap()
            >= showcase["counted_since"].as_u64().unwrap()
    );
    assert!(
        ctx.contract
            .call("migrate_experience")
            .transact()
            .await?
            .is_failure()
    );
    Ok(())
}
