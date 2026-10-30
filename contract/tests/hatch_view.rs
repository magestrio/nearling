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
    assert_eq!(bob["token_id"], "1");
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
