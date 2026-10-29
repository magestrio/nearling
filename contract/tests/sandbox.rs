use near_workspaces::types::NearToken;
use serde_json::json;

/// Builds the wasm from the crate as it is now, deploys it to a sandbox account, initializes it
/// and answers one view call. The Init proof that the toolchain pair (near-sdk, near-workspaces)
/// works end to end.
#[tokio::test]
async fn deploys_initializes_and_answers_a_view_call() -> anyhow::Result<()> {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let wasm = std::fs::read(wasm_path)?;

    let worker = near_workspaces::sandbox().await?;
    let owner = worker
        .root_account()?
        .create_subaccount("owner")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    let contract = worker.dev_deploy(&wasm).await?;

    contract
        .call("new")
        .args_json(json!({ "owner_id": owner.id() }))
        .transact()
        .await?
        .into_result()?;

    let version: String = contract.view("version").await?.json()?;
    assert_eq!(version, "0.1.0");
    let stored_owner: String = contract.view("owner_id").await?.json()?;
    assert_eq!(stored_owner, owner.id().to_string());
    Ok(())
}
