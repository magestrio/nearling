mod common;

use common::*;
use near_sdk::borsh;
use nearling_contract::any_chain::{CreditState, PendingCredit};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, AccountDetailsPatch, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

async fn wrap_balance(wrap: &Contract, account: &str) -> anyhow::Result<u128> {
    let value: Value = wrap.view("ft_balance_of")
        .args_json(json!({"account_id": account})).await?.json()?;
    Ok(value.as_str().unwrap().parse()?)
}

fn feed_events(result: &ExecutionFinalResult) -> Vec<Value> {
    event_logs(result).iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value["event"] == "cross_chain_feed")
        .collect()
}

async fn send(intents: &Account, wrap: &Contract, receiver: &Contract, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
    Ok(intents.call(wrap.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": receiver.id(),
            "amount": amount.to_string(),
            "memo": null,
            "msg": json!({"token_id":"0", "route":"a".repeat(32), "kind":"quote"}).to_string(),
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(250))
        .transact().await?)
}

// spec: add-any-chain-feed › wNEAR unwrap contract › unwrap succeeded
// spec: add-any-chain-feed › wNEAR unwrap contract › unwrap failed
// spec: add-any-chain-feed › wNEAR unwrap contract › unauthorized callback
// spec: add-any-chain-feed › wNEAR unwrap contract › repeated callback
// spec: add-any-chain-feed › wNEAR recovery contract › retry failed route
// spec: add-any-chain-feed › wNEAR recovery contract › route already settled
// spec: add-any-chain-feed › wNEAR recovery contract › route not recoverable
#[tokio::test]
async fn failed_unwrap_is_retried_once_and_credits_the_full_amount() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.mint("alice.near", "Pixel", "Curious").await?.into_result()?;
    let mut build = cargo_near_build::BuildOpts::default();
    build.manifest_path = Some(cargo_near_build::camino::Utf8PathBuf::from("tests/fixtures/wnear/Cargo.toml"));
    let wasm = std::fs::read(cargo_near_build::build_with_cli(build)
        .map_err(|error| anyhow::anyhow!("wNEAR fixture build: {error:?}"))?)?;
    let wrap_id = "wrap.near".parse()?;
    let wrap_key = SecretKey::from_seed(KeyType::ED25519, "wrap.near");
    ctx.worker.patch(&wrap_id)
        .account(AccountDetailsPatch::default().balance(NearToken::from_near(10)))
        .access_key(wrap_key.public_key(), AccessKey::full_access())
        .code(&wasm).transact().await?;
    let wrap = Contract::from_secret_key(wrap_id, wrap_key, &ctx.worker);
    wrap.call("new").transact().await?.into_result()?;
    let intents_id = "intents.near".parse()?;
    let intents_key = SecretKey::from_seed(KeyType::ED25519, "intents.near");
    ctx.worker.patch(&intents_id)
        .account(AccountDetailsPatch::default().balance(NearToken::from_near(10)))
        .access_key(intents_key.public_key(), AccessKey::full_access())
        .transact().await?;
    let intents = Account::from_secret_key(intents_id, intents_key, &ctx.worker);
    for account in [intents.id().as_str(), ctx.contract.id().as_str()] {
        wrap.call("register").args_json(json!({"account_id": account}))
            .transact().await?.into_result()?;
    }
    intents.call(wrap.id(), "near_deposit")
        .deposit(NearToken::from_yoctonear(NEAR / 10))
        .transact().await?.into_result()?;

    let amount = NEAR / 100;
    let pool_before = ctx.pool().await?;
    let food_before: u128 = ctx.pet_view("0").await?["given_food"].as_str().unwrap().parse()?;
    wrap.call("set_withdraw_fails").args_json(json!({"fails":true}))
        .transact().await?.into_result()?;
    let failed = send(&intents, &wrap, &ctx.contract, amount).await?;
    failed.clone().into_result()?;
    assert!(feed_events(&failed).is_empty());
    assert_eq!(ctx.pet_view("0").await?["given_food"], food_before.to_string());
    assert_eq!(wrap_balance(&wrap, ctx.contract.id().as_str()).await?, amount);
    let pending: Value = event_logs(&failed).iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value["event"] == "cross_chain_pending").expect("pending event");
    let credit_id = pending["data"]["credit_id"].as_u64().unwrap();
    let pool_during = ctx.pool().await?;
    assert!(pool_during < pool_before, "pending stake stays reserved on failure");

    let stranger = ctx.account("stranger", 2).await?;
    let unauthorized = stranger.call(ctx.contract.id(), "on_unwrap")
        .args_json(json!({"credit_id": credit_id})).transact().await?;
    assert_refused(&unauthorized, "Method on_unwrap is private");
    assert!(feed_events(&unauthorized).is_empty());
    let unknown = stranger.call(ctx.contract.id(), "retry_unwrap")
        .args_json(json!({"credit_id": credit_id + 1})).transact().await?;
    assert_refused(&unknown, "credit_not_recoverable");

    let mut pending_key = b"q".to_vec();
    pending_key.extend(borsh::to_vec(&credit_id)?);
    let mut pending: PendingCredit = borsh::from_slice(&ctx.read_key(&pending_key).await?.expect("pending record"))?;
    pending.state = CreditState::InFlight;
    ctx.worker.patch_state(ctx.contract.id(), &pending_key, &borsh::to_vec(&pending)?).await?;
    let in_flight = stranger.call(ctx.contract.id(), "retry_unwrap")
        .args_json(json!({"credit_id": credit_id})).transact().await?;
    assert_refused(&in_flight, "credit_not_recoverable");
    pending.state = CreditState::Failed;
    ctx.worker.patch_state(ctx.contract.id(), &pending_key, &borsh::to_vec(&pending)?).await?;

    let failed_again = stranger.call(ctx.contract.id(), "retry_unwrap")
        .args_json(json!({"credit_id": credit_id}))
        .gas(Gas::from_tgas(100)).transact().await?;
    failed_again.clone().into_result()?;
    assert!(feed_events(&failed_again).is_empty());
    assert_eq!(ctx.pet_view("0").await?["given_food"], food_before.to_string());
    assert_eq!(wrap_balance(&wrap, ctx.contract.id().as_str()).await?, amount);

    wrap.call("set_withdraw_fails").args_json(json!({"fails":false}))
        .transact().await?.into_result()?;
    let retried = stranger.call(ctx.contract.id(), "retry_unwrap")
        .args_json(json!({"credit_id": credit_id}))
        .gas(Gas::from_tgas(100)).transact().await?;
    retried.clone().into_result()?;
    let feeds = feed_events(&retried);
    assert_eq!(feeds.len(), 1);
    assert_eq!(feeds[0]["data"]["credit_id"], credit_id);
    assert_eq!(feeds[0]["data"]["route_id"], "a".repeat(32));
    assert_eq!(feeds[0]["data"]["token_id"], "0");
    assert_eq!(feeds[0]["data"]["amount"], amount.to_string());
    assert_eq!(ctx.pet_view("0").await?["given_food"], (food_before + amount).to_string());
    assert_eq!(wrap_balance(&wrap, ctx.contract.id().as_str()).await?, 0);
    assert_eq!(ctx.pool().await?, pool_before, "settlement returns the pending stake");
    assert!(ctx.contract_balance().await? >= u128::from(ctx.storage_usage().await?) * 10_000_000_000_000_000_000);

    let settled = stranger.call(ctx.contract.id(), "retry_unwrap")
        .args_json(json!({"credit_id": credit_id})).transact().await?;
    assert_refused(&settled, "credit_not_recoverable");
    assert!(feed_events(&settled).is_empty());
    assert_eq!(ctx.pet_view("0").await?["given_food"], (food_before + amount).to_string());

    let contract_key = SecretKey::from_seed(KeyType::ED25519, "callback-once-only");
    ctx.worker.patch(ctx.contract.id())
        .access_key(contract_key.public_key(), AccessKey::full_access())
        .transact().await?;
    let self_caller = Account::from_secret_key(ctx.contract.id().clone(), contract_key, &ctx.worker);
    let replay = self_caller.call(ctx.contract.id(), "on_unwrap")
        .args_json(json!({"credit_id": credit_id})).transact().await?;
    assert_refused(&replay, "no_credit");
    assert!(feed_events(&replay).is_empty());
    assert_eq!(ctx.pet_view("0").await?["given_food"], (food_before + amount).to_string());
    Ok(())
}
