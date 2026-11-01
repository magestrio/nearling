mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use nearling_contract::limits::MAX_CHARACTER_BYTES;
use serde_json::{Value, json};

const CHARACTER: &str = "I am curious about everything.";

async fn today(ctx: &Ctx) -> anyhow::Result<u64> {
    Ok(ctx.hatch_view("nobody.near").await?["day"]
        .as_u64()
        .unwrap())
}

/// A sandbox, clear of 00:00, with the pet "0" born to `alice.near` thirty days ago by its
/// record, so yesterday is inside its life.
async fn with_old_pet() -> anyhow::Result<Ctx> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    ctx.age_birth_by_days("0", 30).await?;
    Ok(ctx)
}

fn events_of(result: &near_workspaces::result::ExecutionFinalResult) -> Vec<Value> {
    event_logs(result)
        .iter()
        .map(|e| serde_json::from_str(e).unwrap())
        .collect()
}

/// The one event of a mark that earns no item.
fn event_of(result: &near_workspaces::result::ExecutionFinalResult) -> Value {
    let events = event_logs(result);
    assert_eq!(events.len(), 1, "{events:?}");
    serde_json::from_str(&events[0]).unwrap()
}

// spec: add-daily-ritual › Streak contract › сутки засчитаны
#[tokio::test]
async fn a_counted_day_writes_the_streak_the_day_and_the_event_and_no_new_byte()
-> anyhow::Result<()> {
    let ctx = with_old_pet().await?;
    let day = today(&ctx).await?;
    let before = ctx.pet_view("0").await?;
    assert_eq!(before["streak"], 0);
    assert!(before["last_streak_day"].is_null());
    let storage = ctx.storage_usage().await?;
    let pool = ctx.pool().await?;

    let marked = ctx.streak_mark("0", day, 0).await?;
    // The first day earns the crown: the streak event, then the item's (`Earned outfit contract`
    // › «вещь за серию записана»).
    let events = events_of(&marked);
    assert_eq!(events.len(), 2, "{events:?}");
    let event = events[0].clone();
    marked.into_result()?;
    assert_eq!(event["standard"], "nearling");
    assert_eq!(event["version"], "1.0.0");
    assert_eq!(event["event"], "streak");
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "day": day, "streak": 1, "freezes": 1, "spent": 0 })
    );
    let view = ctx.pet_view("0").await?;
    assert_eq!(view["streak"], 1);
    assert_eq!(view["freezes"], 1);
    assert_eq!(view["last_streak_day"], day);

    // The record has a fixed size: the mark writes no byte and moves no money.
    assert_eq!(ctx.storage_usage().await?, storage);
    assert_eq!(ctx.pool().await?, pool);

    // The next day (yesterday's record aged back): +1, nothing spent.
    ctx.age_streak_by_days("0", 1).await?;
    let marked = ctx.streak_mark("0", day, 0).await?;
    let event = event_of(&marked);
    marked.into_result()?;
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "day": day, "streak": 2, "freezes": 1, "spent": 0 })
    );
    Ok(())
}

// spec: add-daily-ritual › Streak contract › чужой вызов
#[tokio::test]
async fn a_foreign_caller_cannot_mark_a_day() -> anyhow::Result<()> {
    let ctx = with_old_pet().await?;
    let day = today(&ctx).await?;
    let owner = ctx.account("keeper", 2).await?;
    ctx.mint(owner.id().as_str(), "Biscuit", CHARACTER)
        .await?
        .into_result()?;
    let pet = ctx.pet_view("0").await?;
    let snapshot = ctx.snapshot("alice.near").await?;

    for caller in [&ctx.funder, &ctx.treasury, &owner] {
        for token in ["0", "1"] {
            let refused = ctx.streak_mark_as(caller, token, day, 0).await?;
            assert_refused(&refused, "not_server");
            assert!(event_logs(&refused).is_empty());
        }
    }
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.pet_view("1").await?["streak"], 0);
    assert_eq!(ctx.snapshot("alice.near").await?, snapshot);

    // The server itself takes no deposit: the method is not payable.
    let with_deposit = ctx
        .server
        .call(ctx.contract.id(), "streak_mark")
        .args_json(json!({ "token_id": "0", "day": day, "skipped": 0 }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(with_deposit.is_failure());
    assert!(event_logs(&with_deposit).is_empty());
    assert_eq!(ctx.pet_view("0").await?, pet);
    Ok(())
}

// spec: add-daily-ritual › Streak contract › второй раз за сутки
#[tokio::test]
async fn a_day_not_after_the_last_counted_one_is_refused_and_changes_nothing() -> anyhow::Result<()>
{
    let ctx = with_old_pet().await?;
    let day = today(&ctx).await?;
    ctx.streak_mark("0", day, 0).await?.into_result()?;
    let marked = ctx.pet_view("0").await?;
    let snapshot = ctx.snapshot("alice.near").await?;

    // The same day again, also as it would come after a gift that day.
    let refused = ctx.streak_mark("0", day, 0).await?;
    assert_refused(&refused, "day_marked");
    assert!(event_logs(&refused).is_empty());
    // An earlier day than the last counted one.
    let refused = ctx.streak_mark("0", day - 1, 0).await?;
    assert_refused(&refused, "day_marked");

    assert_eq!(ctx.pet_view("0").await?, marked);
    assert_eq!(ctx.snapshot("alice.near").await?, snapshot);
    Ok(())
}

// spec: add-daily-ritual › Streak contract › сутки вне окна
#[tokio::test]
async fn a_day_outside_yesterday_and_today_or_before_the_birth_is_refused() -> anyhow::Result<()> {
    let ctx = with_old_pet().await?;
    let day = today(&ctx).await?;
    // A pet born today: yesterday is before its birth.
    let newborn = ctx.account("newborn", 2).await?;
    ctx.mint(newborn.id().as_str(), "Biscuit", CHARACTER)
        .await?
        .into_result()?;
    let pet = ctx.pet_view("0").await?;
    let young = ctx.pet_view("1").await?;
    let snapshot = ctx.snapshot("alice.near").await?;

    for (token, bad) in [
        ("0", day + 1),
        ("0", day + 100),
        ("0", day - 2),
        ("0", day - 20),
        ("0", 0),
        ("1", day - 1),
        ("1", day + 1),
    ] {
        let refused = ctx.streak_mark(token, bad, 0).await?;
        assert_refused(&refused, "bad_day");
        assert!(event_logs(&refused).is_empty());
    }
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.pet_view("1").await?, young);
    assert_eq!(ctx.snapshot("alice.near").await?, snapshot);

    // Yesterday is inside the window for the old pet; the birth day for the new one.
    ctx.streak_mark("0", day - 1, 0).await?.into_result()?;
    ctx.streak_mark("1", day, 0).await?.into_result()?;
    // The real `block_timestamp` boundary is the unit test in `src/lib.rs`.
    Ok(())
}

// spec: add-daily-ritual › Streak contract › лишние сутки без ритуала
#[tokio::test]
async fn skipped_above_the_gap_is_refused_and_the_gap_itself_passes() -> anyhow::Result<()> {
    let ctx = with_old_pet().await?;
    let day = today(&ctx).await?;
    ctx.streak_mark("0", day, 0).await?.into_result()?;
    // Last counted: four days ago. The gap holds the three days between.
    ctx.age_streak_by_days("0", 4).await?;
    let pet = ctx.pet_view("0").await?;
    let snapshot = ctx.snapshot("alice.near").await?;

    let refused = ctx.streak_mark("0", day, 4).await?;
    assert_refused(&refused, "too_many_skipped");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.snapshot("alice.near").await?, snapshot);

    let marked = ctx.streak_mark("0", day, 3).await?;
    let event = event_of(&marked);
    marked.into_result()?;
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "day": day, "streak": 2, "freezes": 1, "spent": 0 })
    );
    Ok(())
}

// spec: add-daily-ritual › Streak contract › сутки засчитаны × freezes cover the gap
#[tokio::test]
async fn a_freeze_covers_a_missed_day_and_the_streak_goes_on() -> anyhow::Result<()> {
    let ctx = with_old_pet().await?;
    let day = today(&ctx).await?;
    ctx.streak_mark("0", day, 0).await?.into_result()?;
    // Counted two days ago: one day between, one freeze.
    ctx.age_streak_by_days("0", 2).await?;
    let marked = ctx.streak_mark("0", day, 0).await?;
    let event = event_of(&marked);
    marked.into_result()?;
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "day": day, "streak": 2, "freezes": 0, "spent": 1 })
    );
    let view = ctx.pet_view("0").await?;
    assert_eq!(
        (view["streak"].as_u64(), view["freezes"].as_u64()),
        (Some(2), Some(0))
    );
    Ok(())
}

// spec: add-daily-ritual › Streak contract › streak restarts
#[tokio::test]
async fn more_missed_days_than_freezes_restart_the_streak_and_spent_is_the_freezes_it_had()
-> anyhow::Result<()> {
    let ctx = with_old_pet().await?;
    let day = today(&ctx).await?;
    ctx.set_pet("0", |pet| {
        pet.streak = 5;
        pet.freezes = 2;
        pet.last_streak_day = day - 5;
        // It has the crown already: the restart to 1 earns nothing, one event.
        pet.give(0);
    })
    .await?;
    let storage = ctx.storage_usage().await?;

    // Four days between, none excused, two freezes: a restart.
    let marked = ctx.streak_mark("0", day, 0).await?;
    let event = event_of(&marked);
    marked.into_result()?;
    assert_eq!(event["event"], "streak");
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "day": day, "streak": 1, "freezes": 0, "spent": 2 })
    );
    let view = ctx.pet_view("0").await?;
    assert_eq!(
        (view["streak"].as_u64(), view["freezes"].as_u64()),
        (Some(1), Some(0))
    );
    assert_eq!(view["last_streak_day"], day);
    // freezes before - spent = freezes after
    assert_eq!(2 - event["data"]["spent"].as_u64().unwrap(), 0);
    assert_eq!(ctx.storage_usage().await?, storage);
    Ok(())
}

/// The prepaid gas of `streak_mark` as the Worker sends it, on the worst cases: a 64-byte owner,
/// the longest character (read and written whole with the record), the first mark, a covered gap
/// and a restart. Read from the Worker's source.
// spec: add-daily-ritual › Streak contract › сутки засчитаны × gas
// spec: add-wardrobe › Earned outfit contract › вещь за серию записана × the gas of a mark
#[tokio::test]
async fn gas_of_a_mark() -> anyhow::Result<()> {
    let prepaid: Gas = tgas_const("STREAK_MARK_TGAS");
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    let receiver = "a".repeat(64);
    let name = "🚀".repeat(8);
    let character = "x".repeat(MAX_CHARACTER_BYTES);
    ctx.mint(&receiver, &name, &character)
        .await?
        .into_result()?;
    ctx.age_birth_by_days("0", 30).await?;
    let day = today(&ctx).await?;

    let mut most = 0;
    for (label, aged) in [("first mark", 0), ("covered gap", 2), ("restart", 6)] {
        if aged > 0 {
            ctx.age_streak_by_days("0", aged).await?;
        }
        let result = ctx
            .streak_mark_with(&ctx.server, "0", day, 0, prepaid)
            .await?;
        let burnt = result.total_gas_burnt.as_gas();
        eprintln!(
            "gas_of_a_mark: {label} burnt {burnt} gas, prepaid {} gas",
            prepaid.as_gas()
        );
        assert!(result.is_success(), "{label}: {:?}", result.failures());
        assert!(burnt < prepaid.as_gas());
        most = most.max(burnt);
    }
    // The third day, the scarf: the second item event of a pet that has the crown.
    ctx.set_pet("0", |pet| {
        pet.streak = 2;
        pet.last_streak_day = day - 1;
    })
    .await?;
    let result = ctx
        .streak_mark_with(&ctx.server, "0", day, 0, prepaid)
        .await?;
    let burnt = result.total_gas_burnt.as_gas();
    eprintln!(
        "gas_of_a_mark: scarf burnt {burnt} gas, prepaid {} gas",
        prepaid.as_gas()
    );
    assert!(result.is_success(), "scarf: {:?}", result.failures());
    assert_eq!(event_logs(&result).len(), 2, "the streak and the scarf");
    assert!(burnt < prepaid.as_gas());
    most = most.max(burnt);
    eprintln!("gas_of_a_mark: most {most} gas");
    Ok(())
}

// spec: add-wardrobe › Earned outfit contract › вещь за серию записана
// spec: add-wardrobe › Earned outfit contract › вещь за серию записана × 1 and 3 days
#[tokio::test]
async fn the_first_and_the_third_day_write_the_crown_and_the_scarf_with_the_streak()
-> anyhow::Result<()> {
    let ctx = with_old_pet().await?;
    let day = today(&ctx).await?;
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([]));
    let storage = ctx.storage_usage().await?;
    let pool = ctx.pool().await?;

    // Day 1: the crown (item 0), after the streak event, in the same transaction.
    let marked = ctx.streak_mark("0", day, 0).await?;
    let events = events_of(&marked);
    marked.into_result()?;
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[0]["event"], "streak");
    assert_eq!(events[1]["standard"], "nearling");
    assert_eq!(events[1]["version"], "1.0.0");
    assert_eq!(events[1]["event"], "outfit");
    assert_eq!(
        events[1]["data"],
        json!({ "token_id": "0", "item": 0, "via": "streak" })
    );
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([0]));

    // Day 2: nothing.
    ctx.age_streak_by_days("0", 1).await?;
    let marked = ctx.streak_mark("0", day, 0).await?;
    let event = event_of(&marked);
    marked.into_result()?;
    assert_eq!(event["data"]["streak"], 2);
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([0]));

    // Day 3: the scarf (item 1).
    ctx.age_streak_by_days("0", 1).await?;
    let marked = ctx.streak_mark("0", day, 0).await?;
    let events = events_of(&marked);
    marked.into_result()?;
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[0]["data"]["streak"], 3);
    assert_eq!(events[1]["event"], "outfit");
    assert_eq!(
        events[1]["data"],
        json!({ "token_id": "0", "item": 1, "via": "streak" })
    );
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([0, 1]));

    // The byte of the items was paid at birth: no new byte, no money from the pool.
    assert_eq!(ctx.storage_usage().await?, storage);
    assert_eq!(ctx.pool().await?, pool);

    // A pet that restarts at 1 without the crown gets it then.
    ctx.set_pet("0", |pet| {
        pet.streak = 5;
        pet.freezes = 0;
        pet.last_streak_day = day - 5;
        pet.outfits = 0;
    })
    .await?;
    let marked = ctx.streak_mark("0", day, 0).await?;
    let events = events_of(&marked);
    marked.into_result()?;
    assert_eq!(events[0]["data"]["streak"], 1);
    assert_eq!(events[1]["data"]["item"], 0);
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([0]));
    Ok(())
}

// spec: add-wardrobe › Earned outfit contract › порог серии снова
#[tokio::test]
async fn a_threshold_met_again_counts_the_streak_and_gives_nothing() -> anyhow::Result<()> {
    let ctx = with_old_pet().await?;
    let day = today(&ctx).await?;
    // The pet has both streak items already and sits one day below the scarf's threshold.
    ctx.set_pet("0", |pet| {
        pet.outfits = 0b11;
        pet.streak = 2;
        pet.freezes = 0;
        pet.last_streak_day = day - 1;
    })
    .await?;

    let marked = ctx.streak_mark("0", day, 0).await?;
    let event = event_of(&marked);
    marked.into_result()?;
    assert_eq!(event["event"], "streak");
    assert_eq!(event["data"]["streak"], 3, "the streak is counted as usual");
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([0, 1]));

    // A break back to 1 meets the crown's threshold again: counted, no second item, one event.
    ctx.set_pet("0", |pet| {
        pet.streak = 5;
        pet.last_streak_day = day - 5;
    })
    .await?;
    let marked = ctx.streak_mark("0", day, 0).await?;
    let event = event_of(&marked);
    marked.into_result()?;
    assert_eq!(event["data"]["streak"], 1);
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([0, 1]));
    Ok(())
}
