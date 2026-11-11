mod common;

use common::*;
use nearling_contract::limits::{
    DAILY_CAP, DAY_NS, EXPERIENCE_COUNT_BYTES, HIRE_FEE_MAX, HIRE_FEE_MIN, MAX_JOBS_PER_DAY,
    PAIR_MAX_BYTES,
};
use serde_json::{Value, json};

const ANSWER: u128 = 300_000_000_000_000_000_000;
// 90% of the existing 0.00083 NEAR base quote, rounded in integer yoctoNEAR.
const DISCOUNTED: u128 = 747_000_000_000_000_000_000;
const BYTE_COST: u128 = 10_000_000_000_000_000_000;

async fn pair() -> anyhow::Result<Ctx> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.pet_with_food(STARTER_FOOD, 2 * HIRE_FEE_MAX).await?;
    ctx.mint("bob.near", "Nori", "I am calm.")
        .await?
        .into_result()?;
    Ok(ctx)
}

fn hire(answer: u128, fee: u128) -> Value {
    hired_json(answer, "1", Some(("player", fee, false)))
}

fn food(view: &Value, field: &str) -> u128 {
    view[field].as_str().unwrap().parse().unwrap()
}

async fn balances(ctx: &Ctx) -> anyhow::Result<Value> {
    Ok(json!({
        "payer": ctx.pet_view("0").await?,
        "worker": ctx.pet_view("1").await?,
        "treasury": ctx.balance_of(ctx.treasury.id()).await?.to_string(),
        "pool": ctx.pool().await?.to_string(),
        "storage": ctx.storage_usage().await?,
        "state_bytes": ctx.read_state().await?.len(),
    }))
}

async fn refused_fee(fee: u128, answer: u128, code: &str) -> anyhow::Result<()> {
    let ctx = pair().await?;
    refused(&ctx, "0", 1, vec![hire(answer, fee)], code).await
}

async fn refused(
    ctx: &Ctx,
    token_id: &str,
    debit_id: u64,
    thoughts: Vec<Value>,
    code: &str,
) -> anyhow::Result<()> {
    let before = balances(&ctx).await?;
    let result = ctx.debit(token_id, debit_id, thoughts).await?;
    assert_refused(&result, code);
    assert!(
        event_logs(&result).is_empty(),
        "a rejected hire emits no receipt or hire"
    );
    let gas = result
        .outcomes()
        .iter()
        .map(|outcome| outcome.gas_burnt.as_gas())
        .max()
        .unwrap();
    assert!(gas < 300_000_000_000_000, "rejected hire gas {gas}");
    eprintln!("society rejected hire: code={code}, gas={gas}");
    assert_eq!(
        balances(&ctx).await?,
        before,
        "rejection changes no balance, state or storage"
    );
    Ok(())
}

fn pet_hire() -> Value {
    hired_json(ANSWER, "1", Some(("pet", DISCOUNTED, false)))
}

// spec: add-pet-society › Society hire price contract › discounted hire accepted
#[tokio::test]
async fn discounted_hire_accepted() -> anyhow::Result<()> {
    assert!(DISCOUNTED >= HIRE_FEE_MIN && DISCOUNTED <= HIRE_FEE_MAX);
    let ctx = pair().await?;
    let before = balances(&ctx).await?;
    let result = ctx.debit("0", 1, vec![hire(ANSWER, DISCOUNTED)]).await?;
    result.clone().into_result()?;
    let logs = event_logs(&result);
    assert_eq!(
        logs.len(),
        2,
        "one answer receipt and the existing hire event"
    );
    let receipt: Value = serde_json::from_str(&logs[0])?;
    let hired: Value = serde_json::from_str(&logs[1])?;
    assert_eq!(receipt["event"], "receipt");
    assert_eq!(receipt["data"]["token_id"], "0");
    assert_eq!(receipt["data"]["worker"], "1");
    assert_eq!(receipt["data"]["price"], ANSWER.to_string());
    assert_eq!(hired["event"], "hire");
    assert_eq!(hired["data"]["fee"], DISCOUNTED.to_string());
    assert_eq!(hired["data"]["answer_cost"], ANSWER.to_string());
    assert_eq!(hired["data"]["kind"], "player");

    let after = balances(&ctx).await?;
    let before_payer =
        food(&before["payer"], "project_food") + food(&before["payer"], "given_food");
    let after_payer = food(&after["payer"], "project_food") + food(&after["payer"], "given_food");
    assert_eq!(before_payer - after_payer, DISCOUNTED);
    assert_eq!(food(&after["worker"], "given_food"), DISCOUNTED - ANSWER);
    assert_eq!(after["worker"]["jobs_today"], 1);
    assert_eq!(after["payer"]["last_debit_id"], 1);
    assert_eq!(
        after["treasury"].as_str().unwrap().parse::<u128>()?
            - before["treasury"].as_str().unwrap().parse::<u128>()?,
        ANSWER
    );
    let added = after["storage"].as_u64().unwrap() - before["storage"].as_u64().unwrap();
    assert_eq!(added, PAIR_MAX_BYTES + EXPERIENCE_COUNT_BYTES);
    assert_eq!(
        after["state_bytes"], before["state_bytes"],
        "the root layout is unchanged by a hire"
    );
    assert_eq!(
        before["pool"].as_str().unwrap().parse::<u128>()?
            - after["pool"].as_str().unwrap().parse::<u128>()?,
        u128::from(added) * BYTE_COST
    );
    let gas = result
        .outcomes()
        .iter()
        .map(|outcome| outcome.gas_burnt.as_gas())
        .max()
        .unwrap();
    assert!(gas < 300_000_000_000_000, "hire gas {gas}");
    assert!(logs.iter().map(String::len).sum::<usize>() <= 16_384);
    eprintln!(
        "society discounted hire: gas={gas}, storage={added}, event_bytes={}",
        logs.iter().map(String::len).sum::<usize>()
    );
    Ok(())
}

// spec: add-pet-society › Society hire price contract › below floor
#[tokio::test]
async fn below_floor_rejected() -> anyhow::Result<()> {
    refused_fee(HIRE_FEE_MIN - 1, ANSWER, "hire:0:fee_band").await
}

// spec: add-pet-society › Society hire price contract › above ceiling
#[tokio::test]
async fn above_ceiling_rejected() -> anyhow::Result<()> {
    refused_fee(HIRE_FEE_MAX + 1, ANSWER, "hire:0:fee_band").await
}

// spec: add-pet-society › Society hire price contract › answer costs all fee
#[tokio::test]
async fn answer_at_fee_rejected() -> anyhow::Result<()> {
    refused_fee(HIRE_FEE_MIN, HIRE_FEE_MIN, "hire:0:answer_over_fee").await
}

// spec: add-pet-society › Society hire price contract › wrong caller
#[tokio::test]
async fn wrong_caller_rejected_without_deposit_or_record() -> anyhow::Result<()> {
    let ctx = pair().await?;
    let before = balances(&ctx).await?;
    let result = ctx
        .debit_as(&ctx.funder, "0", 1, vec![hire(ANSWER, DISCOUNTED)])
        .await?;
    assert_refused(&result, "not_server");
    assert!(event_logs(&result).is_empty());
    assert_eq!(balances(&ctx).await?, before);
    Ok(())
}

// spec: add-pet-society › Society hire price contract › worker daily cap
#[tokio::test]
async fn worker_daily_cap_rejected_without_record() -> anyhow::Result<()> {
    let ctx = pair().await?;
    let today = ctx.block_timestamp().await? / DAY_NS;
    ctx.set_pet("1", |pet| {
        pet.job_day = today;
        pet.jobs_today = MAX_JOBS_PER_DAY;
    })
    .await?;
    refused(&ctx, "0", 1, vec![hire(ANSWER, DISCOUNTED)], "hire:0:jobs").await
}

// spec: add-pet-society › Society hire price contract › same owner
#[tokio::test]
async fn same_owner_rejected_without_record() -> anyhow::Result<()> {
    let ctx = pair().await?;
    let self_hire = hired_json(ANSWER, "0", Some(("player", DISCOUNTED, false)));
    refused(&ctx, "0", 1, vec![self_hire], "hire:0:same_owner").await
}

// spec: add-pet-society › Society hire price contract › pet hire without acquaintance
#[tokio::test]
async fn pet_hire_without_acquaintance_rejected() -> anyhow::Result<()> {
    let ctx = pair().await?;
    refused(&ctx, "0", 1, vec![pet_hire()], "hire:0:not_known").await
}

// spec: add-pet-society › Society hire price contract › pet hire from project food
#[tokio::test]
async fn pet_hire_cannot_spend_project_food() -> anyhow::Result<()> {
    let ctx = pair().await?;
    ctx.snack("0", "bob.near", "friend").await?.into_result()?;
    assert!(ctx.knows("0", "bob.near").await?);
    ctx.set_pet("0", |pet| pet.given_food = DISCOUNTED - 1)
        .await?;
    refused(&ctx, "0", 1, vec![pet_hire()], "hire:0:given_short").await
}

// spec: add-pet-society › Society hire price contract › insufficient food
#[tokio::test]
async fn insufficient_food_rejected_without_record() -> anyhow::Result<()> {
    let ctx = pair().await?;
    ctx.set_pet("0", |pet| {
        pet.project_food = 0;
        pet.given_food = DISCOUNTED - 1;
    })
    .await?;
    refused(&ctx, "0", 1, vec![hire(ANSWER, DISCOUNTED)], "over_food").await
}

// spec: add-pet-society › Society hire price contract › payer daily debit cap
#[tokio::test]
async fn payer_daily_cap_rejected_without_record() -> anyhow::Result<()> {
    let ctx = pair().await?;
    let today = ctx.block_timestamp().await? / DAY_NS;
    ctx.set_pet("0", |pet| {
        pet.debit_day = today;
        pet.debited_today = DAILY_CAP - DISCOUNTED + 1;
    })
    .await?;
    refused(&ctx, "0", 1, vec![hire(ANSWER, DISCOUNTED)], "daily_cap").await
}

// spec: add-pet-society › Society hire price contract › unknown pet
#[tokio::test]
async fn unknown_worker_rejected_without_record() -> anyhow::Result<()> {
    let ctx = pair().await?;
    let thought = hired_json(ANSWER, "99", Some(("player", DISCOUNTED, false)));
    refused(&ctx, "0", 1, vec![thought], "hire:0:no_worker").await
}

// spec: add-pet-society › Society hire price contract › post-answer hire rejection
#[tokio::test]
async fn post_answer_hire_rejection_is_atomic_and_retry_charges_only_usage() -> anyhow::Result<()> {
    let ctx = pair().await?;
    let today = ctx.block_timestamp().await? / DAY_NS;
    ctx.set_pet("1", |pet| {
        pet.job_day = today;
        pet.jobs_today = MAX_JOBS_PER_DAY;
    })
    .await?;
    // The worker's answer already exists off chain; its hire entry cannot be settled.
    refused(&ctx, "0", 1, vec![hire(ANSWER, DISCOUNTED)], "hire:0:jobs").await?;
    // add-pet-work retries that answer as a plain, usage-priced receipt.
    let before = balances(&ctx).await?;
    let result = ctx
        .debit("0", 1, vec![hired_json(ANSWER, "1", None)])
        .await?;
    result.clone().into_result()?;
    let logs = event_logs(&result);
    assert_eq!(logs.len(), 1);
    let receipt: Value = serde_json::from_str(&logs[0])?;
    assert_eq!(receipt["event"], "receipt");
    assert_eq!(receipt["data"]["price"], ANSWER.to_string());
    assert_eq!(receipt["data"]["worker"], "1");
    let after = balances(&ctx).await?;
    let payer_before =
        food(&before["payer"], "project_food") + food(&before["payer"], "given_food");
    let payer_after = food(&after["payer"], "project_food") + food(&after["payer"], "given_food");
    assert_eq!(payer_before - payer_after, ANSWER, "no hire fee was paid");
    assert_eq!(
        after["treasury"].as_str().unwrap().parse::<u128>()?
            - before["treasury"].as_str().unwrap().parse::<u128>()?,
        ANSWER
    );
    assert_eq!(
        after["worker"], before["worker"],
        "no worker food or hire count"
    );
    assert_eq!(ctx.pet_view("1").await?["jobs_today"], MAX_JOBS_PER_DAY);
    Ok(())
}
