mod common;

use common::*;
use near_sdk::borsh;
use nearling_contract::limits::{HIRE_FEE_MIN, MIN_FEED};
use nearling_contract::pet::{PetV1, Stage, VersionedPet};
use serde_json::json;

/// Builds the wasm from the crate as it is now, deploys it to a sandbox account, initializes it
/// and answers one view call. The Init proof that the toolchain pair (near-sdk, near-workspaces)
/// works end to end, on the game's `new(owner_id, server_id, treasury_id)`.
#[tokio::test]
async fn deploys_initializes_and_answers_a_view_call() -> anyhow::Result<()> {
    let ctx = setup(0).await?;
    let version: String = ctx.contract.view("version").await?.json()?;
    assert_eq!(version, "0.1.0");
    let stored_owner: String = ctx.contract.view("owner_id").await?.json()?;
    assert_eq!(stored_owner, "owner.test.near");
    assert_eq!(ctx.pool().await?, 0);
    Ok(())
}

/// `new` and `migrate` are `#[private]`: only the contract account itself may call them, and
/// `new` runs once.
#[tokio::test]
async fn new_and_migrate_refuse_a_foreign_caller() -> anyhow::Result<()> {
    let ctx = setup(0).await?;
    let args = json!({
        "owner_id": ctx.funder.id(),
        "server_id": ctx.funder.id(),
        "treasury_id": ctx.funder.id(),
    });
    let foreign_new = ctx
        .funder
        .call(ctx.contract.id(), "new")
        .args_json(&args)
        .transact()
        .await?;
    assert_refused(&foreign_new, "private");
    let foreign_migrate = ctx
        .funder
        .call(ctx.contract.id(), "migrate")
        .args_json(json!({}))
        .transact()
        .await?;
    assert_refused(&foreign_migrate, "private");
    let foreign_reserve = ctx
        .funder
        .call(ctx.contract.id(), "migrate_generation_reserve")
        .args_json(json!({}))
        .transact()
        .await?;
    assert_refused(&foreign_reserve, "private");
    // `new` a second time, even by the contract itself, is refused: already initialized.
    let again = ctx.contract.call("new").args_json(&args).transact().await?;
    assert!(again.is_failure());
    // The server was not replaced.
    let wrong_server = ctx
        .mint_as(&ctx.funder, "alice.near", "Pixel", "I am curious.")
        .await?;
    assert_refused(&wrong_server, "not_server");
    Ok(())
}

/// The dev account holds the layout before `add-pet-work` with pets in it: version-1 records, an
/// acquaintance, and no work pairs or index. `migrate` takes it, with the pool, the counters, the
/// pets, `known` and the riddle fields as they were; a pet of version 1 reads with zero counters
/// and is fed (so written) as the current version; a hire then works on the migrated state.
// spec: add-daily-ritual › Streak contract › сутки засчитаны × the layout migrates
#[tokio::test]
async fn migrate_takes_the_previous_layout_of_a_deployed_contract() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.mint("alice.near", "Pixel", "I am curious.")
        .await?
        .into_result()?;
    // An acquaintance the old layout already held.
    let bob = ctx.account("bob", 10).await?;
    ctx.feed_as(&bob, "0", MIN_FEED).await?.into_result()?;
    assert!(ctx.knows("0", bob.id().as_str()).await?);
    let view = ctx.pet_view("0").await?;
    let amount = |k: &str| -> u128 { view[k].as_str().unwrap().parse().unwrap() };

    // The record `add-pet` wrote.
    let old_pet = PetV1 {
        name: "Pixel".into(),
        character: "I am curious.".into(),
        born_at: view["born_at"].as_u64().unwrap(),
        project_food: amount("project_food"),
        given_food: 5,
        debit_day: 0,
        debited_today: 0,
        last_debit_id: 0,
        stage: Stage::Baby,
        stage_day: view["stage_day"].as_u64().unwrap(),
        streak: 0,
        freezes: 1,
    };
    let mut key = b"p".to_vec();
    key.extend(borsh::to_vec(&"0".to_string())?);
    ctx.worker
        .patch_state(
            ctx.contract.id(),
            &key,
            &borsh::to_vec(&VersionedPet::V1(old_pet))?,
        )
        .await?;

    // The current layout ends in three original Showcase counters and 24 bytes of added totals.
    // Strip both the counters and map prefixes to recreate the exact V3 layout.
    let pool_before = ctx.pool().await?;
    let state = ctx.read_state().await?;
    let counters = borsh::to_vec(&(1u64, 0u64, 0u128))?;
    assert_eq!(
        &state[state.len() - 13..state.len() - 8],
        &[1, 0, 0, 0, b'c']
    );
    assert_eq!(
        &state[state.len() - 18..state.len() - 13],
        &[1, 0, 0, 0, b'j']
    );
    let old_end = state.len() - 18;
    let new_totals = &state[old_end - 24..old_end];
    assert_eq!(&new_totals[..16], &[0; 16]);
    assert_eq!(&state[old_end - 24 - counters.len()..old_end - 24], counters);
    let tail = old_end - 24 - counters.len() - 15;
    assert_eq!(&state[tail..tail + 15], &[1, 0, 0, 0, b'w', 1, 0, 0, 0, b'x', 1, 0, 0, 0, b'g']);
    ctx.worker
        .patch_state(ctx.contract.id(), b"STATE", &state[..tail])
        .await?;

    ctx.contract
        .call("migrate")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(ctx.pool().await?, pool_before);
    let stored_owner: String = ctx.contract.view("owner_id").await?.json()?;
    assert_eq!(stored_owner, "owner.test.near");
    assert_eq!(ctx.hatch_view("alice.near").await?["token_id"], "0");
    let migrated = ctx.pet_view("0").await?;
    assert_eq!(migrated["given_food"], "5");
    assert_eq!(migrated["friend_snacks"], 0);
    assert_eq!(migrated["friend_snack_day"], 0);
    assert_eq!(migrated["owner_snack_at"], "0");
    assert!(migrated["last_streak_day"].is_null());
    assert!(ctx.knows("0", bob.id().as_str()).await?, "known is kept");
    assert!(!ctx.knows("0", "dave.near").await?);
    let riddle = ctx.riddle_view(20_000).await?;
    assert!(riddle["hash"].is_null());
    assert_eq!(riddle["reserve"], "0");

    // The server named at `new` is still the one that may mint, and a meal on the old record
    // keeps the food it had.
    ctx.mint("carol.near", "Biscuit", "I am calm.")
        .await?
        .into_result()?;
    ctx.feed_as(&bob, "0", MIN_FEED).await?.into_result()?;
    assert_eq!(
        ctx.pet_view("0").await?["given_food"],
        (5 + MIN_FEED).to_string()
    );

    // The riddle methods still work on the migrated state.
    ctx.fund_riddles(10_000_000_000_000_000_000_000)
        .await?
        .into_result()?;
    ctx.riddle_commit(&"ab".repeat(32)).await?.into_result()?;

    // A hire works on it: the pairs and the index were added empty and take the first pair.
    ctx.set_pet("0", |pet| pet.given_food = 10 * HIRE_FEE_MIN)
        .await?;
    ctx.debit(
        "0",
        1,
        vec![hired_json(
            300_000_000_000_000_000_000,
            "1",
            Some(("player", HIRE_FEE_MIN, false)),
        )],
    )
    .await?
    .into_result()?;
    assert_eq!(ctx.pet_view("0").await?["work_known"], json!(["1"]));
    assert_eq!(ctx.pet_view("1").await?["work_known"], json!(["0"]));

    // A second call finds the work fields after the old layout and fails: the pool is never reset.
    let again = ctx
        .contract
        .call("migrate")
        .args_json(json!({}))
        .transact()
        .await?;
    assert_refused(&again, "Cannot deserialize the contract state");
    Ok(())
}
