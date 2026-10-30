mod common;

use common::*;
use near_sdk::borsh;
use nearling_contract::InitContract;
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
        .args_json(json!({ "server_id": ctx.funder.id(), "treasury_id": ctx.funder.id() }))
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

/// The dev account holds the Init state `{ owner_id }`; `migrate` takes it into the game's layout.
#[tokio::test]
async fn migrate_takes_the_init_state_of_a_deployed_contract() -> anyhow::Result<()> {
    let wasm = wasm();
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let owner = root
        .create_subaccount("owner")
        .transact()
        .await?
        .into_result()?;
    let server = root
        .create_subaccount("server")
        .transact()
        .await?
        .into_result()?;
    let treasury = root
        .create_subaccount("treasury")
        .transact()
        .await?
        .into_result()?;
    let contract = worker.dev_deploy(wasm).await?;
    let init_state = borsh::to_vec(&InitContract {
        owner_id: owner.id().clone(),
    })?;
    worker
        .patch_state(contract.id(), b"STATE", &init_state)
        .await?;

    contract
        .call("migrate")
        .args_json(json!({ "server_id": server.id(), "treasury_id": treasury.id() }))
        .transact()
        .await?
        .into_result()?;
    let stored_owner: String = contract.view("owner_id").await?.json()?;
    assert_eq!(stored_owner, owner.id().to_string());
    let hatch: serde_json::Value = contract
        .view("hatch_view")
        .args_json(json!({ "account_id": "alice.near" }))
        .await?
        .json()?;
    assert_eq!(hatch["pool"], "0");
    assert_eq!(hatch["token_id"], serde_json::Value::Null);

    // The server named by `migrate` is the one that may mint.
    let funded = contract
        .as_account()
        .call(contract.id(), "pool_fund")
        .deposit(near_workspaces::types::NearToken::from_near(1))
        .transact()
        .await?;
    assert!(funded.is_success());
    let minted = server
        .call(contract.id(), "pet_mint")
        .args_json(
            json!({ "receiver": "alice.near", "name": "Pixel", "character": "I am curious." }),
        )
        .transact()
        .await?;
    assert!(minted.is_success(), "{:?}", minted.failures());
    Ok(())
}
