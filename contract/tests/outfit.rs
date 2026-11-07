mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use nearling_contract::limits::{DAILY_CAP, MAX_CHARACTER_BYTES, MAX_THOUGHT_PRICE, OUTFIT_PRICE};
use serde_json::{Value, json};

const CHARACTER: &str = "I am curious about everything.";

fn amount(view: &Value, key: &str) -> u128 {
    view[key].as_str().unwrap().parse().unwrap()
}

fn event_of(result: &near_workspaces::result::ExecutionFinalResult) -> Value {
    let events = event_logs(result);
    assert_eq!(events.len(), 1, "{events:?}");
    serde_json::from_str(&events[0]).unwrap()
}

async fn today(ctx: &Ctx) -> anyhow::Result<u64> {
    Ok(ctx.hatch_view("nobody.near").await?["day"]
        .as_u64()
        .unwrap())
}

/// A sandbox clear of 00:00 with the pet "0" of `alice.near`, born one UTC day ago by its
/// record, so a grant is due.
async fn with_aged_pet() -> anyhow::Result<Ctx> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    ctx.age_birth_by_days("0", 1).await?;
    Ok(ctx)
}

/// Everything a refused call must leave as it was.
async fn state(ctx: &Ctx) -> anyhow::Result<Value> {
    let treasury = ctx.balance_of(ctx.treasury.id()).await?;
    Ok(json!({
        "pet": ctx.pet_view("0").await?,
        "treasury": treasury.to_string(),
        "storage": ctx.storage_usage().await?,
        "balance": ctx.contract_balance().await?.to_string(),
    }))
}

/// The same without the treasury's balance, for a test where the treasury itself is a caller and
/// pays the gas of its refused call.
async fn state_but_the_treasury(ctx: &Ctx) -> anyhow::Result<Value> {
    let mut state = state(ctx).await?;
    state.as_object_mut().unwrap().remove("treasury");
    Ok(state)
}

// spec: add-wardrobe › Earned outfit contract › вещь за загадку записана
#[tokio::test]
async fn the_server_gives_the_thinking_cap_the_day_after_the_birth_day() -> anyhow::Result<()> {
    let ctx = with_aged_pet().await?;
    let treasury = ctx.balance_of(ctx.treasury.id()).await?;
    let pool = ctx.pool().await?;
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([]));

    let granted = ctx.outfit_grant("0").await?;
    let event = event_of(&granted);
    granted.into_result()?;
    assert_eq!(event["standard"], "nearling");
    assert_eq!(event["version"], "1.0.0");
    assert_eq!(event["event"], "outfit");
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "item": 2, "via": "riddle" })
    );
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([2]));
    let extra: Value = serde_json::from_str(
        ctx.nft_token("0").await?["metadata"]["extra"]
            .as_str()
            .unwrap(),
    )?;
    assert_eq!(extra["outfits"], json!([2]));

    // The grant takes nothing and pays nothing.
    assert_eq!(ctx.balance_of(ctx.treasury.id()).await?, treasury);
    assert_eq!(ctx.pool().await?, pool);
    Ok(())
}

// spec: add-wardrobe › Earned outfit contract › вещь за загадку записана × no new byte
#[tokio::test]
async fn a_grant_writes_no_new_byte() -> anyhow::Result<()> {
    let ctx = with_aged_pet().await?;
    let storage = ctx.storage_usage().await?;
    let pool = ctx.pool().await?;
    ctx.outfit_grant("0").await?.into_result()?;
    assert_eq!(ctx.storage_usage().await?, storage);
    assert_eq!(ctx.pool().await?, pool, "the pool pays nothing for it");
    Ok(())
}

/// The gas of `outfit_grant` on the worst case: a 64-byte owner, a 32-byte name, the longest
/// character (the record is read and written whole). The number goes to design.md.
// spec: add-wardrobe › Earned outfit contract › вещь за загадку записана × the gas
#[tokio::test]
async fn gas_of_a_grant() -> anyhow::Result<()> {
    let prepaid: Gas = tgas_const("OUTFIT_GRANT_TGAS");
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    let receiver = "a".repeat(64);
    let name = "🚀".repeat(8);
    let character = "x".repeat(MAX_CHARACTER_BYTES);
    ctx.mint(&receiver, &name, &character)
        .await?
        .into_result()?;
    ctx.age_birth_by_days("0", 1).await?;

    let result = ctx.outfit_grant_with(&ctx.server, "0", prepaid).await?;
    let burnt = result.total_gas_burnt.as_gas();
    eprintln!(
        "gas_of_a_grant: burnt {burnt} gas, prepaid {} gas",
        prepaid.as_gas()
    );
    assert!(result.is_success(), "{:?}", result.failures());
    assert!(burnt < prepaid.as_gas());
    Ok(())
}

// spec: add-wardrobe › Earned outfit contract › вещь за загадку записана × a pet that does not exist
#[tokio::test]
async fn a_pet_that_does_not_exist_gets_nothing() -> anyhow::Result<()> {
    let ctx = with_aged_pet().await?;
    let before = state(&ctx).await?;
    assert_refused(&ctx.outfit_grant("77").await?, "no_pet");
    assert_refused(&ctx.outfit_buy("77", 3).await?, "no_pet");
    assert_eq!(state(&ctx).await?, before);
    Ok(())
}

// spec: add-wardrobe › Earned outfit contract › чужой вызов
#[tokio::test]
async fn a_foreign_caller_cannot_grant() -> anyhow::Result<()> {
    let ctx = with_aged_pet().await?;
    let keeper = ctx.account("keeper", 2).await?;
    let before = state_but_the_treasury(&ctx).await?;

    for caller in [&ctx.funder, &ctx.treasury, &keeper] {
        let refused = ctx.outfit_grant_as(caller, "0").await?;
        assert_refused(&refused, "not_server");
        assert!(event_logs(&refused).is_empty());
    }
    // The server itself attaches nothing: the method is not payable.
    let with_deposit = ctx
        .server
        .call(ctx.contract.id(), "outfit_grant")
        .args_json(json!({ "token_id": "0" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(with_deposit.is_failure());
    assert!(event_logs(&with_deposit).is_empty());
    assert_eq!(state_but_the_treasury(&ctx).await?, before);
    Ok(())
}

// spec: add-wardrobe › Earned outfit contract › вещь уже есть
#[tokio::test]
async fn the_item_is_given_once() -> anyhow::Result<()> {
    let ctx = with_aged_pet().await?;
    ctx.outfit_grant("0").await?.into_result()?;
    let before = state(&ctx).await?;

    let refused = ctx.outfit_grant("0").await?;
    assert_refused(&refused, "outfit_owned");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(state(&ctx).await?, before);
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([2]));
    Ok(())
}

// spec: add-wardrobe › Earned outfit contract › раньше срока × the sandbox on the birth day
#[tokio::test]
async fn a_grant_on_the_birth_day_is_refused_and_the_day_after_passes() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    let before = state(&ctx).await?;

    let refused = ctx.outfit_grant("0").await?;
    assert_refused(&refused, "outfit_too_early");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(state(&ctx).await?, before);

    // The birth moved one day back stands in for a clock past 00:00 UTC; the boundary to the
    // nanosecond is the unit test in `src/lib.rs`.
    ctx.age_birth_by_days("0", 1).await?;
    ctx.outfit_grant("0").await?.into_result()?;
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([2]));
    Ok(())
}

/// A pet "0" of `alice.near` with the given food.
async fn with_food(project: u128, given: u128) -> anyhow::Result<Ctx> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.pet_with_food(project, given).await?;
    Ok(ctx)
}

const ONE_NEAR: u128 = NEAR;

// spec: add-wardrobe › Outfit purchase contract › вещь куплена
// spec: add-wardrobe › Outfit purchase contract › вещь куплена × the treasury's balance
// spec: add-wardrobe › Outfit purchase contract › вещь куплена × the event's price
#[tokio::test]
async fn a_purchase_pays_the_price_to_the_treasury_and_writes_the_item_and_the_event()
-> anyhow::Result<()> {
    let ctx = with_food(2_000_000_000_000_000_000_000, 1_000_000_000_000_000_000_000).await?;
    let day = today(&ctx).await?;
    let treasury = ctx.balance_of(ctx.treasury.id()).await?;
    let storage = ctx.storage_usage().await?;

    let bought = ctx.outfit_buy("0", 3).await?;
    let event = event_of(&bought);
    bought.into_result()?;
    assert_eq!(event["standard"], "nearling");
    assert_eq!(event["version"], "1.0.0");
    assert_eq!(event["event"], "outfit");
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "item": 3, "via": "bought", "price": OUTFIT_PRICE.to_string() })
    );
    assert_eq!(OUTFIT_PRICE.to_string(), "1660000000000000000000");

    let view = ctx.pet_view("0").await?;
    assert_eq!(view["outfits"], json!([3]));
    assert_eq!(amount(&view, "debited_today"), OUTFIT_PRICE);
    assert_eq!(view["debit_day"], day);
    // The treasury gets the price, once, and the record keeps its size.
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await?,
        treasury + OUTFIT_PRICE
    );
    assert_eq!(ctx.storage_usage().await?, storage);
    Ok(())
}

// spec: D-152 › ordinary Wardrobe transfer fails after the outfit is recorded
#[tokio::test]
async fn a_failed_ordinary_payout_remains_owed_until_retry() -> anyhow::Result<()> {
    let ctx = with_food(ONE_NEAR, ONE_NEAR).await?;
    let original_treasury = ctx.treasury.id().clone();
    ctx.set_treasury_id("missing.test.near".parse()?).await?;
    let before_food = ctx.pet_view("0").await?;
    let failed = ctx.outfit_buy("0", 3).await?;
    assert!(
        !failed.failures().is_empty(),
        "the named treasury does not exist"
    );
    let after = ctx.pet_view("0").await?;
    assert_eq!(after["outfits"], json!([3]));
    assert_eq!(
        amount(&before_food, "project_food") - amount(&after, "project_food"),
        OUTFIT_PRICE
    );
    assert_eq!(ctx.treasury_owed().await?, OUTFIT_PRICE);
    let retry_failed = ctx.retry_treasury_payout().await?;
    assert!(!retry_failed.failures().is_empty());
    assert_eq!(ctx.treasury_owed().await?, OUTFIT_PRICE);
    ctx.set_treasury_id(original_treasury).await?;
    let treasury_before = ctx.balance_of(ctx.treasury.id()).await?;
    ctx.retry_treasury_payout().await?.into_result()?;
    assert_eq!(ctx.treasury_owed().await?, 0);
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await? - treasury_before,
        OUTFIT_PRICE
    );
    assert_eq!(ctx.pet_view("0").await?, after);
    Ok(())
}

// spec: add-wardrobe › Outfit purchase contract › вещь куплена × project food first
#[tokio::test]
async fn the_price_comes_from_the_project_food_first_then_from_the_given_food() -> anyhow::Result<()>
{
    // The project's food covers the price: the given food is not touched.
    let ctx = with_food(2_000_000_000_000_000_000_000, 1_000_000_000_000_000_000_000).await?;
    ctx.outfit_buy("0", 4).await?.into_result()?;
    let view = ctx.pet_view("0").await?;
    assert_eq!(
        amount(&view, "project_food"),
        2_000_000_000_000_000_000_000 - OUTFIT_PRICE
    );
    assert_eq!(amount(&view, "given_food"), 1_000_000_000_000_000_000_000);

    // The project's food is short: it goes to zero and the given food pays the rest.
    let ctx = with_food(1_000_000_000_000_000_000_000, 5_000_000_000_000_000_000_000).await?;
    ctx.outfit_buy("0", 5).await?.into_result()?;
    let view = ctx.pet_view("0").await?;
    assert_eq!(amount(&view, "project_food"), 0);
    assert_eq!(
        amount(&view, "given_food"),
        5_000_000_000_000_000_000_000 - (OUTFIT_PRICE - 1_000_000_000_000_000_000_000)
    );
    Ok(())
}

// spec: add-wardrobe › Outfit purchase contract › вещь куплена × the daily counter with a debit
#[tokio::test]
async fn the_day_counts_the_thoughts_and_the_purchases_together() -> anyhow::Result<()> {
    let ctx = with_food(0, ONE_NEAR).await?;
    // Thoughts bring the day to the cap minus the price: 9 thoughts of 0.005 NEAR and the rest.
    let rest = DAILY_CAP - OUTFIT_PRICE - 9 * MAX_THOUGHT_PRICE;
    let mut batch = thoughts(9, MAX_THOUGHT_PRICE);
    batch.push(thought_json(rest));
    ctx.debit("0", 1, batch).await?.into_result()?;
    assert_eq!(
        amount(&ctx.pet_view("0").await?, "debited_today"),
        DAILY_CAP - OUTFIT_PRICE
    );

    // The purchase fits to the yocto and takes the day to the cap.
    ctx.outfit_buy("0", 3).await?.into_result()?;
    assert_eq!(
        amount(&ctx.pet_view("0").await?, "debited_today"),
        DAILY_CAP
    );

    // The other way round: now a thought of one yocto and a second purchase are over.
    let before = state(&ctx).await?;
    assert_refused(&ctx.debit("0", 2, thoughts(1, 1)).await?, "daily_cap");
    assert_refused(&ctx.outfit_buy("0", 4).await?, "daily_cap");
    assert_eq!(state(&ctx).await?, before);
    Ok(())
}

/// The gas of `outfit_buy` with its transfer to the treasury, on the worst case: a 64-byte owner,
/// the longest character. The number goes to design.md.
// spec: add-wardrobe › Outfit purchase contract › вещь куплена × the gas
#[tokio::test]
async fn gas_of_a_purchase() -> anyhow::Result<()> {
    let prepaid: Gas = tgas_const("OUTFIT_BUY_TGAS");
    let ctx = setup(BIG_POOL).await?;
    let receiver = "a".repeat(64);
    let name = "🚀".repeat(8);
    let character = "x".repeat(MAX_CHARACTER_BYTES);
    ctx.mint(&receiver, &name, &character)
        .await?
        .into_result()?;
    ctx.set_pet("0", |pet| pet.given_food = ONE_NEAR).await?;

    let result = ctx.outfit_buy_with(&ctx.server, "0", 6, prepaid).await?;
    let burnt = result.total_gas_burnt.as_gas();
    eprintln!(
        "gas_of_a_purchase: burnt {burnt} gas, prepaid {} gas",
        prepaid.as_gas()
    );
    assert!(result.is_success(), "{:?}", result.failures());
    // The purchase and its restoring callback burn gas in separate receipts. The server's
    // five-Tgas call succeeds; the extra callback stays within its two-Tgas allocation.
    assert!(burnt < prepaid.as_gas() + Gas::from_tgas(2).as_gas());
    assert_eq!(ctx.treasury_owed().await?, 0);
    Ok(())
}

// spec: add-wardrobe › Outfit purchase contract › чужой вызов
#[tokio::test]
async fn a_foreign_caller_cannot_buy() -> anyhow::Result<()> {
    let ctx = with_food(ONE_NEAR, ONE_NEAR).await?;
    let keeper = ctx.account("keeper", 2).await?;
    let before = state_but_the_treasury(&ctx).await?;

    for caller in [&ctx.funder, &ctx.treasury, &keeper] {
        let refused = ctx.outfit_buy_as(caller, "0", 3).await?;
        assert_refused(&refused, "not_server");
        assert!(event_logs(&refused).is_empty());
    }
    assert_eq!(state_but_the_treasury(&ctx).await?, before);
    Ok(())
}

// spec: add-wardrobe › Outfit purchase contract › чужой вызов × a deposit
#[tokio::test]
async fn a_purchase_takes_no_deposit() -> anyhow::Result<()> {
    let ctx = with_food(ONE_NEAR, ONE_NEAR).await?;
    let before = state(&ctx).await?;
    let with_deposit = ctx
        .server
        .call(ctx.contract.id(), "outfit_buy")
        .args_json(json!({ "token_id": "0", "item": 3 }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(with_deposit.is_failure());
    assert!(event_logs(&with_deposit).is_empty());
    assert_eq!(state(&ctx).await?, before);
    Ok(())
}

// spec: add-wardrobe › Outfit purchase contract › не покупная вещь
// spec: add-wardrobe › Outfit purchase contract › не покупная вещь × an id over 6
#[tokio::test]
async fn an_earned_item_and_an_id_over_6_are_not_for_sale() -> anyhow::Result<()> {
    let ctx = with_food(ONE_NEAR, ONE_NEAR).await?;
    let before = state(&ctx).await?;
    for item in [0u8, 1, 2, 7, 8, 255] {
        let refused = ctx.outfit_buy("0", item).await?;
        assert_refused(&refused, "not_for_sale");
        assert!(event_logs(&refused).is_empty(), "item {item}");
    }
    assert_eq!(state(&ctx).await?, before);
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([]));
    Ok(())
}

// spec: add-wardrobe › Outfit purchase contract › вещь уже куплена
#[tokio::test]
async fn an_item_the_pet_has_cannot_be_bought_again() -> anyhow::Result<()> {
    let ctx = with_food(ONE_NEAR, ONE_NEAR).await?;
    ctx.outfit_buy("0", 3).await?.into_result()?;
    let before = state(&ctx).await?;

    // The second tap, from another tab: refused, nothing charged.
    let refused = ctx.outfit_buy("0", 3).await?;
    assert_refused(&refused, "outfit_owned");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(state(&ctx).await?, before);

    // The other three still sell.
    for item in [4u8, 5, 6] {
        ctx.outfit_buy("0", item).await?.into_result()?;
    }
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([3, 4, 5, 6]));
    Ok(())
}

// spec: add-wardrobe › Outfit purchase contract › выше суточного лимита
#[tokio::test]
async fn a_price_over_the_daily_cap_is_refused_and_changes_nothing() -> anyhow::Result<()> {
    let ctx = with_food(ONE_NEAR, ONE_NEAR).await?;
    let day = today(&ctx).await?;
    ctx.set_pet("0", |pet| {
        pet.debit_day = day;
        pet.debited_today = DAILY_CAP - OUTFIT_PRICE + 1;
    })
    .await?;
    let before = state(&ctx).await?;

    let refused = ctx.outfit_buy("0", 3).await?;
    assert_refused(&refused, "daily_cap");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(state(&ctx).await?, before);
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([]));
    // The cap passes to the yocto and the next UTC day resets are the unit tests in `src/lib.rs`.
    Ok(())
}

// spec: add-wardrobe › Outfit purchase contract › больше еды питомца
#[tokio::test]
async fn a_price_over_the_food_is_refused_and_the_food_never_goes_below_zero() -> anyhow::Result<()>
{
    let ctx = with_food(1_000_000_000_000_000_000_000, 0).await?;
    ctx.set_pet("0", |pet| {
        pet.given_food = OUTFIT_PRICE - 1_000_000_000_000_000_000_000 - 1;
    })
    .await?;
    let before = state(&ctx).await?;
    let refused = ctx.outfit_buy("0", 3).await?;
    assert_refused(&refused, "over_food");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(state(&ctx).await?, before);
    Ok(())
}

// spec: add-wardrobe › Outfit purchase contract › больше еды питомца × exactly all the food
#[tokio::test]
async fn a_price_equal_to_all_the_food_passes_and_leaves_none() -> anyhow::Result<()> {
    let ctx = with_food(1_000_000_000_000_000_000_000, 0).await?;
    ctx.set_pet("0", |pet| {
        pet.given_food = OUTFIT_PRICE - 1_000_000_000_000_000_000_000;
    })
    .await?;
    ctx.outfit_buy("0", 3).await?.into_result()?;
    let view = ctx.pet_view("0").await?;
    assert_eq!(amount(&view, "project_food"), 0);
    assert_eq!(amount(&view, "given_food"), 0);
    assert_eq!(view["outfits"], json!([3]));
    Ok(())
}
