mod common;

use common::*;
use nearling_contract::limits::{
    DAY_NS, HIRE_FEE_MAX, HIRE_FEE_MIN, MAX_JOBS_PER_DAY, MIN_FEED, PAIR_MAX_BYTES,
};
use serde_json::{Value, json};

/// A fee at the floor of the band and the price of the worker's answer inside it.
const FEE: u128 = HIRE_FEE_MIN;
const PRICE: u128 = 300_000_000_000_000_000_000;
/// A plain thought of the hirer's, with no hire.
const PLAIN: u128 = 1_000_000_000_000_000_000;

fn amount(view: &Value, key: &str) -> u128 {
    view[key].as_str().unwrap().parse().unwrap()
}

/// The `hire` events of a call, in log order.
fn hire_events(result: &near_workspaces::result::ExecutionFinalResult) -> Vec<Value> {
    events_named(result, "hire")
}

fn events_named(result: &near_workspaces::result::ExecutionFinalResult, name: &str) -> Vec<Value> {
    event_logs(result)
        .iter()
        .map(|log| serde_json::from_str::<Value>(log).unwrap())
        .filter(|event| event["standard"] == "nearling" && event["event"] == name)
        .map(|event| event["data"].clone())
        .collect()
}

/// The names of the nearling events of a call in the order they were logged.
fn event_order(result: &near_workspaces::result::ExecutionFinalResult) -> Vec<String> {
    event_logs(result)
        .iter()
        .map(|log| serde_json::from_str::<Value>(log).unwrap())
        .filter(|event| event["standard"] == "nearling")
        .map(|event| event["event"].as_str().unwrap().to_string())
        .collect()
}

/// A sandbox with the hirer "0" (alice.near) holding `project` and `given` food, and the worker
/// "1" (bob.near, a real account so it can feed).
struct Pair {
    ctx: Ctx,
    bob: near_workspaces::Account,
}

async fn pair(project: u128, given: u128) -> anyhow::Result<Pair> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.pet_with_food(project, given).await?;
    let bob = ctx.account("bob", 20).await?;
    ctx.mint(bob.id().as_str(), "Nori", "I am calm.")
        .await?
        .into_result()?;
    Ok(Pair { ctx, bob })
}

/// Everything a refused hire must leave as it was.
async fn state(ctx: &Ctx) -> anyhow::Result<Value> {
    Ok(json!({
        "hirer": ctx.pet_view("0").await?,
        "worker": ctx.pet_view("1").await?,
        "treasury": ctx.balance_of(ctx.treasury.id()).await?.to_string(),
        "pool": ctx.pool().await?.to_string(),
    }))
}

fn player_hire(price: u128, fee: u128) -> Value {
    hired_json(price, "1", Some(("player", fee, false)))
}

fn pet_hire(price: u128, fee: u128) -> Value {
    hired_json(price, "1", Some(("pet", fee, false)))
}

async fn today(ctx: &Ctx) -> anyhow::Result<u64> {
    Ok(ctx.block_timestamp().await? / DAY_NS)
}

// spec: add-pet-work › Hire debit contract › найм записан
// spec: add-pet-work › Known pets rule › совет знакомит
#[tokio::test]
async fn a_hire_is_recorded_with_its_money_its_counter_its_pair_and_its_events_in_order()
-> anyhow::Result<()> {
    let Pair { ctx, .. } = pair(STARTER_FOOD, 2 * FEE).await?;
    let treasury_before = ctx.balance_of(ctx.treasury.id()).await?;
    let pool_before = ctx.pool().await?;
    let storage_before = ctx.storage_usage().await?;

    let result = ctx
        .debit(
            "0",
            1,
            vec![
                thought_json(PLAIN),
                hired_json(PRICE, "1", Some(("player", FEE, true))),
                thought_json(PLAIN),
            ],
        )
        .await?;
    let events = event_order(&result);
    result.clone().into_result()?;

    // The receipt of the worker's answer, then its `hire`; the other receipts around.
    assert_eq!(events, ["receipt", "receipt", "hire", "receipt"]);
    let receipts = events_named(&result, "receipt");
    assert!(receipts[0].get("worker").is_none(), "{}", receipts[0]);
    assert_eq!(receipts[1]["worker"], "1");
    assert_eq!(
        receipts[1]["token_id"], "0",
        "the payer stays the receipt's token"
    );
    assert_eq!(receipts[1]["debit_id"], 1);
    assert!(receipts[2].get("worker").is_none());
    let hires = hire_events(&result);
    assert_eq!(hires.len(), 1);
    assert_eq!(
        hires[0],
        json!({
            "debit_id": 1, "hirer": "0", "worker": "1", "kind": "player", "skill": true,
            "fee": FEE.to_string(), "answer_cost": PRICE.to_string(),
        })
    );

    // The hirer paid two plain thoughts and the fee (the starter food first); the worker earned
    // the fee minus its answer; the treasury got the plain thoughts and the answer.
    let hirer = ctx.pet_view("0").await?;
    let spent = 2 * PLAIN + FEE;
    let food = amount(&hirer, "project_food") + amount(&hirer, "given_food");
    assert_eq!(food, STARTER_FOOD + 2 * FEE - spent);
    assert_eq!(amount(&hirer, "debited_today"), spent);
    assert_eq!(hirer["last_debit_id"], 1);
    let worker = ctx.pet_view("1").await?;
    assert_eq!(amount(&worker, "given_food"), FEE - PRICE);
    assert_eq!(
        amount(&worker, "debited_today"),
        0,
        "the worker's own cap is untouched"
    );
    assert_eq!(worker["jobs_today"], 1);
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await? - treasury_before,
        2 * PLAIN + PRICE
    );

    // The pair: one record, both pets list the other, the pool paid the bytes written.
    assert_eq!(hirer["work_known"], json!(["1"]));
    assert_eq!(worker["work_known"], json!(["0"]));
    let written = ctx.storage_usage().await? - storage_before;
    let byte = 10_000_000_000_000_000_000u128;
    assert_eq!(pool_before - ctx.pool().await?, u128::from(written) * byte);
    assert_eq!(
        written, PAIR_MAX_BYTES,
        "two pets with no index entry: the worst pair"
    );
    Ok(())
}

// spec: add-pet-work › Hire debit contract › питомец того же владельца
#[tokio::test]
async fn a_pet_cannot_hire_itself_and_a_refused_hire_changes_nothing() -> anyhow::Result<()> {
    let Pair { ctx, .. } = pair(STARTER_FOOD, 2 * FEE).await?;
    let before = state(&ctx).await?;
    let refused = ctx
        .debit(
            "0",
            1,
            vec![hired_json(PRICE, "0", Some(("player", FEE, false)))],
        )
        .await?;
    assert_refused(&refused, "hire:0:same_owner");
    assert!(event_logs(&refused).is_empty(), "no receipt, no hire");
    assert_eq!(state(&ctx).await?, before);
    // Two pets of one owner are the unit test `two_pets_of_one_owner_never_hire_each_other`:
    // the contract has no transfer yet to make them in the sandbox.
    Ok(())
}

// spec: add-pet-work › Hire debit contract › одиннадцатая работа за сутки
#[tokio::test]
async fn ten_jobs_pass_the_eleventh_fails_and_the_next_utc_day_passes() -> anyhow::Result<()> {
    let Pair { ctx, .. } = pair(STARTER_FOOD, 20 * FEE).await?;
    let day = today(&ctx).await?;
    ctx.set_pet("1", |pet| {
        pet.job_day = day;
        pet.jobs_today = MAX_JOBS_PER_DAY;
    })
    .await?;
    let before = state(&ctx).await?;
    let refused = ctx.debit("0", 1, vec![player_hire(PRICE, FEE)]).await?;
    assert_refused(&refused, "hire:0:jobs");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(state(&ctx).await?, before, "nothing was debited");

    // Nine are done: the tenth passes, the eleventh does not.
    ctx.set_pet("1", |pet| pet.jobs_today = MAX_JOBS_PER_DAY - 1)
        .await?;
    ctx.debit("0", 1, vec![player_hire(PRICE, FEE)])
        .await?
        .into_result()?;
    assert_eq!(ctx.pet_view("1").await?["jobs_today"], 10);
    let refused = ctx.debit("0", 2, vec![player_hire(PRICE, FEE)]).await?;
    assert_refused(&refused, "hire:0:jobs");

    // 00:00 UTC: the day's ten belong to the day before.
    ctx.set_pet("1", |pet| pet.job_day -= 1).await?;
    assert_eq!(
        ctx.pet_view("1").await?["jobs_today"],
        0,
        "the view reads the new day"
    );
    ctx.debit("0", 2, vec![player_hire(PRICE, FEE)])
        .await?
        .into_result()?;
    assert_eq!(ctx.pet_view("1").await?["jobs_today"], 1);
    Ok(())
}

// spec: add-pet-work › Hire debit contract › плата вне коридора
#[tokio::test]
async fn the_fee_passes_at_both_edges_and_fails_a_yocto_outside() -> anyhow::Result<()> {
    let Pair { ctx, .. } = pair(STARTER_FOOD, 20 * FEE).await?;
    let before = state(&ctx).await?;
    for fee in [
        HIRE_FEE_MIN - 1,
        HIRE_FEE_MAX + 1,
        0,
        5_000_000_000_000_000_000_000,
    ] {
        let refused = ctx.debit("0", 1, vec![player_hire(PRICE, fee)]).await?;
        assert_refused(&refused, "hire:0:fee_band");
        assert!(event_logs(&refused).is_empty());
        assert_eq!(state(&ctx).await?, before, "fee {fee}");
    }
    ctx.debit("0", 1, vec![player_hire(PRICE, HIRE_FEE_MIN)])
        .await?
        .into_result()?;
    ctx.debit("0", 2, vec![player_hire(PRICE, HIRE_FEE_MAX)])
        .await?
        .into_result()?;
    let worker = ctx.pet_view("1").await?;
    assert_eq!(
        amount(&worker, "given_food"),
        HIRE_FEE_MIN - PRICE + HIRE_FEE_MAX - PRICE
    );
    assert_eq!(worker["jobs_today"], 2);
    Ok(())
}

// spec: add-pet-work › Hire debit contract › ответ дороже платы
#[tokio::test]
async fn an_answer_priced_at_the_fee_fails_and_a_yocto_under_passes() -> anyhow::Result<()> {
    let Pair { ctx, .. } = pair(STARTER_FOOD, 2 * FEE).await?;
    let before = state(&ctx).await?;
    for price in [FEE, FEE + 1] {
        let refused = ctx.debit("0", 1, vec![player_hire(price, FEE)]).await?;
        assert_refused(&refused, "hire:0:answer_over_fee");
        assert_eq!(state(&ctx).await?, before);
    }
    ctx.debit("0", 1, vec![player_hire(FEE - 1, FEE)])
        .await?
        .into_result()?;
    assert_eq!(amount(&ctx.pet_view("1").await?, "given_food"), 1);
    Ok(())
}

// spec: add-pet-work › Hire debit contract › найм питомцем из еды проекта
#[tokio::test]
async fn a_pets_own_hire_takes_given_food_only_and_a_players_takes_the_projects()
-> anyhow::Result<()> {
    let Pair { ctx, bob } = pair(STARTER_FOOD, 0).await?;
    // Bob fed the hirer: the worker's owner is known to it. Its given food is then set to just
    // under the fee, so the starter food alone could pay the hire.
    ctx.feed_as(&bob, "0", MIN_FEED).await?.into_result()?;
    assert!(ctx.knows("0", bob.id().as_str()).await?);
    ctx.set_pet("0", |pet| pet.given_food = FEE - 1).await?;

    let before = state(&ctx).await?;
    let refused = ctx.debit("0", 1, vec![pet_hire(PRICE, FEE)]).await?;
    assert_refused(&refused, "hire:0:given_short");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(
        state(&ctx).await?,
        before,
        "the starter food was not touched"
    );

    // A player's hire of the same fee passes, out of the project's food first.
    ctx.debit("0", 1, vec![player_hire(PRICE, FEE)])
        .await?
        .into_result()?;
    let hirer = ctx.pet_view("0").await?;
    assert_eq!(amount(&hirer, "project_food"), STARTER_FOOD - FEE);
    assert_eq!(amount(&hirer, "given_food"), FEE - 1);

    // With the fee in the given food a pet's own hire passes and takes it from there only.
    ctx.set_pet("0", |pet| pet.given_food = FEE).await?;
    ctx.debit("0", 2, vec![pet_hire(PRICE, FEE)])
        .await?
        .into_result()?;
    let hirer = ctx.pet_view("0").await?;
    assert_eq!(amount(&hirer, "given_food"), 0);
    assert_eq!(amount(&hirer, "project_food"), STARTER_FOOD - FEE);
    Ok(())
}

// spec: add-pet-work › Known pets contract › работник не знаком
#[tokio::test]
async fn a_pets_own_hire_needs_a_known_worker_by_a_feeding_or_by_a_pair() -> anyhow::Result<()> {
    let Pair { ctx, bob } = pair(STARTER_FOOD, 4 * FEE).await?;
    let before = state(&ctx).await?;
    let refused = ctx.debit("0", 1, vec![pet_hire(PRICE, FEE)]).await?;
    assert_refused(&refused, "hire:0:not_known");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(state(&ctx).await?, before);
    assert!(
        ctx.pet_view("0").await?["work_known"]
            .as_array()
            .unwrap()
            .is_empty(),
        "a refused hire makes no pair"
    );

    // Known by a feeding of the worker's owner.
    ctx.feed_as(&bob, "0", MIN_FEED).await?.into_result()?;
    ctx.debit("0", 1, vec![pet_hire(PRICE, FEE)])
        .await?
        .into_result()?;
    assert_eq!(ctx.pet_view("0").await?["work_known"], json!(["1"]));

    // Known by a pair alone: a second sandbox, a player's hire makes the pair, then the pet's.
    let Pair { ctx, .. } = pair(STARTER_FOOD, 4 * FEE).await?;
    let refused = ctx.debit("0", 1, vec![pet_hire(PRICE, FEE)]).await?;
    assert_refused(&refused, "hire:0:not_known");
    ctx.debit("0", 1, vec![player_hire(PRICE, FEE)])
        .await?
        .into_result()?;
    ctx.debit("0", 2, vec![pet_hire(PRICE, FEE)])
        .await?
        .into_result()?;
    Ok(())
}

// spec: add-pet-work › Known pets rule › совет знакомит
#[tokio::test]
async fn an_advice_makes_the_two_pets_known_both_ways() -> anyhow::Result<()> {
    let Pair { ctx, .. } = pair(STARTER_FOOD, 4 * FEE).await?;
    ctx.debit("0", 1, vec![player_hire(PRICE, FEE)])
        .await?
        .into_result()?;
    assert_eq!(ctx.pet_view("0").await?["work_known"], json!(["1"]));
    assert_eq!(ctx.pet_view("1").await?["work_known"], json!(["0"]));

    // The hirer asks the worker by itself.
    ctx.debit("0", 2, vec![pet_hire(PRICE, FEE)])
        .await?
        .into_result()?;
    // And the worker, with food of its own now, asks the hirer: the pair is read both ways.
    ctx.set_pet("1", |pet| pet.given_food = 4 * FEE).await?;
    ctx.debit(
        "1",
        1,
        vec![hired_json(PRICE, "0", Some(("pet", FEE, false)))],
    )
    .await?
    .into_result()?;
    assert_eq!(ctx.pet_view("0").await?["jobs_today"], 1);
    assert_eq!(ctx.pet_view("1").await?["jobs_today"], 2);
    // A known pair is written once: the third hire wrote no byte.
    let storage = ctx.storage_usage().await?;
    ctx.debit("0", 3, vec![pet_hire(PRICE, FEE)])
        .await?
        .into_result()?;
    assert_eq!(ctx.storage_usage().await?, storage);
    Ok(())
}

// spec: add-pet-work › Known pets contract › пул не покрывает знакомство
#[tokio::test]
async fn a_pool_below_the_pairs_bytes_accepts_the_hire_and_writes_no_pair() -> anyhow::Result<()> {
    let Pair { ctx, .. } = pair(STARTER_FOOD, 4 * FEE).await?;
    let short = u128::from(PAIR_MAX_BYTES) * 10_000_000_000_000_000_000u128 - 1;
    ctx.set_pool(short).await?;
    let treasury_before = ctx.balance_of(ctx.treasury.id()).await?;
    let storage = ctx.storage_usage().await?;

    let result = ctx.debit("0", 1, vec![player_hire(PRICE, FEE)]).await?;
    result.clone().into_result()?;
    assert_eq!(event_order(&result), ["receipt", "hire"]);
    let worker = ctx.pet_view("1").await?;
    assert_eq!(amount(&worker, "given_food"), FEE - PRICE);
    assert_eq!(worker["jobs_today"], 1);
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await? - treasury_before,
        PRICE
    );
    assert_eq!(ctx.pool().await?, short, "the pool is as it was");
    assert_eq!(ctx.storage_usage().await?, storage, "no byte written");
    assert!(worker["work_known"].as_array().unwrap().is_empty());
    assert!(
        ctx.pet_view("0").await?["work_known"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // Exactly the bound pays the pair, and the unindexed pair takes all of it.
    ctx.set_pool(short + 1).await?;
    ctx.debit("0", 2, vec![player_hire(PRICE, FEE)])
        .await?
        .into_result()?;
    assert_eq!(ctx.pet_view("1").await?["work_known"], json!(["0"]));
    assert_eq!(ctx.pool().await?, 0);
    Ok(())
}

// spec: add-pet-work › Hire debit contract › найм записан × the foreign caller
#[tokio::test]
async fn only_the_server_can_record_a_hire() -> anyhow::Result<()> {
    let Pair { ctx, .. } = pair(STARTER_FOOD, 2 * FEE).await?;
    let before = state(&ctx).await?;
    let refused = ctx
        .debit_as(&ctx.funder, "0", 1, vec![player_hire(PRICE, FEE)])
        .await?;
    assert_refused(&refused, "not_server");
    assert_eq!(state(&ctx).await?, before);
    Ok(())
}

// A worker's answer whose hire was dropped on a resend stays a receipt with the worker's token id,
// paid by the hirer by its price, and no `hire` follows it.
// spec: add-pet-work › Hire food data › повтор без найма × the receipt keeps its worker
#[tokio::test]
async fn an_answer_with_no_hire_keeps_its_worker_and_is_paid_by_its_price() -> anyhow::Result<()> {
    let Pair { ctx, .. } = pair(STARTER_FOOD, 0).await?;
    let result = ctx
        .debit("0", 1, vec![hired_json(PRICE, "1", None)])
        .await?;
    result.clone().into_result()?;
    assert_eq!(event_order(&result), ["receipt"]);
    assert_eq!(events_named(&result, "receipt")[0]["worker"], "1");
    let hirer = ctx.pet_view("0").await?;
    assert_eq!(amount(&hirer, "project_food"), STARTER_FOOD - PRICE);
    let worker = ctx.pet_view("1").await?;
    assert_eq!(amount(&worker, "given_food"), 0, "the worker earns nothing");
    assert_eq!(worker["jobs_today"], 0);
    assert!(worker["work_known"].as_array().unwrap().is_empty());
    Ok(())
}

// A hire entry with no worker or with a worker that does not exist is refused by its own code.
// spec: add-pet-work › Hire food data › повтор без найма × a hire that names nobody
#[tokio::test]
async fn a_hire_naming_no_pet_is_refused_with_its_index() -> anyhow::Result<()> {
    let Pair { ctx, .. } = pair(STARTER_FOOD, 2 * FEE).await?;
    let mut nobody = thought_json(PRICE);
    nobody["hire"] = json!({ "kind": "player", "skill": false, "fee": FEE.to_string() });
    let refused = ctx.debit("0", 1, vec![thought_json(PLAIN), nobody]).await?;
    assert_refused(&refused, "hire:1:no_worker");
    let refused = ctx
        .debit(
            "0",
            1,
            vec![hired_json(PRICE, "99", Some(("player", FEE, false)))],
        )
        .await?;
    assert_refused(&refused, "hire:0:no_worker");
    Ok(())
}

/// The batch of the limit: 12 thoughts, each a worker's answer with a hire and a new pair, with
/// the longest receipts. Its logs against the 16 kB and 100-log limits, its gas for `gasFor`.
// spec: add-pet-work › Hire debit contract › найм записан × a batch of 12 hires
#[tokio::test]
async fn twelve_hires_in_one_batch_stay_inside_the_log_limits_and_the_gas() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.pet_with_food(STARTER_FOOD, 100 * FEE).await?;
    for n in 1..=12 {
        ctx.mint(&format!("worker{n}.near"), "Nori", "I am calm.")
            .await?
            .into_result()?;
    }
    let batch: Vec<Value> = (1..=12)
        .map(|n| hired_json(PRICE, &n.to_string(), Some(("pet", FEE, true))))
        .collect();
    // Every hire is of kind pet: make each pair known first by one player hire of the same worker.
    let first: Vec<Value> = (1..=12)
        .map(|n| hired_json(PRICE, &n.to_string(), Some(("player", FEE, true))))
        .collect();
    let result = ctx.debit("0", 1, first).await?;
    let new_pairs_gas = result
        .outcomes()
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .max()
        .unwrap();
    let new_pairs_logs: Vec<String> = result.logs().into_iter().map(String::from).collect();
    result.clone().into_result()?;
    assert_eq!(new_pairs_logs.len(), 24, "12 receipts and 12 hires");
    let new_pairs_bytes: usize = new_pairs_logs.iter().map(|l| l.len()).sum();
    eprintln!(
        "12 hires, 12 new pairs: logs {} / {new_pairs_bytes} bytes, burnt in the call {new_pairs_gas} gas, total {}",
        new_pairs_logs.len(),
        result.total_gas_burnt.as_gas()
    );
    assert!(new_pairs_bytes <= 16_384, "{new_pairs_bytes} bytes of logs");
    assert!(new_pairs_logs.len() <= 100);

    // The same twelve again, now of kind pet over the known pairs: no pair is written.
    let result = ctx.debit("0", 2, batch).await?;
    let known_gas = result
        .outcomes()
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .max()
        .unwrap();
    let known_bytes: usize = result.logs().iter().map(|l| l.len()).sum();
    result.clone().into_result()?;
    eprintln!("12 hires, known pairs: logs {known_bytes} bytes, burnt in the call {known_gas} gas");
    assert!(known_bytes <= 16_384);
    for n in 1..=12 {
        let worker = ctx.pet_view(&n.to_string()).await?;
        assert_eq!(worker["jobs_today"], 2);
        assert_eq!(amount(&worker, "given_food"), 2 * (FEE - PRICE));
    }
    Ok(())
}
