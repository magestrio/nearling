mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use nearling_contract::limits::{
    FRIEND_SNACKS_PER_DAY, KNOWN_RECORD_BYTES, OWNER_SNACK_EVERY_NS, SNACK_AMOUNT, STARTER_FOOD,
};
use serde_json::{Value, json};

const CHARACTER: &str = "I am curious about everything.";
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// What the pool pays for one acquaintance.
const KNOWN_COST: u128 = KNOWN_RECORD_BYTES as u128 * BYTE_COST;

/// A sandbox with the pet "0" born to `alice.near` and exactly `pool` left in the pool after the
/// birth (the pool is a number in the state; the contract's balance still holds the rest).
async fn with_pet(pool: u128) -> anyhow::Result<Ctx> {
    let ctx = setup(BIG_POOL).await?;
    ctx.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    ctx.set_pool(pool).await?;
    assert_eq!(ctx.pool().await?, pool);
    Ok(ctx)
}

fn amount(view: &Value, field: &str) -> u128 {
    view[field].as_str().unwrap().parse().unwrap()
}

// spec: add-feeding › Pet snack contract › чужой вызов
#[tokio::test]
async fn a_foreign_caller_cannot_give_a_snack_and_a_deposit_is_refused() -> anyhow::Result<()> {
    let ctx = with_pet(BIG_POOL).await?;
    let before = ctx.snapshot("alice.near").await?;
    let pet = ctx.pet_view("0").await?;
    let pool = ctx.pool().await?;

    for (kind, feeder) in [("friend", "bob.near"), ("owner", "alice.near")] {
        let refused = ctx.snack_as(&ctx.funder, "0", feeder, kind).await?;
        assert_refused(&refused, "not_server");
    }
    // The treasury is not the server either.
    let refused = ctx
        .snack_as(&ctx.treasury, "0", "bob.near", "friend")
        .await?;
    assert_refused(&refused, "not_server");

    // The method takes no deposit, not even from the server.
    let with_deposit = ctx
        .server
        .call(ctx.contract.id(), "pet_snack")
        .args_json(json!({ "token_id": "0", "feeder": "bob.near", "kind": "friend" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(with_deposit.is_failure());

    assert_eq!(ctx.snapshot("alice.near").await?, before);
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.pool().await?, pool);
    assert!(!ctx.knows("0", "bob.near").await?);
    Ok(())
}

// spec: add-feeding › Pet snack contract › четвёртый перекус от друзей за сутки
#[tokio::test]
async fn the_third_friends_snack_passes_the_fourth_fails_and_a_new_day_resets() -> anyhow::Result<()>
{
    let ctx = with_pet(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    let mut finished = Vec::new();
    for n in 1..=FRIEND_SNACKS_PER_DAY {
        let result = ctx.snack("0", &format!("friend{n}.near"), "friend").await?;
        finished.push(event_logs(&result));
        let written = result.into_result()?;
        assert!(written.json::<bool>()?, "a new acquaintance each time");
    }
    let pet = ctx.pet_view("0").await?;
    assert_eq!(pet["friend_snacks"], FRIEND_SNACKS_PER_DAY);
    assert_eq!(
        amount(&pet, "project_food"),
        STARTER_FOOD + 3 * SNACK_AMOUNT
    );
    // The event of a friend's snack: the amount, the kind and the friend's account.
    let event: Value = serde_json::from_str(&finished[0][0])?;
    assert_eq!(event["standard"], "nearling");
    assert_eq!(event["event"], "snack");
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "amount": SNACK_AMOUNT.to_string(), "kind": "friend", "friend": "friend1.near" })
    );

    // The fourth fails, from the same friend or another one, and nothing changes.
    let before = ctx.snapshot("alice.near").await?;
    let pool = ctx.pool().await?;
    let refused = ctx.snack("0", "friend4.near", "friend").await?;
    assert_refused(&refused, "snacks_today");
    assert_eq!(ctx.snapshot("alice.near").await?, before);
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.pool().await?, pool);
    assert!(!ctx.knows("0", "friend4.near").await?);

    // 00:00 UTC: the three snacks belong to the day before (the `block_timestamp` boundary itself is
    // the unit test `the_utc_day_resets_the_friends_snacks_at_the_block_timestamp_boundary`).
    let yesterday = pet["friend_snack_day"].as_u64().unwrap() - 1;
    ctx.set_pet("0", |pet| pet.friend_snack_day = yesterday)
        .await?;
    ctx.snack("0", "friend4.near", "friend")
        .await?
        .into_result()?;
    assert_eq!(ctx.pet_view("0").await?["friend_snacks"], 1);
    Ok(())
}

// spec: add-feeding › Pet snack contract › перекус владельцу раньше 72 часов
#[tokio::test]
async fn the_owner_snack_waits_72_hours_from_the_last_one() -> anyhow::Result<()> {
    let ctx = with_pet(BIG_POOL).await?;
    // The first snack passes, and the owner never becomes an acquaintance.
    let first = ctx.snack("0", "alice.near", "owner").await?;
    let events = event_logs(&first);
    let written = first.into_result()?;
    assert!(!written.json::<bool>()?);
    assert!(!ctx.knows("0", "alice.near").await?);
    let event: Value = serde_json::from_str(&events[0])?;
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "amount": SNACK_AMOUNT.to_string(), "kind": "owner" }),
        "no friend in the owner's snack"
    );
    let pet = ctx.pet_view("0").await?;
    assert_eq!(amount(&pet, "project_food"), STARTER_FOOD + SNACK_AMOUNT);
    let taken_at: u64 = pet["owner_snack_at"].as_str().unwrap().parse()?;
    assert!(taken_at > 0);

    // Straight after: refused, nothing changes.
    let before = ctx.snapshot("alice.near").await?;
    let refused = ctx.snack("0", "alice.near", "owner").await?;
    assert_refused(&refused, "snack_too_soon");
    assert_eq!(ctx.snapshot("alice.near").await?, before);
    assert_eq!(ctx.pet_view("0").await?, pet);

    // A minute short of 72 hours: refused. A minute past: passes. (The exact boundary, 72 hours
    // and one nanosecond less, is the unit test
    // `the_owner_snack_passes_at_exactly_72_hours_and_not_a_nanosecond_before`.)
    let now = ctx.block_timestamp().await?;
    let minute = 60_000_000_000u64;
    ctx.set_pet("0", |pet| {
        pet.owner_snack_at = now + minute - OWNER_SNACK_EVERY_NS
    })
    .await?;
    let refused = ctx.snack("0", "alice.near", "owner").await?;
    assert_refused(&refused, "snack_too_soon");
    ctx.set_pet("0", |pet| {
        pet.owner_snack_at = now - minute - OWNER_SNACK_EVERY_NS
    })
    .await?;
    ctx.snack("0", "alice.near", "owner").await?.into_result()?;
    assert_eq!(
        amount(&ctx.pet_view("0").await?, "project_food"),
        STARTER_FOOD + 2 * SNACK_AMOUNT
    );
    Ok(())
}

// spec: add-feeding › Pet snack contract › пул проекта пуст
#[tokio::test]
async fn a_pool_one_yocto_under_the_snack_refuses_and_exactly_the_amount_passes()
-> anyhow::Result<()> {
    let ctx = with_pet(SNACK_AMOUNT - 1).await?;
    let before = ctx.snapshot("alice.near").await?;
    let pet = ctx.pet_view("0").await?;
    for (feeder, kind) in [("bob.near", "friend"), ("alice.near", "owner")] {
        let refused = ctx.snack("0", feeder, kind).await?;
        assert_refused(&refused, "pool_empty");
    }
    assert_eq!(ctx.snapshot("alice.near").await?, before);
    assert_eq!(
        ctx.pet_view("0").await?,
        pet,
        "the counters moved no further"
    );
    assert_eq!(ctx.pool().await?, SNACK_AMOUNT - 1);
    assert!(!ctx.knows("0", "bob.near").await?);

    ctx.fund(1).await?;
    ctx.snack("0", "alice.near", "owner").await?.into_result()?;
    assert_eq!(ctx.pool().await?, 0);
    Ok(())
}

// spec: add-feeding › Pet snack contract › пул не покрывает знакомство
#[tokio::test]
async fn a_pool_that_covers_the_snack_but_not_the_acquaintance_still_gives_the_snack()
-> anyhow::Result<()> {
    // The amount and no room for the record.
    let ctx = with_pet(SNACK_AMOUNT).await?;
    let finished = ctx.snack("0", "bob.near", "friend").await?;
    let events = event_logs(&finished);
    let written = finished.into_result()?;
    assert!(!written.json::<bool>()?);
    let pet = ctx.pet_view("0").await?;
    assert_eq!(amount(&pet, "project_food"), STARTER_FOOD + SNACK_AMOUNT);
    assert_eq!(pet["friend_snacks"], 1);
    assert_eq!(ctx.pool().await?, 0);
    assert!(!ctx.knows("0", "bob.near").await?);
    assert_eq!(events.len(), 1, "{events:?}");
    assert!(events[0].contains("\"snack\"") && events[0].contains("bob.near"));

    // One yocto under the amount plus the record: the snack, not the record; at it: both.
    ctx.set_pool(SNACK_AMOUNT + KNOWN_COST - 1).await?;
    let written = ctx
        .snack("0", "carol.near", "friend")
        .await?
        .into_result()?;
    assert!(!written.json::<bool>()?);
    assert!(!ctx.knows("0", "carol.near").await?);
    assert_eq!(ctx.pool().await?, KNOWN_COST - 1);

    ctx.set_pool(SNACK_AMOUNT + KNOWN_COST).await?;
    let before = ctx.storage_usage().await?;
    let written = ctx.snack("0", "dave.near", "friend").await?.into_result()?;
    assert!(written.json::<bool>()?);
    assert!(ctx.knows("0", "dave.near").await?);
    assert_eq!(ctx.pool().await?, 0);
    assert!(ctx.storage_usage().await? - before >= KNOWN_RECORD_BYTES);

    // A friend who is known already: a snack, no second record.
    ctx.set_pet("0", |pet| pet.friend_snacks = 0).await?;
    ctx.set_pool(BIG_POOL).await?;
    let written = ctx.snack("0", "dave.near", "friend").await?.into_result()?;
    assert!(!written.json::<bool>()?);
    assert_eq!(ctx.pool().await?, BIG_POOL - SNACK_AMOUNT);
    Ok(())
}

// spec: add-feeding › Pet snack contract › перекус владельцу не от владельца
#[tokio::test]
async fn an_owner_snack_for_another_account_fails_and_spends_no_hours() -> anyhow::Result<()> {
    let ctx = with_pet(BIG_POOL).await?;
    let before = ctx.snapshot("alice.near").await?;
    let pet = ctx.pet_view("0").await?;
    let refused = ctx.snack("0", "mallory.near", "owner").await?;
    assert_refused(&refused, "feeder_not_owner");
    assert_eq!(ctx.snapshot("alice.near").await?, before);
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(
        pet["owner_snack_at"], "0",
        "the owner's 72 hours are untouched"
    );
    assert!(!ctx.knows("0", "mallory.near").await?);
    // The owner's own snack still passes afterwards.
    ctx.snack("0", "alice.near", "owner").await?.into_result()?;
    Ok(())
}

/// The prepaid gas of a snack as the Worker sends it, on the worst case: a 64-character friend who
/// is new to the pet, with the pool covering the record. Read from the Worker's source.
#[tokio::test]
async fn gas_of_a_snack() -> anyhow::Result<()> {
    let prepaid: Gas = tgas_const("PET_SNACK_TGAS");
    let ctx = with_pet(BIG_POOL).await?;
    let feeder = "a".repeat(64);
    let result = ctx
        .server
        .call(ctx.contract.id(), "pet_snack")
        .args_json(json!({ "token_id": "0", "feeder": feeder, "kind": "friend" }))
        .gas(prepaid)
        .transact()
        .await?;
    let burnt = result.total_gas_burnt.as_gas();
    eprintln!(
        "gas_of_a_snack: burnt {burnt} gas, prepaid {} gas",
        prepaid.as_gas()
    );
    assert!(result.is_success(), "{:?}", result.failures());
    assert!(burnt < prepaid.as_gas());
    assert!(result.json::<bool>()?);
    Ok(())
}
