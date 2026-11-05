mod common;

use common::*;
use nearling_contract::limits::{HIRE_FEE_MIN, MAX_THOUGHT_PRICE};
use serde_json::{Value, json};

async fn totals(ctx: &Ctx) -> anyhow::Result<Value> {
    Ok(ctx.contract.view("showcase_view").await?.json()?)
}

fn amount(view: &Value, key: &str) -> u128 {
    view[key].as_str().unwrap().parse().unwrap()
}

// spec: add-account › Showcase view contract › a birth counted
#[tokio::test]
async fn public_zero_view_and_only_accepted_births_count() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    assert_eq!(
        totals(&ctx).await?,
        json!({
            "pets_hatched": 0, "thoughts_paid": 0, "spent": "0"
        })
    );
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
    assert_eq!(
        totals(&ctx).await?,
        json!({
            "pets_hatched": 1, "thoughts_paid": 0, "spent": "0"
        })
    );

    let refused = ctx.mint("alice.near", "Again", "Curious").await?;
    assert_refused(&refused, "already_hatched");
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
    assert_eq!(
        totals(&ctx).await?,
        json!({
            "pets_hatched": 2, "thoughts_paid": 3, "spent": paid.to_string()
        })
    );
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

    assert_eq!(ctx.read_state().await?.len(), old_state_len + 32);
    let added_bytes = ctx.storage_usage().await? - old_storage;
    assert_eq!(added_bytes, 32);
    // The sandbox storage price is 10^19 yoctoNEAR per byte: 0.00032 NEAR of extra stake.
    assert_eq!(
        u128::from(added_bytes) * 10_000_000_000_000_000_000,
        320_000_000_000_000_000_000
    );
    assert_eq!(
        totals(&ctx).await?,
        json!({
            "pets_hatched": 2, "thoughts_paid": 0, "spent": "0"
        })
    );
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
