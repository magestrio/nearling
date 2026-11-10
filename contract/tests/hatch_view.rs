mod common;

use common::*;
use serde_json::Value;

const CHARACTER: &str = "I'm calm and unhurried.";

// spec: add-pet › Hatch view contract › аккаунт рождал питомца
// The case "уже подарен" is the unit test `hatch_view_still_gives_the_token_of_a_given_pet` in
// `src/lib.rs`: `nft_transfer` is not exposed here, so the move is the standard's internal one.
#[tokio::test]
async fn hatch_view_gives_the_token_of_the_account_that_hatched() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;

    // Before a birth: no token, an empty counter, the pool as funded.
    let empty = ctx.hatch_view("alice.near").await?;
    assert_eq!(empty["owned_count"], "0");
    assert_eq!(empty["token_id"], Value::Null);
    assert_eq!(empty["born_today"], 0);
    assert_eq!(empty["pool"], BIG_POOL.to_string());

    ctx.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    ctx.mint("bob.near", "Biscuit", CHARACTER)
        .await?
        .into_result()?;

    // A view call: it records nothing and the reader pays no gas.
    let reader_before = ctx.balance_of(ctx.funder.id()).await?;
    let state_before = ctx.snapshot("alice.near").await?;
    let alice = ctx.hatch_view("alice.near").await?;
    let bob = ctx.hatch_view("bob.near").await?;
    assert_eq!(alice["token_id"], "0");
    assert_eq!(alice["owned_count"], "1");
    assert_eq!(bob["token_id"], "1");
    assert_eq!(bob["owned_count"], "1");
    assert_eq!(ctx.balance_of(ctx.funder.id()).await?, reader_before);
    assert_eq!(ctx.snapshot("alice.near").await?, state_before);

    // The UTC day, the births in it and the pool after two births.
    let now_day = ctx.block_timestamp().await? / 86_400_000_000_000;
    assert_eq!(alice["day"], now_day);
    assert_eq!(alice["born_today"], 2);
    let pool: u128 = alice["pool"].as_str().unwrap().parse()?;
    assert_eq!(pool, ctx.pool().await?);
    assert!(pool < BIG_POOL);

    // An account that never hatched still has no token.
    assert_eq!(ctx.hatch_view("carol.near").await?["token_id"], Value::Null);
    Ok(())
}

// spec: add-hatch-again › Repeat hatch view contract › former owner views hatch
// spec: add-hatch-again › Repeat hatch view contract › account owns a gifted pet
#[tokio::test]
async fn hatch_view_separates_latest_birth_from_current_ownership() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let alice = ctx.account("alice", 20).await?;
    let bob = ctx.account("bob", 20).await?;
    ctx.mint(alice.id().as_str(), "Pixel", CHARACTER)
        .await?
        .into_result()?;

    alice
        .call(ctx.contract.id(), "nft_transfer")
        .args_json(serde_json::json!({
            "receiver_id": bob.id(),
            "token_id": "0",
        }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    let state_before = ctx.snapshot(alice.id().as_str()).await?;
    let alice_view = ctx.hatch_view(alice.id().as_str()).await?;
    let bob_view = ctx.hatch_view(bob.id().as_str()).await?;
    assert_eq!(alice_view["owned_count"], "0");
    assert_eq!(alice_view["token_id"], "0");
    assert_eq!(bob_view["owned_count"], "1");
    assert_eq!(bob_view["token_id"], Value::Null);
    assert_eq!(ctx.snapshot(alice.id().as_str()).await?, state_before);
    Ok(())
}

// spec: add-hatch-again › Repeat hatch view contract › former owner views hatch
#[tokio::test]
async fn upgraded_code_reads_existing_birth_and_ownership_without_migration() -> anyhow::Result<()>
{
    let ctx = setup(BIG_POOL).await?;
    let alice = ctx.account("alice", 20).await?;
    let bob = ctx.account("bob", 20).await?;
    ctx.mint(alice.id().as_str(), "Pixel", CHARACTER)
        .await?
        .into_result()?;
    alice
        .call(ctx.contract.id(), "nft_transfer")
        .args_json(serde_json::json!({
            "receiver_id": bob.id(),
            "token_id": "0",
        }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let state_before = ctx.read_state().await?;
    ctx.contract
        .as_account()
        .deploy(wasm())
        .await?
        .into_result()?;
    assert_eq!(ctx.read_state().await?, state_before);
    let view = ctx.hatch_view(alice.id().as_str()).await?;
    assert_eq!(view["owned_count"], "0");
    assert_eq!(view["token_id"], "0");
    assert_eq!(ctx.hatch_view(bob.id().as_str()).await?["owned_count"], "1");
    Ok(())
}
