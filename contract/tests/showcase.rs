mod common;

use common::*;
use nearling_contract::limits::{HIRE_FEE_MIN, MAX_THOUGHT_PRICE};
use nearling_contract::limits::FRIEND_SNACKS_PER_DAY;
use serde_json::{Value, json};

async fn totals(ctx: &Ctx) -> anyhow::Result<Value> {
    Ok(ctx.contract.view("showcase_view").await?.json()?)
}

fn amount(view: &Value, key: &str) -> u128 {
    view[key].as_str().unwrap().parse().unwrap()
}

// spec: add-account › Showcase view contract › a birth counted
// spec: add-pet › Pet mint contract › birth counted
// spec: add-hatch-again › Repeat pet mint contract › receiver owns a pet
#[tokio::test]
async fn public_zero_view_and_only_accepted_births_count() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let initial = totals(&ctx).await?;
    assert_eq!(initial["pets_hatched"], 0);
    assert_eq!(initial["thoughts_paid"], 0);
    assert_eq!(initial["spent"], "0");
    assert_eq!(initial["hires_completed"], 0);
    assert_eq!(initial["friend_snacks"], 0);
    assert!(initial["counted_since"].as_u64().unwrap() > 0);
    assert!(initial["counted_since"].as_u64().unwrap() <= ctx.block_timestamp().await?);
    let refused = ctx
        .mint_as(&ctx.funder, "alice.near", "Pixel", "Curious")
        .await?;
    assert_refused(&refused, "not_server");
    assert_eq!(totals(&ctx).await?["pets_hatched"], 0);

    let minted = ctx.mint("alice.near", "Pixel", "Curious").await?;
    let logs = event_logs(&minted);
    minted.into_result()?;
    assert_eq!(logs.len(), 2);
    let nft: Value = serde_json::from_str(&logs[0])?;
    let birth: Value = serde_json::from_str(&logs[1])?;
    assert_eq!(nft["standard"], "nep171");
    assert_eq!(nft["event"], "nft_mint");
    assert_eq!(birth["standard"], "nearling");
    assert_eq!(birth["event"], "pet_born");
    assert_eq!(birth["data"]["token_id"], "0");
    assert_eq!(birth["data"]["owner_id"], "alice.near");
    assert!(birth["data"]["character_sha256"].as_str().is_some());
    let after_birth = totals(&ctx).await?;
    assert_eq!(after_birth["pets_hatched"], 1);
    assert_eq!(after_birth["thoughts_paid"], 0);
    assert_eq!(after_birth["spent"], "0");
    assert_eq!(after_birth["hires_completed"], 0);
    assert_eq!(after_birth["friend_snacks"], 0);
    assert_eq!(after_birth["counted_since"], initial["counted_since"]);

    let refused = ctx.mint("alice.near", "Again", "Curious").await?;
    assert_refused(&refused, "already_owns_pet");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(totals(&ctx).await?["pets_hatched"], 1);
    Ok(())
}

// spec: add-account › Showcase view contract › a batch counted
#[tokio::test]
async fn accepted_plain_errand_and_hire_receipts_count_treasury_only() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(NEAR, 0).await?;
    ctx.mint("bob.near", "Nori", "Calm").await?.into_result()?;
    let before_pet = ctx.pet_view("0").await?;
    let before_worker = ctx.pet_view("1").await?;
    let treasury_before = ctx.balance_of(ctx.treasury.id()).await?;
    let plain = 1_000u128;
    let errand = 2_000u128;
    let answer = 300_000_000_000_000_000_000u128;
    let mut multi_call = thought_json(errand);
    multi_call["calls"] = json!([call_json(), call_json(), call_json()]);
    let batch = vec![
        thought_json(plain),
        multi_call,
        hired_json(answer, "1", Some(("player", HIRE_FEE_MIN, true))),
    ];

    let outsider = ctx.debit_as(&ctx.funder, "0", 1, batch.clone()).await?;
    assert_refused(&outsider, "not_server");
    assert_eq!(totals(&ctx).await?["thoughts_paid"], 0);

    let accepted = ctx.debit("0", 1, batch.clone()).await?;
    let logs = event_logs(&accepted);
    accepted.into_result()?;
    let names: Vec<String> = logs
        .iter()
        .map(|log| {
            serde_json::from_str::<Value>(log).unwrap()["event"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(names, ["receipt", "receipt", "receipt", "hire"]);
    let receipts: Vec<Value> = logs
        .iter()
        .map(|log| serde_json::from_str(log).unwrap())
        .collect();
    assert_eq!(receipts[2]["data"]["worker"], "1");
    assert_eq!(receipts[3]["data"]["fee"], HIRE_FEE_MIN.to_string());
    assert_eq!(receipts[3]["data"]["answer_cost"], answer.to_string());

    let paid = plain + errand + answer;
    let after_batch = totals(&ctx).await?;
    assert_eq!(after_batch["pets_hatched"], 2);
    assert_eq!(after_batch["thoughts_paid"], 3);
    assert_eq!(after_batch["spent"], paid.to_string());
    assert_eq!(after_batch["hires_completed"], 1);
    assert_eq!(after_batch["friend_snacks"], 0);
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await?,
        treasury_before + paid
    );
    let pet = ctx.pet_view("0").await?;
    let worker = ctx.pet_view("1").await?;
    assert_eq!(
        amount(&before_pet, "project_food") - amount(&pet, "project_food"),
        plain + errand + HIRE_FEE_MIN
    );
    assert_eq!(
        amount(&worker, "given_food") - amount(&before_worker, "given_food"),
        HIRE_FEE_MIN - answer
    );

    let rejected = ctx.debit("0", 1, batch).await?;
    assert_refused(&rejected, "bad_debit_id");
    let over_cap = ctx
        .debit("0", 2, vec![thought_json(MAX_THOUGHT_PRICE + 1)])
        .await?;
    assert_refused(&over_cap, "price_over_cap");
    let wrong_hire = ctx
        .debit(
            "0",
            2,
            vec![hired_json(answer, "1", Some(("player", 1, false)))],
        )
        .await?;
    assert_refused(&wrong_hire, "hire:0:fee_band");
    assert!(event_logs(&rejected).is_empty());
    assert!(event_logs(&over_cap).is_empty());
    assert!(event_logs(&wrong_hire).is_empty());
    assert_eq!(totals(&ctx).await?["spent"], paid.to_string());
    assert_eq!(totals(&ctx).await?["thoughts_paid"], 3);
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await?,
        treasury_before + paid
    );
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.pet_view("1").await?, worker);
    Ok(())
}

// spec: add-account › Showcase view contract › upgrade of a contract with pets
#[tokio::test]
async fn populated_v5_state_migrates_once_without_losing_pets_or_food() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(NEAR, 9_000).await?;
    ctx.mint("bob.near", "Nori", "Calm").await?.into_result()?;
    ctx.debit("0", 1, vec![thought_json(1_000)])
        .await?
        .into_result()?;
    let pet_before = ctx.pet_view("0").await?;
    let second_before = ctx.pet_view("1").await?;
    let hatch_before = ctx.hatch_view("alice.near").await?;
    let pool_before = ctx.pool().await?;
    let supply_before = ctx.supply_for("alice.near").await?;

    ctx.restore_v5_state().await?;
    let old_state_len = ctx.read_state().await?.len();
    let old_storage = ctx.storage_usage().await?;
    let outsider = ctx
        .funder
        .call(ctx.contract.id(), "migrate_showcase")
        .args_json(json!({}))
        .transact()
        .await?;
    assert_refused(&outsider, "private");
    ctx.contract
        .call("migrate_showcase")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;

    let current = ctx.read_state().await?;
    let _: nearling_contract::Contract = near_sdk::borsh::from_slice(&current)?;
    assert!(current.len() > old_state_len + 79);
    let added_bytes = ctx.storage_usage().await? - old_storage;
    assert_eq!(added_bytes as usize, current.len() - old_state_len);
    let migrated = totals(&ctx).await?;
    assert_eq!(migrated["pets_hatched"], 2);
    assert_eq!(migrated["thoughts_paid"], 0);
    assert_eq!(migrated["spent"], "0");
    assert_eq!(migrated["hires_completed"], 0);
    assert_eq!(migrated["friend_snacks"], 0);
    assert!(migrated["counted_since"].as_u64().unwrap() > 0);
    assert_eq!(ctx.pet_view("0").await?, pet_before);
    assert_eq!(ctx.pet_view("1").await?, second_before);
    assert_eq!(ctx.hatch_view("alice.near").await?, hatch_before);
    assert_eq!(ctx.pool().await?, pool_before);
    assert_eq!(ctx.supply_for("alice.near").await?, supply_before);
    assert_eq!(ctx.supply_for("bob.near").await?, "1");

    let state_after = ctx.read_state().await?;
    let again = ctx
        .contract
        .call("migrate_showcase")
        .args_json(json!({}))
        .transact()
        .await?;
    assert!(again.is_failure());
    assert_eq!(ctx.read_state().await?, state_after);
    assert_eq!(totals(&ctx).await?["pets_hatched"], 2);
    Ok(())
}

// spec: add-showcase › Showcase totals contract › hire accepted
#[tokio::test]
async fn accepted_hires_count_once_per_receipt_under_existing_debit_checks() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(NEAR, 0).await?;
    ctx.mint("bob.near", "Nori", "Calm").await?.into_result()?;
    let hire = hired_json(1, "1", Some(("player", HIRE_FEE_MIN, false)));
    let batch = vec![thought_json(1), hire.clone(), hire];
    let wrong = ctx.debit_as(&ctx.funder, "0", 1, batch.clone()).await?;
    assert_refused(&wrong, "not_server");
    assert_eq!(totals(&ctx).await?["hires_completed"], 0);
    let accepted = ctx.debit("0", 1, batch.clone()).await?;
    let gas = accepted.outcomes()[1].gas_burnt.as_gas();
    assert!(gas < 300_000_000_000_000);
    let events = event_logs(&accepted);
    accepted.into_result()?;
    assert_eq!(events.iter().filter(|event| event.contains("\"event\":\"hire\"")).count(), 2);
    assert_eq!(totals(&ctx).await?["hires_completed"], 2);
    eprintln!("showcase two-hire debit gas: {gas}");

    let mut twelve = vec![thought_json(1); 11];
    twelve.push(hired_json(1, "1", Some(("player", HIRE_FEE_MIN, false))));
    let full_batch = ctx.debit("0", 2, twelve).await?;
    let full_gas = full_batch.total_gas_burnt.as_gas();
    full_batch.into_result()?;
    eprintln!("showcase 12-thought batch gas: {full_gas}");
    assert!(full_gas < 300_000_000_000_000);
    assert_eq!(totals(&ctx).await?["hires_completed"], 3);

    let replay = ctx.debit("0", 1, batch).await?;
    assert_refused(&replay, "bad_debit_id");
    let oversized = ctx.debit("0", 3, vec![thought_json(1); 13]).await?;
    assert_refused(&oversized, "too_many_thoughts");
    let over_price = ctx.debit("0", 3, vec![thought_json(MAX_THOUGHT_PRICE + 1)]).await?;
    assert_refused(&over_price, "price_over_cap");
    assert_eq!(totals(&ctx).await?["hires_completed"], 3);
    Ok(())
}

// spec: add-showcase › Showcase totals contract › friend snack accepted
#[tokio::test]
async fn only_accepted_friend_snacks_count_across_utc_day_reset() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.mint("alice.near", "Pixel", "Curious").await?.into_result()?;
    ctx.avoid_midnight().await?;
    ctx.snack("0", "alice.near", "owner").await?.into_result()?;
    assert_eq!(totals(&ctx).await?["friend_snacks"], 0);
    let wrong = ctx.snack_as(&ctx.funder, "0", "bob.near", "friend").await?;
    assert_refused(&wrong, "not_server");
    for n in 1..=FRIEND_SNACKS_PER_DAY {
        let result = ctx.snack("0", &format!("friend{n}.near"), "friend").await?;
        let events = event_logs(&result);
        let gas = result.outcomes()[1].gas_burnt.as_gas();
        assert!(gas < 300_000_000_000_000);
        result.into_result()?;
        assert_eq!(events.len(), 1);
        assert!(events[0].contains("\"event\":\"snack\""));
        eprintln!("showcase friend snack {n} gas: {gas}");
        assert_eq!(totals(&ctx).await?["friend_snacks"], u64::from(n));
    }
    let fourth = ctx.snack("0", "friend4.near", "friend").await?;
    assert_refused(&fourth, "snacks_today");
    assert_eq!(totals(&ctx).await?["friend_snacks"], 3);
    let yesterday = ctx.pet_view("0").await?["friend_snack_day"].as_u64().unwrap() - 1;
    ctx.set_pet("0", |pet| pet.friend_snack_day = yesterday).await?;
    ctx.snack("0", "friend4.near", "friend").await?.into_result()?;
    assert_eq!(totals(&ctx).await?["friend_snacks"], 4);
    Ok(())
}

// spec: add-showcase › Showcase totals contract › hire accepted × upgrade preserves prior totals
#[tokio::test]
async fn v6_upgrade_preserves_existing_totals_and_measures_storage() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(NEAR, 0).await?;
    ctx.debit("0", 1, vec![thought_json(1_000)]).await?.into_result()?;
    let before = totals(&ctx).await?;
    let pet_before = ctx.pet_view("0").await?;
    let pool_before = ctx.pool().await?;
    ctx.restore_v6_state().await?;
    let old_len = ctx.read_state().await?.len();
    let old_storage = ctx.storage_usage().await?;
    let outsider = ctx.funder.call(ctx.contract.id(), "migrate_showcase_totals")
        .args_json(json!({})).transact().await?;
    assert_refused(&outsider, "private");
    let before_migration = ctx.block_timestamp().await?;
    let migrated = ctx.contract.call("migrate_showcase_totals")
        .args_json(json!({})).transact().await?;
    let gas = migrated.outcomes()[1].gas_burnt.as_gas();
    assert!(gas < 300_000_000_000_000);
    migrated.into_result()?;
    let added = ctx.storage_usage().await? - old_storage;
    let current = ctx.read_state().await?;
    let _: nearling_contract::Contract = near_sdk::borsh::from_slice(&current)?;
    assert!(current.len() > old_len + 47);
    assert_eq!(added as usize, current.len() - old_len);
    eprintln!("showcase V6 migration: {added} bytes, {} yocto stake, {gas} gas", u128::from(added) * 10_000_000_000_000_000_000);
    let after = totals(&ctx).await?;
    for key in ["pets_hatched", "thoughts_paid", "spent"] {
        assert_eq!(after[key], before[key], "{key}");
    }
    assert_eq!(after["hires_completed"], 0);
    assert_eq!(after["friend_snacks"], 0);
    assert!(after["counted_since"].as_u64().unwrap() >= before["counted_since"].as_u64().unwrap());
    assert!(after["counted_since"].as_u64().unwrap() >= before_migration);
    assert!(after["counted_since"].as_u64().unwrap() <= ctx.block_timestamp().await?);
    assert_eq!(ctx.pet_view("0").await?, pet_before);
    assert_eq!(ctx.pool().await?, pool_before);
    let state = ctx.read_state().await?;
    let second = ctx.contract.call("migrate_showcase_totals")
        .args_json(json!({})).transact().await?;
    assert!(second.is_failure());
    assert_eq!(ctx.read_state().await?, state);
    Ok(())
}
