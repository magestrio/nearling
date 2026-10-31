mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use nearling_contract::limits::{DAILY_CAP, KNOWN_RECORD_BYTES, MIN_FEED, STARTER_FOOD};
use serde_json::{Value, json};

const CHARACTER: &str = "I am curious about everything.";
/// The byte price of storage: 1e19 yocto.
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// 0.001 NEAR: what a Tgas costs up front.
const MILLI_NEAR: u128 = 1_000_000_000_000_000_000_000;
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

fn food(view: &Value, field: &str) -> u128 {
    view[field].as_str().unwrap().parse().unwrap()
}

// spec: add-feeding › Pet feed contract › меньше минимума
#[tokio::test]
async fn a_deposit_one_yocto_under_the_minimum_fails_and_comes_back() -> anyhow::Result<()> {
    let ctx = with_pet(BIG_POOL).await?;
    let bob = ctx.account("bob", 10).await?;
    let before_pet = ctx.pet_view("0").await?;
    let before_pool = ctx.pool().await?;
    let before_storage = ctx.storage_usage().await?;
    let bob_before = ctx.balance_of(bob.id()).await?;

    let refused = ctx.feed_as(&bob, "0", MIN_FEED - 1).await?;
    assert_refused(&refused, "feed_too_small");
    assert_eq!(ctx.pet_view("0").await?, before_pet);
    assert_eq!(ctx.pool().await?, before_pool);
    assert_eq!(ctx.storage_usage().await?, before_storage);
    assert!(!ctx.knows("0", bob.id().as_str()).await?);
    // The deposit came back: bob lost the gas of the call, a small part of the deposit.
    let lost = bob_before - ctx.balance_of(bob.id()).await?;
    assert!(
        lost < MIN_FEED / 10,
        "bob lost {lost}, the deposit {MIN_FEED}"
    );
    assert!(event_logs(&refused).is_empty());

    // The minimum passes.
    ctx.feed_as(&bob, "0", MIN_FEED).await?.into_result()?;
    assert_eq!(food(&ctx.pet_view("0").await?, "given_food"), MIN_FEED);
    Ok(())
}

// spec: add-feeding › Pet feed contract › нет такого питомца
#[tokio::test]
async fn feeding_a_token_that_does_not_exist_fails_and_comes_back() -> anyhow::Result<()> {
    let ctx = with_pet(BIG_POOL).await?;
    let bob = ctx.account("bob", 10).await?;
    let before = ctx.snapshot("alice.near").await?;
    let pool = ctx.pool().await?;
    let bob_before = ctx.balance_of(bob.id()).await?;

    let refused = ctx.feed_as(&bob, "7", MIN_FEED).await?;
    assert_refused(&refused, "no_pet");
    assert_eq!(ctx.snapshot("alice.near").await?, before);
    assert_eq!(ctx.pool().await?, pool);
    let lost = bob_before - ctx.balance_of(bob.id()).await?;
    assert!(
        lost < MIN_FEED / 10,
        "bob lost {lost}, the deposit {MIN_FEED}"
    );
    assert!(!ctx.knows("7", bob.id().as_str()).await?);
    Ok(())
}

/// A friend's meal: the food, the event, the balances, the acquaintance and its price from the pool.
#[tokio::test]
async fn a_friends_meal_feeds_the_pet_and_the_pool_pays_the_acquaintance() -> anyhow::Result<()> {
    let ctx = with_pet(BIG_POOL).await?;
    let bob = ctx.account("bob", 100).await?;
    let deposit = 3 * NEAR;
    let pet_before = ctx.pet_view("0").await?;
    let pool_before = ctx.pool().await?;
    let bob_before = ctx.balance_of(bob.id()).await?;
    let contract_before = ctx.contract_balance().await?;

    let finished = ctx.feed_as(&bob, "0", deposit).await?;
    let events = event_logs(&finished);
    let result = finished.into_result()?;
    assert!(result.json::<bool>()?, "a new acquaintance was written");

    let pet = ctx.pet_view("0").await?;
    assert_eq!(
        food(&pet, "given_food"),
        food(&pet_before, "given_food") + deposit
    );
    assert_eq!(food(&pet, "project_food"), STARTER_FOOD);
    assert_eq!(ctx.pool().await?, pool_before - KNOWN_COST);
    assert!(ctx.knows("0", bob.id().as_str()).await?);

    // The balances: the feeder paid the deposit and the gas it bought up front (30 Tgas here), the
    // contract holds the deposit.
    let bob_lost = bob_before - ctx.balance_of(bob.id()).await?;
    assert!(
        bob_lost >= deposit && bob_lost < deposit + NEAR / 20,
        "bob lost {bob_lost} for the deposit {deposit}"
    );
    let contract_gain = ctx.contract_balance().await? - contract_before;
    assert!(contract_gain >= deposit && contract_gain < deposit + NEAR / 100);

    assert_eq!(events.len(), 1, "{events:?}");
    let event: Value = serde_json::from_str(&events[0])?;
    assert_eq!(event["standard"], "nearling");
    assert_eq!(event["version"], "1.0.0");
    assert_eq!(event["event"], "feed");
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "feeder": bob.id().to_string(), "amount": deposit.to_string() })
    );

    // A second meal of the same feeder writes no second record.
    let pool_after_first = ctx.pool().await?;
    let storage_after_first = ctx.storage_usage().await?;
    let second = ctx.feed_as(&bob, "0", MIN_FEED).await?.into_result()?;
    assert!(!second.json::<bool>()?);
    assert_eq!(ctx.pool().await?, pool_after_first);
    assert_eq!(ctx.storage_usage().await?, storage_after_first);
    assert_eq!(
        food(&ctx.pet_view("0").await?, "given_food"),
        deposit + MIN_FEED
    );
    Ok(())
}

/// The owner's meal feeds the pet and never makes the owner "known"; no cap on the deposit.
#[tokio::test]
async fn the_owners_meal_writes_no_acquaintance() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    // The pet belongs to a real sandbox account, so it can sign.
    let alice = ctx.account("alice", 100).await?;
    ctx.mint(alice.id().as_str(), "Pixel", CHARACTER)
        .await?
        .into_result()?;
    let pool = ctx.pool().await?;
    let storage = ctx.storage_usage().await?;
    let big = 40 * NEAR;
    let finished = ctx.feed_as(&alice, "0", big).await?.into_result()?;
    assert!(!finished.json::<bool>()?);
    assert_eq!(
        food(&ctx.pet_view("0").await?, "given_food"),
        big,
        "no upper bound"
    );
    assert_eq!(ctx.pool().await?, pool);
    assert_eq!(ctx.storage_usage().await?, storage);
    assert!(!ctx.knows("0", alice.id().as_str()).await?);
    Ok(())
}

// spec: add-feeding › Pet feed contract › пул не покрывает знакомство
#[tokio::test]
async fn a_pool_short_of_the_acquaintance_still_takes_the_meal() -> anyhow::Result<()> {
    let ctx = with_pet(0).await?;
    let bob = ctx.account("bob", 10).await?;
    let finished = ctx.feed_as(&bob, "0", MIN_FEED).await?;
    let events = event_logs(&finished);
    let result = finished.into_result()?;
    assert!(!result.json::<bool>()?, "no record was written");
    assert_eq!(food(&ctx.pet_view("0").await?, "given_food"), MIN_FEED);
    assert_eq!(events.len(), 1);
    assert!(events[0].contains("\"feed\""));
    assert!(!ctx.knows("0", bob.id().as_str()).await?);
    assert_eq!(ctx.pool().await?, 0);

    // One yocto under the price of the record: still short; at the price: written.
    ctx.fund(KNOWN_COST - 1).await?;
    let carol = ctx.account("carol", 10).await?;
    ctx.feed_as(&carol, "0", MIN_FEED).await?.into_result()?;
    assert!(!ctx.knows("0", carol.id().as_str()).await?);
    assert_eq!(ctx.pool().await?, KNOWN_COST - 1);
    ctx.fund(1).await?;
    let dave = ctx.account("dave", 10).await?;
    let written = ctx.feed_as(&dave, "0", MIN_FEED).await?.into_result()?;
    assert!(written.json::<bool>()?);
    assert!(ctx.knows("0", dave.id().as_str()).await?);
    assert_eq!(ctx.pool().await?, 0);
    // The bytes the pool paid for are the bytes the chain counted.
    let before = ctx.storage_usage().await?;
    ctx.fund(KNOWN_COST).await?;
    let erin = ctx.account("erin", 10).await?;
    let after_account = ctx.storage_usage().await?;
    assert_eq!(after_account, before);
    ctx.feed_as(&erin, "0", MIN_FEED).await?.into_result()?;
    assert_eq!(
        ctx.storage_usage().await? - after_account,
        KNOWN_RECORD_BYTES
    );
    Ok(())
}

/// A meal reaches an asleep pet and a pet at the day's debit cap alike.
#[tokio::test]
async fn an_asleep_pet_and_a_pet_at_the_daily_cap_take_the_meal() -> anyhow::Result<()> {
    let ctx = with_pet(BIG_POOL).await?;
    let bob = ctx.account("bob", 10).await?;
    // Asleep: no food at all.
    ctx.set_pet("0", |pet| {
        pet.project_food = 0;
        pet.given_food = 0;
    })
    .await?;
    ctx.feed_as(&bob, "0", MIN_FEED).await?.into_result()?;
    assert_eq!(food(&ctx.pet_view("0").await?, "given_food"), MIN_FEED);

    // At the cap: today's debits are the whole cap.
    let today = ctx.hatch_view("alice.near").await?["day"].as_u64().unwrap();
    ctx.set_pet("0", |pet| {
        pet.debit_day = today;
        pet.debited_today = DAILY_CAP;
    })
    .await?;
    ctx.feed_as(&bob, "0", MIN_FEED).await?.into_result()?;
    assert_eq!(food(&ctx.pet_view("0").await?, "given_food"), 2 * MIN_FEED);
    Ok(())
}

// spec: add-feeding › Pet knows contract › known account
#[tokio::test]
async fn pet_knows_is_true_after_a_meal_and_after_a_friends_snack_and_writes_nothing()
-> anyhow::Result<()> {
    let ctx = with_pet(BIG_POOL).await?;
    let bob = ctx.account("bob", 10).await?;
    ctx.feed_as(&bob, "0", MIN_FEED).await?.into_result()?;
    ctx.snack("0", "carol.near", "friend")
        .await?
        .into_result()?;

    let storage = ctx.storage_usage().await?;
    let pool = ctx.pool().await?;
    let pet = ctx.pet_view("0").await?;
    assert!(ctx.knows("0", bob.id().as_str()).await?);
    assert!(ctx.knows("0", "carol.near").await?);
    assert_eq!(ctx.storage_usage().await?, storage);
    assert_eq!(ctx.pool().await?, pool);
    assert_eq!(ctx.pet_view("0").await?, pet);
    Ok(())
}

// spec: add-feeding › Pet knows contract › unknown account
#[tokio::test]
async fn pet_knows_is_false_for_a_stranger_an_uncovered_feeder_and_a_missing_token()
-> anyhow::Result<()> {
    let ctx = with_pet(0).await?;
    let bob = ctx.account("bob", 10).await?;
    // The pool did not cover bob's record.
    ctx.feed_as(&bob, "0", MIN_FEED).await?.into_result()?;
    assert!(!ctx.knows("0", bob.id().as_str()).await?);
    // A stranger, the owner, and a token_id that does not exist: false, no panic.
    assert!(!ctx.knows("0", "stranger.near").await?);
    assert!(!ctx.knows("0", "alice.near").await?);
    assert!(!ctx.knows("999", bob.id().as_str()).await?);
    assert!(!ctx.knows("not a token", "stranger.near").await?);
    Ok(())
}

/// The prepaid gas of a feed as the Worker sends it, on the worst case: a 64-character feeder, a
/// new acquaintance. Read from the Worker's source: a test on another number would prove nothing
/// about the transactions that really go out.
#[tokio::test]
async fn gas_of_a_feed() -> anyhow::Result<()> {
    let prepaid = tgas_const("PET_FEED_TGAS");
    let ctx = with_pet(BIG_POOL).await?;
    let long_name = "a".repeat(54); // + ".test.near" = 64 characters
    let feeder = ctx.account(&long_name, 10).await?;
    assert_eq!(feeder.id().as_str().len(), 64);
    let result = ctx
        .feeder_call(&feeder, "0", 100 * MIN_FEED, prepaid)
        .await?;
    let burnt = result.total_gas_burnt.as_gas();
    eprintln!(
        "gas_of_a_feed: burnt {burnt} gas, prepaid {} gas",
        prepaid.as_gas()
    );
    assert!(result.is_success(), "{:?}", result.failures());
    assert!(burnt < prepaid.as_gas());
    assert!(result.json::<bool>()?, "the worst case writes a record");
    Ok(())
}

/// The gas the Worker reserves for a meal, on a wallet that holds exactly the smallest portion and
/// that reserve, as a friend's wallet does after the top-up. The protocol buys the prepaid gas and
/// the receipt's fees up front at 0.001 NEAR a Tgas, so the prepaid gas alone is too little: the
/// node refuses the transaction before anything runs. Both numbers come from the Worker's source.
// spec: add-feeding › Feeding gas data › запас газа доложен
#[tokio::test]
async fn a_wallet_of_exactly_the_portion_and_its_gas_can_feed() -> anyhow::Result<()> {
    let prepaid = tgas_const("PET_FEED_TGAS");
    let reserve =
        (prepaid.as_tgas() + tgas_const("PET_FEED_FEES_TGAS").as_tgas()) as u128 * MILLI_NEAR;
    let ctx = with_pet(BIG_POOL).await?;

    let wallet = ctx.wallet(&"a".repeat(54), MIN_FEED + reserve).await?;
    assert_eq!(wallet.id().as_str().len(), 64);
    assert_eq!(ctx.balance_of(wallet.id()).await?, MIN_FEED + reserve);
    let fed = ctx.feeder_call(&wallet, "0", MIN_FEED, prepaid).await?;
    assert!(fed.is_success(), "{:?}", fed.failures());
    assert_eq!(food(&ctx.pet_view("0").await?, "given_food"), MIN_FEED);

    let short = ctx
        .wallet(
            &"b".repeat(54),
            MIN_FEED + prepaid.as_tgas() as u128 * MILLI_NEAR,
        )
        .await?;
    assert!(
        ctx.feeder_call(&short, "0", MIN_FEED, prepaid)
            .await
            .is_err(),
        "the node takes a wallet holding only the prepaid gas"
    );
    assert_eq!(food(&ctx.pet_view("0").await?, "given_food"), MIN_FEED);
    Ok(())
}

impl Ctx {
    /// An account that holds exactly `yocto`, the way a game wallet does.
    async fn wallet(&self, name: &str, yocto: u128) -> anyhow::Result<near_workspaces::Account> {
        Ok(self
            .worker
            .root_account()?
            .create_subaccount(name)
            .initial_balance(NearToken::from_yoctonear(yocto))
            .transact()
            .await?
            .into_result()?)
    }

    async fn feeder_call(
        &self,
        caller: &near_workspaces::Account,
        token_id: &str,
        deposit: u128,
        gas: Gas,
    ) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
        Ok(caller
            .call(self.contract.id(), "pet_feed")
            .args_json(json!({ "token_id": token_id }))
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(gas)
            .transact()
            .await?)
    }
}
