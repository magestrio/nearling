mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::Gas;
use near_workspaces::types::NearToken;
use nearling_contract::limits::{
    DAILY_CAP, DAY_NS, HIRE_FEE_MIN, MIN_FEED, OUTFIT_PRICE, STARTER_FOOD,
};
use nearling_contract::pet::VersionedPet;
use serde_json::{Value, json};

const PRICE: u128 = 300_000_000_000_000_000_000;
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn amount(view: &Value, key: &str) -> u128 {
    view[key].as_str().unwrap().parse().unwrap()
}

async fn start(
    ctx: &Ctx,
    caller: &near_workspaces::Account,
    id: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(caller
        .call(ctx.contract.id(), "will_start")
        .args_json(json!({"token_id": id}))
        .transact()
        .await?)
}

async fn release(
    ctx: &Ctx,
    caller: &near_workspaces::Account,
    id: &str,
    amount: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(caller
        .call(ctx.contract.id(), "will_release")
        .args_json(json!({"token_id": id, "amount": amount.to_string()}))
        .transact()
        .await?)
}

async fn wish_buy(
    ctx: &Ctx,
    caller: &near_workspaces::Account,
    id: &str,
    item: u8,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(caller
        .call(ctx.contract.id(), "outfit_buy")
        .args_json(json!({"token_id": id, "item": item, "via_wish": true}))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?)
}

async fn funded_wish(ctx: &Ctx, id: &str) -> anyhow::Result<()> {
    let mut record = ctx.read_record(id).await?.current();
    record.wish_active = true;
    record.wish_reserve = OUTFIT_PRICE;
    ctx.put_record(id, VersionedPet::V7(record)).await
}

// spec: add-pet-will › Wish purchase contract › wish purchase accepted
// spec: add-pet-will › Wish purchase contract › insufficient reserve
#[tokio::test]
async fn wish_buy_spends_only_reserve_and_pays_treasury_once() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(STARTER_FOOD, STARTER_FOOD).await?;
    funded_wish(&ctx, "0").await?;
    let before = ctx.pet_view("0").await?;
    let treasury = ctx.balance_of(ctx.treasury.id()).await?;
    let bought = wish_buy(&ctx, &ctx.server, "0", 3).await?;
    let events = event_logs(&bought);
    assert_eq!(events.len(), 1);
    let event: Value = serde_json::from_str(&events[0])?;
    assert_eq!(event["event"], "outfit");
    assert_eq!(event["data"]["via"], "pet_wish");
    assert_eq!(event["data"]["price"], OUTFIT_PRICE.to_string());
    bought.into_result()?;
    let after = ctx.pet_view("0").await?;
    assert_eq!(after["outfits"], json!([3]));
    assert_eq!(amount(&after, "wish_reserve"), 0);
    assert_eq!(after["wish_active"], false);
    assert_eq!(
        amount(&after, "project_food"),
        amount(&before, "project_food")
    );
    assert_eq!(amount(&after, "given_food"), amount(&before, "given_food"));
    assert_eq!(amount(&after, "debited_today"), OUTFIT_PRICE);
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await? - treasury,
        OUTFIT_PRICE
    );
    assert_refused(&wish_buy(&ctx, &ctx.server, "0", 3).await?, "outfit_owned");

    funded_wish(&ctx, "0").await?;
    let mut record = ctx.read_record("0").await?.current();
    record.wish_reserve = OUTFIT_PRICE - 1;
    ctx.put_record("0", VersionedPet::V7(record)).await?;
    let short = ctx.pet_view("0").await?;
    assert_refused(&wish_buy(&ctx, &ctx.server, "0", 4).await?, "reserve_short");
    assert_eq!(ctx.pet_view("0").await?, short);
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await? - treasury,
        OUTFIT_PRICE
    );
    Ok(())
}

// spec: add-pet-will › Wish purchase contract › daily cap reached
#[tokio::test]
async fn wish_buy_obeys_exact_cap_and_next_utc_day() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.pet_with_food(STARTER_FOOD, 0).await?;
    funded_wish(&ctx, "0").await?;
    let today = ctx.block_timestamp().await? / DAY_NS;
    ctx.set_pet("0", |pet| {
        pet.debit_day = today;
        pet.debited_today = DAILY_CAP - OUTFIT_PRICE + 1;
    })
    .await?;
    let before = ctx.pet_view("0").await?;
    assert_refused(&wish_buy(&ctx, &ctx.server, "0", 3).await?, "daily_cap");
    assert_eq!(ctx.pet_view("0").await?, before);
    ctx.set_pet("0", |pet| pet.debited_today = DAILY_CAP - OUTFIT_PRICE)
        .await?;
    wish_buy(&ctx, &ctx.server, "0", 3).await?.into_result()?;
    assert_eq!(
        amount(&ctx.pet_view("0").await?, "debited_today"),
        DAILY_CAP
    );
    funded_wish(&ctx, "0").await?;
    assert_refused(&wish_buy(&ctx, &ctx.server, "0", 4).await?, "daily_cap");
    ctx.set_pet("0", |pet| pet.debit_day = today - 1).await?;
    wish_buy(&ctx, &ctx.server, "0", 4).await?.into_result()?;
    assert_eq!(
        amount(&ctx.pet_view("0").await?, "debited_today"),
        OUTFIT_PRICE
    );
    Ok(())
}

// spec: add-pet-will › Wish purchase contract › paused after gift
// spec: add-pet-will › Will transfer contract › gift keeps reserve
#[tokio::test]
async fn transfer_pauses_wish_but_new_owner_can_resume() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let alice = ctx.account("alice", 20).await?;
    let bob = ctx.account("bob", 20).await?;
    ctx.mint(alice.id().as_str(), "Pixel", "Calm")
        .await?
        .into_result()?;
    funded_wish(&ctx, "0").await?;
    let transferred = alice
        .call(ctx.contract.id(), "nft_transfer")
        .args_json(
            json!({"receiver_id": bob.id(), "token_id": "0", "approval_id": null, "memo": null}),
        )
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    transferred.into_result()?;
    let paused = ctx.pet_view("0").await?;
    assert_eq!(amount(&paused, "wish_reserve"), OUTFIT_PRICE);
    assert_eq!(paused["wish_active"], false);
    assert_eq!(ctx.nft_token("0").await?["owner_id"], bob.id().as_str());
    assert_refused(&wish_buy(&ctx, &ctx.server, "0", 3).await?, "wish_paused");
    assert_eq!(ctx.pet_view("0").await?, paused);
    start(&ctx, &ctx.server, "0").await?.into_result()?;
    wish_buy(&ctx, &ctx.server, "0", 3).await?.into_result()?;
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([3]));
    Ok(())
}

// spec: add-pet-will › Wish purchase contract › wish purchase accepted
#[tokio::test]
async fn wish_buy_rejects_wrong_caller_and_non_sale_item() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(STARTER_FOOD, 0).await?;
    funded_wish(&ctx, "0").await?;
    let before = ctx.pet_view("0").await?;
    assert_refused(&wish_buy(&ctx, &ctx.funder, "0", 3).await?, "not_server");
    assert_refused(&wish_buy(&ctx, &ctx.server, "0", 2).await?, "not_for_sale");
    assert_eq!(ctx.pet_view("0").await?, before);
    Ok(())
}

// spec: add-pet-will › Will reserve contract › start accepted × gas
// spec: add-pet-will › Wish release contract › release accepted × gas
// spec: add-pet-will › Wish purchase contract › wish purchase accepted × gas
#[tokio::test]
async fn will_calls_fit_the_server_gas_budget() -> anyhow::Result<()> {
    fn contract_gas(result: &ExecutionFinalResult) -> u64 {
        result
            .outcomes()
            .iter()
            .map(|outcome| outcome.gas_burnt.as_gas())
            .max()
            .unwrap()
    }
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(STARTER_FOOD, 0).await?;
    let started = start(&ctx, &ctx.server, "0").await?;
    let start_gas = contract_gas(&started);
    started.into_result()?;
    funded_wish(&ctx, "0").await?;
    let released = release(&ctx, &ctx.server, "0", 1).await?;
    let release_gas = contract_gas(&released);
    released.into_result()?;
    funded_wish(&ctx, "0").await?;
    let bought = wish_buy(&ctx, &ctx.server, "0", 3).await?;
    let buy_gas = contract_gas(&bought);
    bought.into_result()?;
    eprintln!("will gas: start={start_gas} release={release_gas} buy={buy_gas}");
    assert!(start_gas < Gas::from_tgas(5).as_gas());
    assert!(release_gas < Gas::from_tgas(5).as_gas());
    assert!(buy_gas < Gas::from_tgas(5).as_gas());
    Ok(())
}

// spec: add-pet-will › Will reserve contract › earning saved × twelve hires gas and logs
#[tokio::test]
async fn twelve_wish_hires_fit_batch_gas_and_event_limits() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.pet_with_food(STARTER_FOOD, 100 * HIRE_FEE_MIN).await?;
    for n in 1..=12 {
        let id = n.to_string();
        ctx.mint(&format!("worker{n}.near"), "Nori", "I am calm.")
            .await?
            .into_result()?;
        start(&ctx, &ctx.server, &id).await?.into_result()?;
    }
    let batch: Vec<Value> = (1..=12)
        .map(|n| hired_json(PRICE, &n.to_string(), Some(("player", HIRE_FEE_MIN, false))))
        .collect();
    let result = ctx.debit("0", 1, batch).await?;
    let gas = result
        .outcomes()
        .iter()
        .map(|outcome| outcome.gas_burnt.as_gas())
        .max()
        .unwrap();
    let logs = event_logs(&result);
    let bytes: usize = logs.iter().map(String::len).sum();
    eprintln!("12 wish hires: gas={gas} logs={} bytes={bytes}", logs.len());
    result.into_result()?;
    assert_eq!(logs.len(), 24);
    assert!(bytes <= 16_384);
    // server/src/debit.ts gasFor(12, 12, 0, 12) currently sends 27 Tgas.
    assert!(gas < Gas::from_tgas(27).as_gas());
    Ok(())
}

// spec: add-pet-will › Will reserve contract › start accepted
// spec: add-pet-will › Will reserve contract › wrong caller
// spec: add-pet-will › Will reserve contract › unknown pet
// spec: add-pet-will › Wish view contract › public reserve read
#[tokio::test]
async fn start_is_server_only_idempotent_and_public_without_private_words() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(STARTER_FOOD, 0).await?;
    let before = ctx.pet_view("0").await?;
    let wrong = start(&ctx, &ctx.funder, "0").await?;
    assert_refused(&wrong, "not_server");
    assert_eq!(ctx.pet_view("0").await?, before);
    let pool = ctx.pool().await?;
    let treasury = ctx.balance_of(ctx.treasury.id()).await?;
    let missing = start(&ctx, &ctx.server, "999").await?;
    assert_refused(&missing, "no_pet");
    assert_eq!(ctx.pool().await?, pool);
    let deposited = ctx
        .server
        .call(ctx.contract.id(), "will_start")
        .args_json(json!({"token_id": "0"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert_refused(&deposited, "doesn't accept deposit");
    assert_eq!(ctx.pet_view("0").await?, before);
    let started = start(&ctx, &ctx.server, "0").await?;
    assert!(event_logs(&started).is_empty());
    started.into_result()?;
    let first = ctx.pet_view("0").await?;
    assert_eq!(first["wish_active"], true);
    assert_eq!(amount(&first, "wish_reserve"), 0);
    for private in ["target", "reason", "invitation"] {
        assert!(first.get(private).is_none());
    }
    start(&ctx, &ctx.server, "0").await?.into_result()?;
    assert_eq!(ctx.pet_view("0").await?, first);
    assert_eq!(ctx.pool().await?, pool);
    assert_eq!(ctx.balance_of(ctx.treasury.id()).await?, treasury);
    Ok(())
}

// spec: add-pet-will › Will reserve contract › earning saved
// spec: add-pet-will › Will reserve contract › bounded saving
#[tokio::test]
async fn accepted_hires_save_at_most_quarter_of_net_and_preserve_total_food() -> anyhow::Result<()>
{
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(STARTER_FOOD, 2 * HIRE_FEE_MIN).await?;
    ctx.mint("bob.near", "Nori", "I am calm.")
        .await?
        .into_result()?;
    ctx.set_pet("1", |pet| pet.project_food = 2 * STARTER_FOOD)
        .await?;
    start(&ctx, &ctx.server, "1").await?.into_result()?;
    let before = ctx.pet_view("1").await?;
    let net = HIRE_FEE_MIN - PRICE;
    let batch = vec![
        hired_json(PRICE, "1", Some(("player", HIRE_FEE_MIN, false))),
        hired_json(PRICE, "1", Some(("player", HIRE_FEE_MIN, false))),
    ];
    let result = ctx.debit("0", 1, batch.clone()).await?;
    assert_eq!(
        event_logs(&result).len(),
        4,
        "existing receipt and hire events only"
    );
    result.into_result()?;
    let after = ctx.pet_view("1").await?;
    assert_eq!(amount(&after, "wish_reserve"), 2 * (net / 4));
    assert_eq!(
        amount(&after, "given_food"),
        amount(&before, "given_food") + 2 * (net - net / 4)
    );
    assert_eq!(
        amount(&after, "given_food") + amount(&after, "wish_reserve"),
        amount(&before, "given_food") + 2 * net
    );
    let replay = ctx.debit("0", 1, batch).await?;
    assert_refused(&replay, "bad_debit_id");
    assert_eq!(ctx.pet_view("1").await?, after);
    Ok(())
}

// spec: add-pet-will › Reserved food invariant contract › ordinary debit cannot spend reserve
#[tokio::test]
async fn ordinary_debit_cannot_take_reserved_food() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(STARTER_FOOD, 2 * HIRE_FEE_MIN).await?;
    ctx.mint("bob.near", "Nori", "I am calm.")
        .await?
        .into_result()?;
    ctx.set_pet("1", |pet| pet.project_food = 2 * STARTER_FOOD)
        .await?;
    start(&ctx, &ctx.server, "1").await?.into_result()?;
    ctx.debit(
        "0",
        1,
        vec![hired_json(
            PRICE,
            "1",
            Some(("player", HIRE_FEE_MIN, false)),
        )],
    )
    .await?
    .into_result()?;
    let before = ctx.pet_view("1").await?;
    ctx.set_pet("1", |pet| {
        pet.project_food = 0;
        pet.given_food = 0;
    })
    .await?;
    let held = ctx.pet_view("1").await?;
    let refused = ctx.debit("1", 1, vec![thought_json(1)]).await?;
    assert_refused(&refused, "over_food");
    assert_eq!(ctx.pet_view("1").await?, held);
    assert_eq!(
        amount(&held, "wish_reserve"),
        amount(&before, "wish_reserve")
    );
    let today = ctx.block_timestamp().await? / DAY_NS;
    ctx.set_pet("1", |pet| {
        pet.given_food = 1;
        pet.debit_day = today;
        pet.debited_today = DAILY_CAP;
    })
    .await?;
    let capped = ctx.pet_view("1").await?;
    assert_refused(
        &ctx.debit("1", 1, vec![thought_json(1)]).await?,
        "daily_cap",
    );
    assert_eq!(ctx.pet_view("1").await?, capped);
    ctx.set_pet("1", |pet| pet.debited_today = DAILY_CAP - 1)
        .await?;
    let treasury = ctx.balance_of(ctx.treasury.id()).await?;
    ctx.debit("1", 1, vec![thought_json(1)])
        .await?
        .into_result()?;
    let after = ctx.pet_view("1").await?;
    assert_eq!(
        amount(&after, "wish_reserve"),
        amount(&held, "wish_reserve")
    );
    assert_eq!(amount(&after, "debited_today"), DAILY_CAP);
    assert_eq!(ctx.balance_of(ctx.treasury.id()).await? - treasury, 1);
    Ok(())
}

// spec: add-pet-will › Reserved food invariant contract › ordinary debit cannot spend reserve × Feeding
// spec: add-pet-will › Reserved food invariant contract › ordinary debit cannot spend reserve × Snack
#[tokio::test]
async fn feeding_and_snack_leave_the_wish_bucket_untouched() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(0, 0).await?;
    let mut pet = ctx.read_record("0").await?.current();
    pet.wish_reserve = 1_000;
    pet.wish_active = true;
    ctx.put_record("0", VersionedPet::V7(pet)).await?;
    ctx.feed_as(&ctx.funder, "0", nearling_contract::limits::MIN_FEED)
        .await?
        .into_result()?;
    ctx.snack("0", "friend.near", "friend")
        .await?
        .into_result()?;
    let after = ctx.pet_view("0").await?;
    assert_eq!(amount(&after, "wish_reserve"), 1_000);
    assert_eq!(
        amount(&after, "given_food"),
        nearling_contract::limits::MIN_FEED
    );
    assert_eq!(
        amount(&after, "project_food"),
        nearling_contract::limits::SNACK_AMOUNT
    );
    Ok(())
}

// spec: add-pet-will › Reserved food invariant contract › ordinary debit cannot spend reserve × Shared errand
#[tokio::test]
async fn linked_errand_spends_its_linked_meal_and_leaves_wish_reserve() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(0, 0).await?;
    let mut pet = ctx.read_record("0").await?.current();
    pet.wish_reserve = 1_000_000_000_000_000_000_000;
    pet.wish_active = true;
    ctx.put_record("0", VersionedPet::V7(pet)).await?;
    let allowance = 1_000_000_000_000_000_000_000u128;
    ctx.server
        .call(ctx.contract.id(), "shared_job_open")
        .args_json(
            json!({"token_id":"0", "job_hash":HASH, "allowance_yocto":allowance.to_string()}),
        )
        .transact()
        .await?
        .into_result()?;
    ctx.funder
        .call(ctx.contract.id(), "pet_feed")
        .args_json(json!({"token_id":"0", "job_hash":HASH}))
        .deposit(NearToken::from_yoctonear(
            nearling_contract::limits::MIN_FEED,
        ))
        .transact()
        .await?
        .into_result()?;
    ctx.server
        .call(ctx.contract.id(), "shared_job_start")
        .args_json(json!({"token_id":"0", "job_hash":HASH}))
        .transact()
        .await?
        .into_result()?;
    let before = ctx.pet_view("0").await?;
    let mut thought = thought_json(allowance);
    thought["job_hash"] = json!(HASH);
    ctx.debit("0", 1, vec![thought]).await?.into_result()?;
    let after = ctx.pet_view("0").await?;
    assert_eq!(
        amount(&after, "wish_reserve"),
        amount(&before, "wish_reserve")
    );
    assert_eq!(
        amount(&before, "given_food") - amount(&after, "given_food"),
        allowance
    );
    assert_eq!(amount(&after, "project_food"), 0);
    Ok(())
}

// spec: add-pet-will › Wish release contract › release accepted
// spec: add-pet-will › Wish release contract › wrong caller
// spec: add-pet-will › Wish release contract › release exceeds reserve
#[tokio::test]
async fn release_returns_exact_reserve_to_same_pet_only() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(STARTER_FOOD, 2 * HIRE_FEE_MIN).await?;
    ctx.mint("bob.near", "Nori", "I am calm.")
        .await?
        .into_result()?;
    ctx.set_pet("1", |pet| pet.project_food = 2 * STARTER_FOOD)
        .await?;
    start(&ctx, &ctx.server, "1").await?.into_result()?;
    ctx.debit(
        "0",
        1,
        vec![hired_json(
            PRICE,
            "1",
            Some(("player", HIRE_FEE_MIN, false)),
        )],
    )
    .await?
    .into_result()?;
    let before = ctx.pet_view("1").await?;
    let saved = amount(&before, "wish_reserve");
    let treasury = ctx.balance_of(ctx.treasury.id()).await?;
    let contract_balance = ctx.contract_balance().await?;
    start(&ctx, &ctx.server, "1").await?.into_result()?;
    assert_eq!(
        ctx.pet_view("1").await?,
        before,
        "repeat start keeps savings"
    );
    let wrong = release(&ctx, &ctx.funder, "1", saved).await?;
    assert_refused(&wrong, "not_server");
    let deposited = ctx
        .server
        .call(ctx.contract.id(), "will_release")
        .args_json(json!({"token_id": "1", "amount": saved.to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert_refused(&deposited, "doesn't accept deposit");
    let excess = release(&ctx, &ctx.server, "1", saved + 1).await?;
    assert_refused(&excess, "reserve_short");
    assert_eq!(ctx.pet_view("1").await?, before);
    let released = release(&ctx, &ctx.server, "1", saved).await?;
    assert!(event_logs(&released).is_empty());
    released.into_result()?;
    let after = ctx.pet_view("1").await?;
    assert_eq!(amount(&after, "wish_reserve"), 0);
    assert_eq!(after["wish_active"], false);
    assert_eq!(
        amount(&after, "given_food"),
        amount(&before, "given_food") + saved
    );
    assert_eq!(ctx.balance_of(ctx.treasury.id()).await?, treasury);
    assert_eq!(ctx.contract_balance().await?, contract_balance);
    Ok(())
}

// spec: add-pet-will › Will reserve contract › start accepted
// spec: add-pet-will › Wish view contract › public reserve read
#[tokio::test]
async fn old_v6_reads_zero_and_first_mutation_stakes_seventeen_bytes() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(STARTER_FOOD, 0).await?;
    let VersionedPet::V7(current) = ctx.read_record("0").await? else {
        panic!("newborn V7")
    };
    ctx.put_record("0", VersionedPet::V6(current.pet)).await?;
    assert_eq!(ctx.pet_view("0").await?["wish_active"], false);
    let before = ctx.storage_usage().await?;
    let pool = ctx.pool().await?;
    ctx.set_pool(0).await?;
    let refused = start(&ctx, &ctx.server, "0").await?;
    assert_refused(&refused, "pool_empty");
    assert_eq!(ctx.storage_usage().await?, before);
    ctx.set_pool(pool).await?;
    start(&ctx, &ctx.server, "0").await?.into_result()?;
    assert_eq!(ctx.storage_usage().await? - before, 17);
    assert_eq!(pool - ctx.pool().await?, 17 * BYTE_COST);
    Ok(())
}

// spec: add-pet-will › Will reserve contract › bounded saving
#[tokio::test]
async fn saving_respects_price_room_and_spendable_floor() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(STARTER_FOOD, 5 * HIRE_FEE_MIN).await?;
    ctx.mint("bob.near", "Nori", "I am calm.")
        .await?
        .into_result()?;
    ctx.set_pet("1", |pet| pet.project_food = 0).await?;
    start(&ctx, &ctx.server, "1").await?.into_result()?;
    ctx.debit(
        "0",
        1,
        vec![hired_json(
            PRICE,
            "1",
            Some(("player", HIRE_FEE_MIN, false)),
        )],
    )
    .await?
    .into_result()?;
    assert_eq!(
        amount(&ctx.pet_view("1").await?, "wish_reserve"),
        0,
        "below 14.5 units"
    );
    ctx.set_pet("1", |pet| pet.project_food = 2 * STARTER_FOOD)
        .await?;
    ctx.debit(
        "0",
        2,
        vec![hired_json(
            PRICE,
            "1",
            Some(("player", HIRE_FEE_MIN, false)),
        )],
    )
    .await?
    .into_result()?;
    let saved = amount(&ctx.pet_view("1").await?, "wish_reserve");
    assert_eq!(saved, (HIRE_FEE_MIN - PRICE) / 4);
    assert!(saved < OUTFIT_PRICE);
    // The target is private; the chain can only bound the one-price reserve. One yocto of room
    // and one yocto above the floor are both accepted exactly, without moving earlier food.
    let mut near_price = ctx.read_record("1").await?.current();
    near_price.wish_reserve = OUTFIT_PRICE - 1;
    near_price.project_food = 2 * STARTER_FOOD;
    near_price.given_food = 0;
    ctx.put_record("1", VersionedPet::V7(near_price)).await?;
    ctx.debit(
        "0",
        3,
        vec![hired_json(
            PRICE,
            "1",
            Some(("player", HIRE_FEE_MIN, false)),
        )],
    )
    .await?
    .into_result()?;
    assert_eq!(
        amount(&ctx.pet_view("1").await?, "wish_reserve"),
        OUTFIT_PRICE
    );
    let net = HIRE_FEE_MIN - PRICE;
    let mut near_floor = ctx.read_record("1").await?.current();
    near_floor.wish_reserve = 0;
    near_floor.given_food = 0;
    near_floor.project_food = STARTER_FOOD * 29 / 24 - net + 1;
    ctx.put_record("1", VersionedPet::V7(near_floor)).await?;
    ctx.debit(
        "0",
        4,
        vec![hired_json(
            PRICE,
            "1",
            Some(("player", HIRE_FEE_MIN, false)),
        )],
    )
    .await?
    .into_result()?;
    assert_eq!(amount(&ctx.pet_view("1").await?, "wish_reserve"), 1);
    Ok(())
}

// spec: add-pet-will › Will reserve contract › bounded saving
#[tokio::test]
async fn linked_worker_food_does_not_raise_the_saving_floor() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.pet_with_food(STARTER_FOOD, 5 * HIRE_FEE_MIN).await?;
    ctx.mint("bob.near", "Nori", "I am calm.")
        .await?
        .into_result()?;
    start(&ctx, &ctx.server, "1").await?.into_result()?;
    ctx.server
        .call(ctx.contract.id(), "shared_job_open")
        .args_json(
            json!({"token_id":"1", "job_hash":HASH, "allowance_yocto":"1000000000000000000000"}),
        )
        .transact()
        .await?
        .into_result()?;
    ctx.funder
        .call(ctx.contract.id(), "pet_feed")
        .args_json(json!({"token_id":"1", "job_hash":HASH}))
        .deposit(NearToken::from_yoctonear(MIN_FEED))
        .transact()
        .await?
        .into_result()?;
    ctx.server
        .call(ctx.contract.id(), "shared_job_start")
        .args_json(json!({"token_id":"1", "job_hash":HASH}))
        .transact()
        .await?
        .into_result()?;
    let net = HIRE_FEE_MIN - PRICE;
    let floor = STARTER_FOOD * 29 / 24;
    ctx.set_pet("1", |pet| {
        pet.project_food = 0;
        pet.given_food = MIN_FEED + floor - net - 1;
    })
    .await?;
    ctx.debit(
        "0",
        1,
        vec![hired_json(
            PRICE,
            "1",
            Some(("player", HIRE_FEE_MIN, false)),
        )],
    )
    .await?
    .into_result()?;
    let after = ctx.pet_view("1").await?;
    assert_eq!(amount(&after, "wish_reserve"), 0);
    assert_eq!(amount(&after, "given_food") - MIN_FEED, floor - 1);
    Ok(())
}
