mod common;

use common::*;
use near_sdk::borsh::{self, BorshDeserialize};
use nearling_contract::ContractDebates;
use nearling_contract::any_chain::HELD_RELEASE_RECORD_BYTES;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, AccountDetailsPatch, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

fn event(result: &ExecutionFinalResult, name: &str) -> Option<Value> {
    event_logs(result).iter().filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value["event"] == name)
}

async fn token_balance(wrap: &Contract, account: &str) -> anyhow::Result<u128> {
    let value: Value = wrap.view("ft_balance_of").args_json(json!({"account_id": account})).await?.json()?;
    Ok(value.as_str().unwrap().parse()?)
}

async fn fixture(ctx: &Ctx) -> anyhow::Result<(Contract, Account)> {
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
        wrap.call("register").args_json(json!({"account_id": account})).transact().await?.into_result()?;
    }
    intents.call(wrap.id(), "near_deposit").deposit(NearToken::from_yoctonear(NEAR / 10))
        .transact().await?.into_result()?;
    Ok((wrap, intents))
}

async fn held(ctx: &Ctx, wrap: &Contract, intents: &Account, amount: u128) -> anyhow::Result<u64> {
    let result = intents.call(wrap.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": ctx.contract.id(), "amount": amount.to_string(),
            "memo": null, "msg": "{}"}))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(250))
        .transact().await?;
    result.clone().into_result()?;
    Ok(event(&result, "cross_chain_held").expect("held event")["data"]["delivery_id"].as_u64().unwrap())
}

// spec: add-any-chain-feed › Held wNEAR release contract › operator release
// spec: add-any-chain-feed › Held wNEAR release contract › unauthorized release
// spec: add-any-chain-feed › Held wNEAR release contract › duplicate release
// spec: add-any-chain-feed › Held wNEAR release contract › amount exceeds custody
// spec: add-any-chain-feed › Held wNEAR release contract › settlement transfer failed
#[tokio::test]
async fn held_delivery_release_failure_retry_and_replay_guard() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.mint("alice.near", "Pixel", "Curious").await?.into_result()?;
    let (wrap, intents) = fixture(&ctx).await?;
    let amount = NEAR / 100;
    let id = held(&ctx, &wrap, &intents, amount).await?;
    let food = ctx.pet_view("0").await?["given_food"].clone();
    let stranger = ctx.account("stranger", 2).await?;
    for caller in [&ctx.server, &stranger] {
        let denied = caller.call(ctx.contract.id(), "held_refund_release")
            .args_json(json!({"delivery_id": id, "amount": amount.to_string(),
                "settlement_account": ctx.treasury.id()})).transact().await?;
        assert_refused(&denied, "operator_only");
    }
    let bad_destination = ctx.contract.call("held_refund_release")
        .args_json(json!({"delivery_id": id, "amount": amount.to_string(),
            "settlement_account": stranger.id()})).transact().await?;
    assert_refused(&bad_destination, "wrong_settlement_account");
    let excess = ctx.contract.call("held_refund_release")
        .args_json(json!({"delivery_id": id, "amount": (amount + 1).to_string(),
            "settlement_account": ctx.treasury.id()})).transact().await?;
    assert_refused(&excess, "held_custody_insufficient");
    let unknown = ctx.contract.call("held_refund_release")
        .args_json(json!({"delivery_id": id + 1, "amount": amount.to_string(),
            "settlement_account": ctx.treasury.id()})).transact().await?;
    assert_refused(&unknown, "unknown_delivery");

    let before_storage = ctx.storage_usage().await?;
    let before_pool = ctx.pool().await?;
    let failed = ctx.contract.call("held_refund_release")
        .args_json(json!({"delivery_id": id, "amount": amount.to_string(),
            "settlement_account": ctx.treasury.id()})).gas(Gas::from_tgas(100)).transact().await?;
    assert!(event(&failed, "cross_chain_held_release_failed").is_some());
    assert!(event(&failed, "cross_chain_held_released").is_none());
    assert_eq!(ctx.storage_usage().await?, before_storage);
    assert_eq!(ctx.pool().await?, before_pool);
    assert_eq!(token_balance(&wrap, ctx.contract.id().as_str()).await?, amount);
    assert_eq!(ctx.pet_view("0").await?["given_food"], food);

    wrap.call("register").args_json(json!({"account_id": ctx.treasury.id()}))
        .transact().await?.into_result()?;
    let success = ctx.contract.call("held_refund_release")
        .args_json(json!({"delivery_id": id, "amount": amount.to_string(),
            "settlement_account": ctx.treasury.id()})).gas(Gas::from_tgas(100)).transact().await?;
    success.clone().into_result()?;
    let released = event(&success, "cross_chain_held_released").expect("release event");
    assert_eq!(released["data"]["delivery_id"], id);
    assert_eq!(released["data"]["amount"], amount.to_string());
    assert_eq!(released["data"]["settlement_account"], ctx.treasury.id().as_str());
    let measured = ctx.storage_usage().await? - before_storage;
    eprintln!("held release marker: {measured} bytes; ceiling {HELD_RELEASE_RECORD_BYTES}; receipts: {:?}",
        success.outcomes().iter().map(|receipt| (receipt.executor_id.to_string(), receipt.gas_burnt.as_gas())).collect::<Vec<_>>());
    assert!(measured <= HELD_RELEASE_RECORD_BYTES);
    assert_eq!(before_pool - ctx.pool().await?, u128::from(HELD_RELEASE_RECORD_BYTES) * 10_000_000_000_000_000_000);
    assert_eq!(token_balance(&wrap, ctx.contract.id().as_str()).await?, 0);
    assert_eq!(token_balance(&wrap, ctx.treasury.id().as_str()).await?, amount);
    assert_eq!(ctx.pet_view("0").await?["given_food"], food);
    let duplicate = ctx.contract.call("held_refund_release")
        .args_json(json!({"delivery_id": id, "amount": amount.to_string(),
            "settlement_account": ctx.treasury.id()})).transact().await?;
    assert_refused(&duplicate, "delivery_already_released");
    let replay = ctx.contract.call("on_held_refund_release")
        .args_json(json!({"delivery_id": id, "amount": amount.to_string()})).transact().await?;
    assert_refused(&replay, "release_not_in_flight");
    Ok(())
}

// spec: add-any-chain-feed › Held wNEAR release contract › resolution storage unavailable
#[tokio::test]
async fn release_needs_project_marker_stake() -> anyhow::Result<()> {
    let ctx = setup(0).await?;
    let (wrap, intents) = fixture(&ctx).await?;
    let amount = NEAR / 100;
    let id = held(&ctx, &wrap, &intents, amount).await?;
    let denied = ctx.contract.call("held_refund_release")
        .args_json(json!({"delivery_id": id, "amount": amount.to_string(),
            "settlement_account": ctx.treasury.id()})).transact().await?;
    assert_refused(&denied, "release_storage_unavailable");
    assert_eq!(token_balance(&wrap, ctx.contract.id().as_str()).await?, amount);
    Ok(())
}

// spec: add-any-chain-feed › Held wNEAR release contract › operator release
#[tokio::test]
async fn migration_from_debates_preserves_pets_food_pool_and_collections() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.mint("alice.near", "Pixel", "Curious").await?.into_result()?;
    let friend = ctx.account("friend", 2).await?;
    ctx.feed_as(&friend, "0", NEAR / 100).await?.into_result()?;
    let pet = ctx.pet_view("0").await?;
    let pool = ctx.pool().await?;
    let state = ctx.read_state().await?;
    let mut reader = &state[..];
    let old = ContractDebates::deserialize_reader(&mut reader)?;
    let old_bytes = borsh::to_vec(&old)?;
    ctx.worker.patch_state(ctx.contract.id(), b"STATE", &old_bytes).await?;
    let outsider = ctx.server.call(ctx.contract.id(), "migrate_any_chain").transact().await?;
    assert_refused(&outsider, "private");
    ctx.contract.call("migrate_any_chain").transact().await?.into_result()?;
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.pool().await?, pool);
    assert!(ctx.knows("0", friend.id().as_str()).await?);
    let migrated = ctx.read_state().await?;
    assert!(migrated.len() > old_bytes.len());
    let repeated = ctx.contract.call("migrate_any_chain").transact().await?;
    assert!(repeated.is_failure());
    assert_eq!(ctx.read_state().await?, migrated);
    Ok(())
}
