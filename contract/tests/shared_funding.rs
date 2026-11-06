mod common;

use common::*;
use near_workspaces::types::NearToken;
use nearling_contract::limits::{MAX_THOUGHT_PRICE, MIN_FEED, SNACK_AMOUNT};
use serde_json::{Value, json};

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async fn open(ctx: &Ctx, allowance: u128) -> anyhow::Result<()> {
    ctx.server
        .call(ctx.contract.id(), "shared_job_open")
        .args_json(
            json!({"token_id":"0", "job_hash":HASH, "allowance_yocto":allowance.to_string()}),
        )
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn feed(
    ctx: &Ctx,
    caller: &near_workspaces::Account,
    hash: Option<&str>,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(caller
        .call(ctx.contract.id(), "pet_feed")
        .args_json(json!({"token_id":"0", "job_hash":hash}))
        .deposit(NearToken::from_yoctonear(MIN_FEED))
        .transact()
        .await?)
}

async fn snack(
    ctx: &Ctx,
    feeder: &str,
    hash: Option<&str>,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(ctx
        .server
        .call(ctx.contract.id(), "pet_snack")
        .args_json(json!({"token_id":"0", "feeder":feeder, "kind":"friend", "job_hash":hash}))
        .transact()
        .await?)
}

fn amount(view: &Value, field: &str) -> u128 {
    view[field].as_str().unwrap().parse().unwrap()
}

// spec: add-pet-errands › Shared job funding bound contract › meal arrives after allowance is covered
// spec: add-pet-errands › Shared job funding bound contract › snack arrives after allowance is covered
#[tokio::test]
async fn funded_before_start_refuses_both_tags_without_food_or_limit_change() -> anyhow::Result<()>
{
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(0, 0).await?;
    open(&ctx, MAX_THOUGHT_PRICE).await?;
    for n in 1..=3 {
        snack(&ctx, &format!("friend{n}.near"), Some(HASH))
            .await?
            .into_result()?;
    }
    let before = ctx.pet_view("0").await?;
    assert_eq!(
        amount(&before["shared_job"], "linked_snack"),
        3 * SNACK_AMOUNT
    );
    let pool = ctx.pool().await?;
    let storage = ctx.storage_usage().await?;
    let bob = ctx.account("bob", 10).await?;
    let bob_before = ctx.balance_of(bob.id()).await?;
    let meal = feed(&ctx, &bob, Some(HASH)).await?;
    assert_refused(&meal, "job_funded");
    assert!(event_logs(&meal).is_empty());
    let loss = bob_before - ctx.balance_of(bob.id()).await?;
    assert!(
        loss < MIN_FEED / 10,
        "the full meal deposit returns; only gas can be lost"
    );
    let late = snack(&ctx, "friend4.near", Some(HASH)).await?;
    assert_refused(&late, "job_funded");
    assert!(event_logs(&late).is_empty());
    assert_eq!(ctx.pet_view("0").await?, before);
    assert_eq!(ctx.pool().await?, pool);
    assert_eq!(ctx.storage_usage().await?, storage);
    assert!(!ctx.knows("0", "friend4.near").await?);
    Ok(())
}

// spec: add-pet-errands › Shared job funding bound contract › meal arrives after allowance is covered
// spec: add-pet-errands › Shared job funding bound contract › snack arrives after allowance is covered
#[tokio::test]
async fn one_meal_covers_allowance_and_untagged_food_still_works() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(0, 0).await?;
    open(&ctx, MAX_THOUGHT_PRICE).await?;
    let bob = ctx.account("bob", 10).await?;
    let result = feed(&ctx, &bob, Some(HASH)).await?;
    let event: Value = serde_json::from_str(&event_logs(&result)[0])?;
    result.into_result()?;
    assert_eq!(event["event"], "feed");
    assert_eq!(event["data"]["job_hash"], HASH);
    assert_eq!(event["data"]["funding_index"], 0);
    assert_eq!(event["data"]["feeder"], bob.id().as_str());
    assert_eq!(
        amount(&ctx.pet_view("0").await?["shared_job"], "linked_near"),
        MIN_FEED
    );
    let late = snack(&ctx, "friend.near", Some(HASH)).await?;
    assert_refused(&late, "job_funded");
    let pool = ctx.pool().await?;
    feed(&ctx, &bob, None).await?.into_result()?;
    snack(&ctx, "friend.near", None).await?.into_result()?;
    let view = ctx.pet_view("0").await?;
    assert_eq!(amount(&view["shared_job"], "linked_near"), MIN_FEED);
    assert_eq!(amount(&view, "given_food"), 2 * MIN_FEED);
    assert_eq!(amount(&view, "project_food"), SNACK_AMOUNT);
    assert!(ctx.pool().await? < pool);
    Ok(())
}

// spec: add-pet-errands › Shared job funding bound contract › meal arrives after allowance is covered
// spec: add-pet-errands › Shared job funding bound contract › snack arrives after allowance is covered
#[tokio::test]
async fn owner_stale_hash_and_wrong_kind_refuse_before_moving_food() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let owner = ctx.account("alice", 10).await?;
    ctx.mint(owner.id().as_str(), "Pixel", "I am curious.")
        .await?
        .into_result()?;
    open(&ctx, MAX_THOUGHT_PRICE).await?;
    let bob = ctx.account("bob", 10).await?;
    let before = ctx.pet_view("0").await?;
    assert_refused(&feed(&ctx, &owner, Some(HASH)).await?, "owner_tag");
    assert_refused(&feed(&ctx, &bob, Some(OTHER)).await?, "wrong_job_hash");
    assert_refused(
        &snack(&ctx, owner.id().as_str(), Some(HASH)).await?,
        "owner_tag",
    );
    assert_refused(
        &snack(&ctx, "bob.near", Some(OTHER)).await?,
        "wrong_job_hash",
    );
    assert_eq!(ctx.pet_view("0").await?, before);
    Ok(())
}
