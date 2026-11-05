mod common;

use common::*;
use nearling_contract::limits::{
    DAILY_CAP, MAX_THOUGHT_PRICE, MAX_THOUGHTS_PER_DEBIT, STARTER_FOOD,
};
use serde_json::{Value, json};

const ONE_NEAR: u128 = NEAR;

fn amount(view: &Value, key: &str) -> u128 {
    view[key].as_str().unwrap().parse().unwrap()
}

/// Everything a refused debit must leave as it was.
async fn debit_state(ctx: &Ctx) -> anyhow::Result<Value> {
    let treasury = ctx.balance_of(ctx.treasury.id()).await?;
    Ok(json!({ "pet": ctx.pet_view("0").await?, "treasury": treasury.to_string() }))
}

// spec: add-pet › Session debit contract › чужой вызов
#[tokio::test]
async fn a_foreign_caller_cannot_debit() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(ONE_NEAR, 0).await?;
    let before = debit_state(&ctx).await?;
    let refused = ctx
        .debit_as(&ctx.funder, "0", 1, thoughts(1, 1_000))
        .await?;
    assert_refused(&refused, "not_server");
    assert_eq!(debit_state(&ctx).await?, before);
    assert!(event_logs(&refused).is_empty());
    Ok(())
}

// spec: add-pet › Session debit contract › мысль дороже лимита
#[tokio::test]
async fn one_thought_over_the_per_thought_cap_refuses_the_whole_batch() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(ONE_NEAR, 0).await?;
    // 0.005 NEAR passes.
    ctx.debit("0", 1, vec![thought_json(MAX_THOUGHT_PRICE)])
        .await?
        .into_result()?;
    let before = debit_state(&ctx).await?;
    // 0.005 NEAR + 1 yocto in one thought of the batch: the whole batch fails, no receipts.
    let batch = vec![
        thought_json(1_000),
        thought_json(MAX_THOUGHT_PRICE + 1),
        thought_json(1_000),
    ];
    let refused = ctx.debit("0", 2, batch).await?;
    assert_refused(&refused, "price_over_cap");
    assert_eq!(debit_state(&ctx).await?, before);
    assert!(
        event_logs(&refused).is_empty(),
        "no receipts for a refused batch"
    );
    assert_eq!(ctx.pet_view("0").await?["last_debit_id"], 1);
    Ok(())
}

// spec: add-pet › Session debit contract › выше суточного лимита
#[tokio::test]
async fn the_daily_cap_passes_to_the_yocto_and_resets_at_00_utc() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.pet_with_food(ONE_NEAR, 0).await?;
    // Two batches bring the day to exactly 0.05 NEAR.
    ctx.debit("0", 1, thoughts(5, MAX_THOUGHT_PRICE))
        .await?
        .into_result()?;
    ctx.debit("0", 2, thoughts(5, MAX_THOUGHT_PRICE))
        .await?
        .into_result()?;
    let view = ctx.pet_view("0").await?;
    assert_eq!(amount(&view, "debited_today"), DAILY_CAP);

    let before = debit_state(&ctx).await?;
    let refused = ctx.debit("0", 3, thoughts(1, 1)).await?;
    assert_refused(&refused, "daily_cap");
    assert_eq!(debit_state(&ctx).await?, before);
    assert!(event_logs(&refused).is_empty());

    // 00:00 UTC: what was debited belongs to the day before; the same batch passes now.
    ctx.set_pet("0", |pet| pet.debit_day -= 1).await?;
    ctx.debit("0", 3, thoughts(1, 1)).await?.into_result()?;
    let view = ctx.pet_view("0").await?;
    assert_eq!(amount(&view, "debited_today"), 1);
    assert_eq!(view["last_debit_id"], 3);
    Ok(())
}

// spec: add-pet › Session debit contract › больше еды питомца
#[tokio::test]
async fn a_sum_over_the_food_is_refused_and_the_project_food_goes_first() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    // The starter food 0.0020 NEAR (the project's) and 0.0010 NEAR given.
    ctx.pet_with_food(STARTER_FOOD, 1_000_000_000_000_000_000_000)
        .await?;
    let before = debit_state(&ctx).await?;
    // Food is 3e21: 3e21 + 1 yocto is refused whole.
    let refused = ctx
        .debit("0", 1, vec![thought_json(3_000_000_000_000_000_000_001)])
        .await?;
    // (one thought is capped at 5e21, so 3e21 + 1 fits the per-thought cap)
    assert_refused(&refused, "over_food");
    assert_eq!(debit_state(&ctx).await?, before);
    let view = ctx.pet_view("0").await?;
    assert_eq!(amount(&view, "project_food"), STARTER_FOOD);
    assert_eq!(amount(&view, "given_food"), 1_000_000_000_000_000_000_000);

    // 2.5e21 comes from the project's 2e21 and 0.5e21 of the given food.
    ctx.debit("0", 1, vec![thought_json(2_500_000_000_000_000_000_000)])
        .await?
        .into_result()?;
    let view = ctx.pet_view("0").await?;
    assert_eq!(amount(&view, "project_food"), 0);
    assert_eq!(amount(&view, "given_food"), 500_000_000_000_000_000_000);

    // What is left, to the yocto, passes; one more yocto does not.
    let left = 500_000_000_000_000_000_000u128;
    let refused = ctx.debit("0", 2, vec![thought_json(left + 1)]).await?;
    assert_refused(&refused, "over_food");
    ctx.debit("0", 2, vec![thought_json(left)])
        .await?
        .into_result()?;
    let view = ctx.pet_view("0").await?;
    assert_eq!(
        amount(&view, "project_food") + amount(&view, "given_food"),
        0
    );
    Ok(())
}

// spec: add-pet › Session debit contract › повтор списания
#[tokio::test]
async fn a_repeat_or_a_jump_of_the_debit_id_is_refused_and_the_sum_is_debited_once()
-> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(ONE_NEAR, 0).await?;
    let treasury_before = ctx.balance_of(ctx.treasury.id()).await?;

    // A jump from 0 to 2 is refused.
    let jump = ctx.debit("0", 2, thoughts(1, 1_000)).await?;
    assert_refused(&jump, "bad_debit_id");

    let sum = 3 * 1_000_000_000_000_000_000_000u128;
    ctx.debit("0", 1, thoughts(3, 1_000_000_000_000_000_000_000))
        .await?
        .into_result()?;
    let accepted = debit_state(&ctx).await?;
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await?,
        treasury_before + sum
    );

    // The same batch again (its outcome unknown to the server): refused, nothing changes.
    let repeat = ctx
        .debit("0", 1, thoughts(3, 1_000_000_000_000_000_000_000))
        .await?;
    assert_refused(&repeat, "bad_debit_id");
    assert_eq!(debit_state(&ctx).await?, accepted);
    assert!(event_logs(&repeat).is_empty());
    // A jump of +2.
    let jump = ctx.debit("0", 3, thoughts(1, 1_000)).await?;
    assert_refused(&jump, "bad_debit_id");
    assert_eq!(debit_state(&ctx).await?, accepted);
    assert_eq!(ctx.pet_view("0").await?["last_debit_id"], 1);

    // The treasury got exactly the accepted sum, once; the contract keeps its storage stake.
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await?,
        treasury_before + sum
    );
    let stake = ctx.storage_usage().await? as u128 * 10_000_000_000_000_000_000u128;
    assert!(ctx.contract_balance().await? >= stake);
    assert_eq!(
        amount(&ctx.pet_view("0").await?, "project_food"),
        ONE_NEAR - sum
    );
    Ok(())
}

// spec: add-pet › Session debit contract › больше 12 мыслей в пачке
#[tokio::test]
async fn a_batch_of_13_thoughts_is_refused_whole_and_12_pass() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(ONE_NEAR, 0).await?;
    let ok = ctx
        .debit("0", 1, thoughts(MAX_THOUGHTS_PER_DEBIT, 1_000))
        .await?;
    assert_eq!(event_logs(&ok).len(), 12, "one receipt event per thought");
    ok.into_result()?;
    let accepted = debit_state(&ctx).await?;
    assert_eq!(ctx.pet_view("0").await?["last_debit_id"], 1);

    let refused = ctx
        .debit("0", 2, thoughts(MAX_THOUGHTS_PER_DEBIT + 1, 1_000))
        .await?;
    assert_refused(&refused, "too_many_thoughts");
    assert_eq!(debit_state(&ctx).await?, accepted);
    assert!(event_logs(&refused).is_empty(), "no receipts");
    assert_eq!(ctx.pet_view("0").await?["last_debit_id"], 1);
    Ok(())
}

// spec: add-pet › Session debit contract › больше 12 мыслей в пачке × пустая пачка
// spec: add-pet › Session debit contract › пустая пачка
#[tokio::test]
async fn an_empty_batch_is_refused_and_changes_nothing() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(ONE_NEAR, 0).await?;
    let before = debit_state(&ctx).await?;
    let refused = ctx.debit("0", 1, vec![]).await?;
    assert_refused(&refused, "empty_batch");
    assert_eq!(debit_state(&ctx).await?, before);
    assert!(event_logs(&refused).is_empty());
    Ok(())
}

/// The shape of a thought the contract takes: one to four calls (an errand's search, data call,
/// report and re-ask); a pet that does not exist; the codes the Worker tells apart.
// spec: add-pet-errands › Errand debit contract › errand recorded
// spec: add-pet-errands › Errand debit contract › five calls in a receipt
// spec: add-pet › Session debit contract › неверное число вызовов мысли
#[tokio::test]
async fn a_thought_has_one_to_four_calls_and_the_pet_must_exist() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(ONE_NEAR, 0).await?;
    let two = json!({ "model": "m", "price": "1000", "calls": [call_json(), call_json()] });
    ctx.debit("0", 1, vec![two]).await?.into_result()?;
    let none = json!({ "model": "m", "price": "1000", "calls": [] });
    let before = debit_state(&ctx).await?;
    let refused_zero = ctx.debit("0", 2, vec![none]).await?;
    assert_refused(&refused_zero, "bad_calls");
    assert_eq!(debit_state(&ctx).await?, before);
    assert!(event_logs(&refused_zero).is_empty());
    let calls = |n: usize| vec![call_json(); n];
    let four = json!({ "model": "m", "price": "1000", "calls": calls(4) });
    ctx.debit("0", 2, vec![four]).await?.into_result()?;
    let five = json!({ "model": "m", "price": "1000", "calls": calls(5) });
    let before = debit_state(&ctx).await?;
    let refused_five = ctx.debit("0", 3, vec![five]).await?;
    assert_refused(&refused_five, "bad_calls");
    assert_eq!(debit_state(&ctx).await?, before);
    assert!(event_logs(&refused_five).is_empty());
    assert_eq!(ctx.pet_view("0").await?["last_debit_id"], 2);
    assert_refused(&ctx.debit("77", 1, thoughts(1, 1_000)).await?, "no_pet");
    Ok(())
}

/// 12 thoughts of two calls each, with the longest fields, fit the log limits (16 kB, 100 logs)
/// and the gas of one call; the numbers go to design.md › Контракт. This checks the spec's
/// number, it does not tune it (ADR-004 › Batches of at most 12).
#[tokio::test]
async fn gas_and_logs_of_a_full_batch() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(ONE_NEAR, 0).await?;
    // A 20-digit `debit_id` is the longest one (the id is in every event).
    let last: u64 = 9_999_999_999_999_999_998;
    ctx.set_pet("0", |pet| pet.last_debit_id = last).await?;

    let long_call = json!({
        "req_sha256": "a".repeat(64),
        "res_sha256": "b".repeat(64),
        "signature": format!("0x{}", "c".repeat(130)),
        "sig_kind": "provider_tee",
        "signer": format!("0x{}", "d".repeat(64)),
        "tokens_in": 4_294_967_295u64,
        "tokens_out": 4_294_967_295u64,
        "tokens_reasoning": 4_294_967_295u64,
        "cut": false,
    });
    // 22 digits, the longest price; 12 x 4e21 stays under the daily cap.
    let long_thought = json!({
        "model": "m".repeat(64),
        "price": "4000000000000000000000",
        "calls": [long_call.clone(), long_call],
    });
    let result = ctx.debit("0", last + 1, vec![long_thought; 12]).await?;
    assert!(result.is_success(), "{:?}", result.failures());

    let gas_total = result.total_gas_burnt.as_gas();
    let debit_gas = result.outcomes()[1].gas_burnt.as_gas();
    let logs: Vec<&str> = result.logs();
    let log_bytes: usize = logs.iter().map(|l| l.len()).sum();
    // The token_id "0" is one digit; the longest is 20: 19 more bytes in each of 12 events.
    let log_bytes_longest_id = log_bytes + 12 * 19;
    eprintln!(
        "gas_and_logs_of_a_full_batch: {} logs, {log_bytes} bytes ({log_bytes_longest_id} with a 20-digit token_id), debit_session gas {debit_gas}, whole tx {gas_total}",
        logs.len()
    );
    assert_eq!(logs.len(), 12);
    assert!(
        log_bytes_longest_id <= 16 * 1024,
        "{log_bytes_longest_id} bytes of logs"
    );
    assert!(logs.len() <= 100);
    assert!(gas_total < 300_000_000_000_000);
    Ok(())
}

/// An errand's four calls: the search through the gateway, a data call, the report and the re-ask.
fn errand_calls() -> Vec<Value> {
    let gateway = json!({
        "req_sha256": "a".repeat(64),
        "res_sha256": "b".repeat(64),
        "signature": format!("0x{}", "c".repeat(130)),
        "sig_kind": "gateway",
        "signer": format!("0x{}", "d".repeat(40)),
        "tokens_in": 1800,
        "tokens_out": 90,
        "tokens_reasoning": 0,
        "cut": false,
    });
    vec![gateway, call_json(), call_json(), call_json()]
}

fn errand_thought(price: u128) -> Value {
    json!({ "model": "Qwen/Qwen3.8-27B", "price": price.to_string(), "calls": errand_calls() })
}

// spec: add-pet-errands › Errand debit contract › errand recorded
#[tokio::test]
async fn an_errand_thought_with_four_calls_is_recorded_whole() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(ONE_NEAR, 0).await?;
    let treasury_before = ctx.balance_of(ctx.treasury.id()).await?;
    let food_before = amount(&ctx.pet_view("0").await?, "project_food");

    let result = ctx
        .debit("0", 1, vec![errand_thought(MAX_THOUGHT_PRICE)])
        .await?;
    let logs = event_logs(&result);
    result.clone().into_result()?;

    // One `receipt` event holds all four calls, the search signed by the gateway, the rest by
    // the provider; the hashes and signatures are on chain, no text.
    assert_eq!(logs.len(), 1);
    let event: Value = serde_json::from_str(&logs[0])?;
    assert_eq!(event["event"], "receipt");
    let data = &event["data"];
    let mut data_keys: Vec<_> = data
        .as_object()
        .expect("receipt data")
        .keys()
        .map(String::as_str)
        .collect();
    data_keys.sort_unstable();
    assert_eq!(
        data_keys,
        ["calls", "debit_id", "model", "price", "token_id"]
    );
    assert_eq!(data["price"], MAX_THOUGHT_PRICE.to_string());
    let calls = data["calls"].as_array().expect("calls");
    assert_eq!(calls.len(), 4);
    let kinds: Vec<&str> = calls
        .iter()
        .map(|c| c["sig_kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        ["gateway", "provider_tee", "provider_tee", "provider_tee"]
    );
    for call in calls {
        let mut call_keys: Vec<_> = call
            .as_object()
            .expect("call data")
            .keys()
            .map(String::as_str)
            .collect();
        call_keys.sort_unstable();
        assert_eq!(
            call_keys,
            [
                "cut",
                "req_sha256",
                "res_sha256",
                "sig_kind",
                "signature",
                "signer",
                "tokens_in",
                "tokens_out",
                "tokens_reasoning"
            ]
        );
        assert!(call["req_sha256"].is_string() && call["res_sha256"].is_string());
        assert!(call["signature"].is_string());
    }

    // The treasury +price, the pet's food -price.
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await?,
        treasury_before + MAX_THOUGHT_PRICE
    );
    let view = ctx.pet_view("0").await?;
    assert_eq!(
        amount(&view, "project_food"),
        food_before - MAX_THOUGHT_PRICE
    );
    assert_eq!(view["last_debit_id"], 1);
    Ok(())
}

// spec: add-pet-errands › Errand debit contract › a stolen key bills errands
#[tokio::test]
async fn errand_priced_thoughts_are_bounded_as_any_thought() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.pet_with_food(ONE_NEAR, 0).await?;

    // A caller other than the server fails, whatever the thought carries.
    let before = debit_state(&ctx).await?;
    let stolen = ctx
        .debit_as(&ctx.funder, "0", 1, vec![errand_thought(MAX_THOUGHT_PRICE)])
        .await?;
    assert_refused(&stolen, "not_server");
    assert_eq!(debit_state(&ctx).await?, before);
    assert!(event_logs(&stolen).is_empty());

    // 0.005 NEAR + 1 yocto in a four-call thought fails the whole batch.
    let over = ctx
        .debit(
            "0",
            1,
            vec![errand_thought(1_000), errand_thought(MAX_THOUGHT_PRICE + 1)],
        )
        .await?;
    assert_refused(&over, "price_over_cap");
    assert_eq!(debit_state(&ctx).await?, before);
    assert!(event_logs(&over).is_empty());

    // Exactly 0.005 NEAR passes, ten of them reach the day's cap, one yocto more does not.
    for id in 1..=2u64 {
        ctx.debit(
            "0",
            id,
            (0..5).map(|_| errand_thought(MAX_THOUGHT_PRICE)).collect(),
        )
        .await?
        .into_result()?;
    }
    assert_eq!(
        amount(&ctx.pet_view("0").await?, "debited_today"),
        DAILY_CAP
    );
    let capped = ctx.debit("0", 3, vec![errand_thought(1)]).await?;
    assert_refused(&capped, "daily_cap");
    assert!(event_logs(&capped).is_empty());
    assert_eq!(ctx.pet_view("0").await?["last_debit_id"], 2);
    Ok(())
}

/// The log bytes of one four-call receipt at the longest field lengths and the gas of 12 such
/// thoughts; the numbers go to design.md › Контракт › Gas and logs. The Worker's size bound
/// (`nextBatch`) is set from them.
// spec: add-pet-errands › Errand debit contract › errand recorded
#[tokio::test]
async fn gas_and_logs_of_four_call_receipts() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(ONE_NEAR, 0).await?;
    let last: u64 = 9_999_999_999_999_999_900;
    ctx.set_pet("0", |pet| pet.last_debit_id = last).await?;

    let long_call = |kind: &str| {
        json!({
            "req_sha256": "a".repeat(64),
            "res_sha256": "b".repeat(64),
            "signature": format!("0x{}", "c".repeat(130)),
            "sig_kind": kind,
            "signer": format!("0x{}", "d".repeat(64)),
            "tokens_in": 4_294_967_295u64,
            "tokens_out": 4_294_967_295u64,
            "tokens_reasoning": 4_294_967_295u64,
            "cut": false,
        })
    };
    let long_thought = json!({
        "model": "m".repeat(64),
        "price": "1000000000000000000000",
        "calls": [long_call("gateway"), long_call("provider_tee"), long_call("provider_tee"), long_call("provider_tee")],
    });

    // One receipt: its log bytes, plus 19 for a 20-digit token_id.
    let one = ctx.debit("0", last + 1, vec![long_thought.clone()]).await?;
    assert!(one.is_success(), "{:?}", one.failures());
    let one_bytes: usize = one.logs().iter().map(|l| l.len()).sum::<usize>() + 19;
    let one_gas = one.outcomes()[1].gas_burnt.as_gas();
    eprintln!(
        "gas_and_logs_of_four_call_receipts: one receipt {one_bytes} bytes of logs, debit_session gas {one_gas}"
    );
    assert!(
        one_bytes * 12 > 16 * 1024,
        "12 four-call receipts are expected over the 16 kB log limit"
    );
    let fits = (16 * 1024) / one_bytes;
    eprintln!("gas_and_logs_of_four_call_receipts: {fits} thoughts fit 16 kB, 12 do not");

    // The biggest batch under the limit passes; 12 of them fit the gas of the call, not the logs.
    let ok = ctx
        .debit("0", last + 2, vec![long_thought.clone(); fits])
        .await?;
    assert!(ok.is_success(), "{:?}", ok.failures());
    let ok_gas = ok.outcomes()[1].gas_burnt.as_gas();
    eprintln!(
        "gas_and_logs_of_four_call_receipts: {fits} thoughts, debit_session gas {ok_gas}, whole tx {}",
        ok.total_gas_burnt.as_gas()
    );
    let twelve = ctx.debit("0", last + 3, vec![long_thought; 12]).await?;
    assert!(
        twelve.is_failure(),
        "12 four-call receipts are over the log limit"
    );
    eprintln!(
        "gas_and_logs_of_four_call_receipts: the 12-thought failure: {}",
        failure_text(&twelve)
    );
    eprintln!(
        "gas_and_logs_of_four_call_receipts: 12 thoughts, success {}, debit_session gas {}, whole tx {}",
        twelve.is_success(),
        twelve.outcomes()[1].gas_burnt.as_gas(),
        twelve.total_gas_burnt.as_gas()
    );
    assert!(twelve.total_gas_burnt.as_gas() < 300_000_000_000_000);
    Ok(())
}
