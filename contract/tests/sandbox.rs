mod common;

use common::*;
use near_sdk::borsh;
use nearling_contract::limits::MIN_FEED;
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

/// The dev account holds the layout of `add-pet` with pets in it: version-1 records and no `known`.
/// `migrate` takes it, with the pool, the counters and the pets as they were; a pet of version 1
/// reads with zero counters and is fed (so written) as version 2.
#[tokio::test]
async fn migrate_takes_the_add_pet_layout_of_a_deployed_contract() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.mint("alice.near", "Pixel", "I am curious.")
        .await?
        .into_result()?;
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

    // The state `add-pet` wrote is this one without the trailing `known` (a 4-byte length and
    // the prefix `k`).
    let pool_before = ctx.pool().await?;
    let state = ctx.read_state().await?;
    assert_eq!(&state[state.len() - 5..], &[1, 0, 0, 0, b'k']);
    ctx.worker
        .patch_state(ctx.contract.id(), b"STATE", &state[..state.len() - 5])
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
    assert!(!ctx.knows("0", "bob.near").await?);

    // The server named at `new` is still the one that may mint, and a meal on the old record
    // keeps the food it had.
    ctx.mint("carol.near", "Biscuit", "I am calm.")
        .await?
        .into_result()?;
    let bob = ctx.account("bob", 10).await?;
    ctx.feed_as(&bob, "0", MIN_FEED).await?.into_result()?;
    assert_eq!(
        ctx.pet_view("0").await?["given_food"],
        (5 + MIN_FEED).to_string()
    );
    assert!(ctx.knows("0", bob.id().as_str()).await?);

    // A second call finds `known` after the old layout and fails: the pool is never reset.
    let again = ctx
        .contract
        .call("migrate")
        .args_json(json!({}))
        .transact()
        .await?;
    assert_refused(&again, "Cannot deserialize the contract state");
    Ok(())
}
