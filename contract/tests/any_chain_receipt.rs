mod common;

use common::*;
use near_sdk::borsh::BorshDeserialize;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, AccountDetailsPatch, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract};
use nearling_contract::any_chain::PENDING_RECORD_BYTES;
use nearling_contract::pet::VersionedPet;
use serde_json::{Value, json};

fn event(result: &ExecutionFinalResult, name: &str) -> Value {
    event_logs(result)
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value["event"] == name)
        .unwrap_or_else(|| panic!("missing {name}: {:?}", event_logs(result)))
}

async fn balance(wrap: &Contract, account: &str) -> anyhow::Result<u128> {
    let value: Value = wrap.view("ft_balance_of")
        .args_json(json!({"account_id": account})).await?.json()?;
    Ok(value.as_str().unwrap().parse()?)
}

async fn send(
    intents: &Account,
    wrap: &Contract,
    receiver: &str,
    amount: u128,
    msg: Value,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(intents.call(wrap.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": receiver,
            "amount": amount.to_string(),
            "memo": null,
            "msg": msg.to_string(),
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(250))
        .transact().await?)
}

// spec: add-any-chain-feed › wNEAR receipt contract › accepted transfer
#[tokio::test]
async fn testnet_wnear_setting_accepts_delivery_and_unwraps_through_wrap_testnet() -> anyhow::Result<()> {
    let ctx = setup_with_wnear(BIG_POOL, "wrap.testnet").await?;
    ctx.mint("alice.near", "Pixel", "Curious").await?.into_result()?;
    let configured: String = ctx.contract.view("wnear_account_view").await?.json()?;
    assert_eq!(configured, "wrap.testnet");
    let mut build = cargo_near_build::BuildOpts::default();
    build.manifest_path = Some(cargo_near_build::camino::Utf8PathBuf::from("tests/fixtures/wnear/Cargo.toml"));
    let wasm = std::fs::read(cargo_near_build::build_with_cli(build)
        .map_err(|error| anyhow::anyhow!("wNEAR fixture build: {error:?}"))?)?;
    let wrap_id = "wrap.testnet".parse()?;
    let wrap_key = SecretKey::from_seed(KeyType::ED25519, "wrap.testnet");
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
    let sent = send(&intents, &wrap, ctx.contract.id().as_str(), NEAR / 100,
        json!({"token_id":"0", "route":"a".repeat(32), "kind":"quote"})).await?;
    sent.clone().into_result()?;
    assert_eq!(event(&sent, "cross_chain_feed")["data"]["amount"], (NEAR / 100).to_string());
    assert_eq!(balance(&wrap, ctx.contract.id().as_str()).await?, 0);
    Ok(())
}

// spec: add-any-chain-feed › Cross-chain availability rule › pending capacity full
// spec: add-any-chain-feed › Cross-chain availability rule › pending stake unavailable
#[tokio::test]
async fn capacity_view_reports_global_100_boundary_and_pet_stake() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.mint("alice.near", "Pixel", "Curious").await?.into_result()?;
    for (count, available) in [(99, true), (100, false), (101, false)] {
        ctx.set_pending_count(count).await?;
        let view: Value = ctx.contract.view("cross_chain_capacity_view")
            .args_json(json!({"token_id":"0"})).await?.json()?;
        assert_eq!(view, json!({
            "pending_count": count,
            "pending_cap": 100,
            "capacity_available": available,
            "stake_available": true,
        }));
    }
    ctx.set_pool(0).await?;
    let no_stake: Value = ctx.contract.view("cross_chain_capacity_view")
        .args_json(json!({"token_id":"0"})).await?.json()?;
    assert_eq!(no_stake, json!({
        "pending_count": 101,
        "pending_cap": 100,
        "capacity_available": false,
        "stake_available": false,
    }));
    let unknown: Value = ctx.contract.view("cross_chain_capacity_view")
        .args_json(json!({"token_id":"999"})).await?.json()?;
    assert_eq!(unknown["stake_available"], false);
    Ok(())
}

// spec: add-any-chain-feed › wNEAR receipt contract › accepted transfer
// spec: add-any-chain-feed › wNEAR receipt contract › wrong token caller
// spec: add-any-chain-feed › wNEAR receipt contract › wrong sender
// spec: add-any-chain-feed › wNEAR receipt contract › unknown pet
// spec: add-any-chain-feed › wNEAR receipt contract › missing route id
// spec: add-any-chain-feed › wNEAR receipt contract › second real delivery on one route
// spec: add-any-chain-feed › wNEAR receipt contract › below food minimum
// spec: add-any-chain-feed › wNEAR receipt contract › pending storage unavailable
// spec: add-any-chain-feed › wNEAR receipt contract › pending cap reached
#[tokio::test]
async fn real_token_deliveries_keep_all_wnear_and_bound_pending_storage() -> anyhow::Result<()> {
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
        .deposit(NearToken::from_yoctonear(NEAR))
        .transact().await?.into_result()?;
    let route = "a".repeat(32);
    let valid = json!({"token_id":"0", "route":route, "kind":"quote"});

    let direct = ctx.server.call(ctx.contract.id(), "ft_on_transfer")
        .args_json(json!({"sender_id":"intents.near", "amount":NEAR.to_string(), "msg":valid.to_string()}))
        .transact().await?;
    assert_refused(&direct, "wrong_token_caller");
    assert!(event_logs(&direct).is_empty());
    assert_eq!(balance(&wrap, ctx.contract.id().as_str()).await?, 0);

    let stranger = ctx.account("stranger", 2).await?;
    stranger.call(wrap.id(), "register")
        .args_json(json!({"account_id": stranger.id()}))
        .transact().await?.into_result()?;
    stranger.call(wrap.id(), "near_deposit")
        .deposit(NearToken::from_yoctonear(NEAR / 10))
        .transact().await?.into_result()?;
    let wrong_sender = send(&stranger, &wrap, ctx.contract.id().as_str(), NEAR / 100, valid.clone()).await?;
    wrong_sender.clone().into_result()?;
    let held = event(&wrong_sender, "cross_chain_held");
    assert_eq!(held["data"]["reason"], "wrong_sender");
    assert_eq!(held["data"]["amount"], (NEAR / 100).to_string());
    assert_eq!(held["data"]["sender_id"], stranger.id().as_str());
    assert_eq!(held["data"]["token_id"], "0");
    assert_eq!(held["data"]["route_id"], route);
    assert_eq!(held["data"]["msg_hash"].as_str().unwrap().len(), 64);
    assert_eq!(balance(&wrap, ctx.contract.id().as_str()).await?, NEAR / 100);
    assert_eq!(ctx.pet_view("0").await?["given_food"], "0");

    let cases = [
        (json!({"token_id":"999", "route":route, "kind":"quote"}), NEAR / 100, "unknown_pet"),
        (json!({"token_id":"0", "kind":"quote"}), NEAR / 100, "invalid_route"),
        (valid.clone(), NEAR / 1000, "below_minimum"),
    ];
    let mut held_total = NEAR / 100;
    let mut last_id = held["data"]["delivery_id"].as_u64().unwrap();
    for (msg, amount, reason) in cases {
        let result = send(&intents, &wrap, ctx.contract.id().as_str(), amount, msg).await?;
        result.clone().into_result()?;
        let row = event(&result, "cross_chain_held");
        assert_eq!(row["data"]["reason"], reason);
        assert_eq!(row["data"]["delivery_id"], last_id + 1);
        last_id += 1;
        held_total += amount;
        assert_eq!(balance(&wrap, ctx.contract.id().as_str()).await?, held_total);
    }

    ctx.set_pool(0).await?;
    let before_held_storage = ctx.storage_usage().await?;
    let no_stake = send(&intents, &wrap, ctx.contract.id().as_str(), NEAR / 100, valid.clone()).await?;
    no_stake.clone().into_result()?;
    assert_eq!(event(&no_stake, "cross_chain_held")["data"]["reason"], "storage_unavailable");
    held_total += NEAR / 100;
    assert_eq!(balance(&wrap, ctx.contract.id().as_str()).await?, held_total);
    assert_eq!(ctx.storage_usage().await?, before_held_storage, "held receipt writes no record");

    ctx.set_pool(BIG_POOL).await?;
    ctx.set_pending_count(100).await?;
    let before_cap_storage = ctx.storage_usage().await?;
    let at_cap = send(&intents, &wrap, ctx.contract.id().as_str(), NEAR / 100, valid.clone()).await?;
    at_cap.clone().into_result()?;
    assert_eq!(event(&at_cap, "cross_chain_held")["data"]["reason"], "capacity");
    held_total += NEAR / 100;
    assert_eq!(balance(&wrap, ctx.contract.id().as_str()).await?, held_total);
    assert_eq!(ctx.storage_usage().await?, before_cap_storage, "101st receipt writes no record");
    let state = ctx.read_state().await?;
    let mut reader = &state[..];
    let custody = nearling_contract::ContractAnyChainV1::deserialize_reader(&mut reader)?;
    assert_eq!(custody.held_total, held_total);
    assert_eq!(custody.next_delivery_id, 6);
    ctx.set_pending_count(0).await?;

    wrap.call("set_withdraw_fails").args_json(json!({"fails":true}))
        .transact().await?.into_result()?;
    let before = ctx.storage_usage().await?;
    let before_pool = ctx.pool().await?;
    let accepted = send(&intents, &wrap, ctx.contract.id().as_str(), NEAR / 100, valid.clone()).await?;
    accepted.clone().into_result()?;
    let first = event(&accepted, "cross_chain_pending");
    assert_eq!(first["data"]["token_id"], "0");
    assert_eq!(first["data"]["amount"], (NEAR / 100).to_string());
    assert_eq!(balance(&wrap, ctx.contract.id().as_str()).await?, held_total + NEAR / 100);
    assert_eq!(ctx.pet_view("0").await?["given_food"], "0");
    let measured = ctx.storage_usage().await? - before;
    eprintln!("pending credit: {measured} bytes; ceiling {PENDING_RECORD_BYTES}; receipts: {:?}",
        accepted.outcomes().iter().map(|outcome| (outcome.executor_id.to_string(), outcome.gas_burnt.as_gas())).collect::<Vec<_>>());
    assert!(measured <= PENDING_RECORD_BYTES);
    let pending_stake = u128::from(PENDING_RECORD_BYTES) * 10_000_000_000_000_000_000;
    assert_eq!(before_pool - ctx.pool().await?, pending_stake);
    assert!(ctx.contract_balance().await? >= u128::from(ctx.storage_usage().await?) * 10_000_000_000_000_000_000);

    wrap.call("set_withdraw_fails").args_json(json!({"fails":false}))
        .transact().await?.into_result()?;
    let second = send(&intents, &wrap, ctx.contract.id().as_str(), NEAR / 100, valid.clone()).await?;
    second.clone().into_result()?;
    let second_id = event(&second, "cross_chain_pending")["data"]["credit_id"].as_u64().unwrap();
    assert_eq!(second_id, first["data"]["credit_id"].as_u64().unwrap() + 1);
    assert_eq!(event(&second, "cross_chain_feed")["data"]["amount"], (NEAR / 100).to_string());
    assert_eq!(ctx.pet_view("0").await?["given_food"], (NEAR / 100).to_string());
    assert_eq!(balance(&wrap, ctx.contract.id().as_str()).await?, held_total + NEAR / 100);
    assert_eq!(ctx.pool().await?, before_pool - pending_stake, "settled credit returns its reserved stake");
    let callback_gas = second.outcomes().into_iter()
        .find(|outcome| outcome.logs.iter().any(|line| line.contains("\"cross_chain_feed\"")))
        .expect("successful callback receipt").gas_burnt.as_gas();
    eprintln!("successful on_unwrap callback: {callback_gas} gas");
    assert!(callback_gas < Gas::from_tgas(10).as_gas());
    eprintln!("successful unwrap receipt gas: {:?}", second.outcomes().iter()
        .map(|outcome| (outcome.executor_id.to_string(), outcome.gas_burnt.as_gas()))
        .collect::<Vec<_>>());

    ctx.set_next_token_id(10_000_000_000_000_000_000).await?;
    ctx.mint("bob.near", "Long", "Curious").await?.into_result()?;
    wrap.call("set_withdraw_fails").args_json(json!({"fails":true}))
        .transact().await?.into_result()?;
    let before_long = ctx.storage_usage().await?;
    let long = send(&intents, &wrap, ctx.contract.id().as_str(), NEAR / 100,
        json!({"token_id":"10000000000000000000", "route":route, "kind":"quote"})).await?;
    long.clone().into_result()?;
    let measured_long = ctx.storage_usage().await? - before_long;
    eprintln!("maximum token-id pending credit: {measured_long} bytes");
    assert!(measured_long <= PENDING_RECORD_BYTES);

    let old_pet = ctx.read_record("0").await?.current().pet;
    ctx.put_record("0", VersionedPet::V6(old_pet)).await?;
    wrap.call("set_withdraw_fails").args_json(json!({"fails":false}))
        .transact().await?.into_result()?;
    let legacy = send(&intents, &wrap, ctx.contract.id().as_str(), NEAR / 100,
        json!({"token_id":"0", "route":"b".repeat(32), "kind":"quote"})).await?;
    legacy.clone().into_result()?;
    assert_eq!(event(&legacy, "cross_chain_feed")["data"]["amount"], (NEAR / 100).to_string());
    assert_eq!(ctx.pet_view("0").await?["given_food"], (2 * (NEAR / 100)).to_string());
    Ok(())
}
