mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use nearling_contract::limits::RIDDLE_COMMIT_BYTES;
use serde_json::{Value, json};

const BYTE_COST: u128 = 10_000_000_000_000_000_000;
const COMMIT_COST: u128 = RIDDLE_COMMIT_BYTES as u128 * BYTE_COST;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/riddle-hash.json")).unwrap()
}

fn unhex(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn answers_of(fixture: &Value) -> Vec<String> {
    fixture["answers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap().to_string())
        .collect()
}

fn hash_of(day: u64, riddle: &str, answers: &[String], salt: &str) -> [u8; 32] {
    let bytes =
        near_sdk::borsh::to_vec(&(day, riddle.to_string(), answers.to_vec(), salt.to_string()))
            .unwrap();
    let hash = near_sdk::env::sha256(&bytes);
    hash.try_into().unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn today(ctx: &Ctx) -> anyhow::Result<u64> {
    Ok(ctx.hatch_view("nobody.near").await?["day"]
        .as_u64()
        .unwrap())
}

fn reserve_of(view: &Value) -> u128 {
    view["reserve"].as_str().unwrap().parse().unwrap()
}

/// A sandbox clear of 00:00 whose reserve holds `commits` commits.
async fn with_reserve(commits: u128) -> anyhow::Result<Ctx> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    if commits > 0 {
        ctx.fund_riddles(commits * COMMIT_COST)
            .await?
            .into_result()?;
    }
    Ok(ctx)
}

// spec: add-daily-ritual › Riddle commit contract › коммит записан
#[tokio::test]
async fn a_commit_records_the_hash_for_today_and_the_event_and_takes_its_storage_from_the_reserve()
-> anyhow::Result<()> {
    let ctx = with_reserve(3).await?;
    let day = today(&ctx).await?;
    let hash = "ab".repeat(32);
    let storage = ctx.storage_usage().await?;
    let pool = ctx.pool().await?;
    assert_eq!(reserve_of(&ctx.riddle_view(day).await?), 3 * COMMIT_COST);

    let committed = ctx.riddle_commit(&hash).await?;
    let events = event_logs(&committed);
    committed.into_result()?;
    assert_eq!(events.len(), 1, "{events:?}");
    let event: Value = serde_json::from_str(&events[0])?;
    assert_eq!(event["standard"], "nearling");
    assert_eq!(event["version"], "1.0.0");
    assert_eq!(event["event"], "riddle_commit");
    assert_eq!(event["data"], json!({ "day": day, "hash": hash }));

    let view = ctx.riddle_view(day).await?;
    assert_eq!(view["hash"], hash);
    assert_eq!(reserve_of(&view), 2 * COMMIT_COST);
    assert_eq!(view["commit_cost"], COMMIT_COST.to_string());
    // The day after is another day: nothing there.
    assert!(ctx.riddle_view(day + 1).await?["hash"].is_null());

    // The chain counted the record: exactly the bytes the reserve paid for; the pool stays.
    assert_eq!(ctx.storage_usage().await? - storage, RIDDLE_COMMIT_BYTES);
    assert_eq!(ctx.pool().await?, pool);
    Ok(())
}

// spec: add-daily-ritual › Riddle commit contract › коммит записан × a bad hash
#[tokio::test]
async fn a_hash_of_the_wrong_shape_is_refused_and_nothing_is_written() -> anyhow::Result<()> {
    let ctx = with_reserve(3).await?;
    let day = today(&ctx).await?;
    let snapshot = ctx.snapshot("nobody.near").await?;
    let view = ctx.riddle_view(day).await?;

    for bad in [
        String::new(),
        "a".repeat(63),
        "a".repeat(65),
        format!("{}g", "a".repeat(63)),
        format!("0x{}", "a".repeat(62)),
        format!(" {}", "a".repeat(63)),
    ] {
        let refused = ctx.riddle_commit(&bad).await?;
        assert_refused(&refused, "bad_hash");
        assert!(event_logs(&refused).is_empty());
    }
    assert_eq!(ctx.riddle_view(day).await?, view);
    assert_eq!(ctx.snapshot("nobody.near").await?, snapshot);
    Ok(())
}

// spec: add-daily-ritual › Riddle commit contract › чужой вызов
#[tokio::test]
async fn a_foreign_caller_cannot_commit() -> anyhow::Result<()> {
    let ctx = with_reserve(3).await?;
    let day = today(&ctx).await?;
    let snapshot = ctx.snapshot("nobody.near").await?;
    let view = ctx.riddle_view(day).await?;

    for caller in [&ctx.funder, &ctx.treasury] {
        let refused = ctx.riddle_commit_as(caller, &"ab".repeat(32)).await?;
        assert_refused(&refused, "not_server");
        assert!(event_logs(&refused).is_empty());
    }
    // The server takes no deposit either: the method is not payable.
    let with_deposit = ctx
        .server
        .call(ctx.contract.id(), "riddle_commit")
        .args_json(json!({ "hash": "ab".repeat(32) }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(with_deposit.is_failure());
    assert_eq!(ctx.riddle_view(day).await?, view);
    assert_eq!(ctx.snapshot("nobody.near").await?, snapshot);
    Ok(())
}

// spec: add-daily-ritual › Riddle commit contract › второй коммит за сутки
#[tokio::test]
async fn a_second_commit_in_a_utc_day_fails_and_the_first_stays() -> anyhow::Result<()> {
    let ctx = with_reserve(3).await?;
    let day = today(&ctx).await?;
    let first = "11".repeat(32);
    ctx.riddle_commit(&first).await?.into_result()?;
    let view = ctx.riddle_view(day).await?;
    let snapshot = ctx.snapshot("nobody.near").await?;

    // A foreign hash, as a thief with the server's key would send it, and the same one again.
    for hash in ["22".repeat(32), first.clone()] {
        let refused = ctx.riddle_commit(&hash).await?;
        assert_refused(&refused, "commit_today");
        assert!(event_logs(&refused).is_empty());
    }
    assert_eq!(ctx.riddle_view(day).await?, view);
    assert_eq!(view["hash"], first);
    assert_eq!(ctx.snapshot("nobody.near").await?, snapshot);
    // The real `block_timestamp` boundary is the unit test in `src/lib.rs`.
    Ok(())
}

// spec: add-daily-ritual › Riddle commit contract › запас хранилища пуст
#[tokio::test]
async fn a_reserve_below_the_cost_refuses_the_commit_and_leaves_the_pool_and_the_food_alone()
-> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.mint("alice.near", "Pixel", "I am curious.")
        .await?
        .into_result()?;
    let day = today(&ctx).await?;
    let pool = ctx.pool().await?;
    let pet = ctx.pet_view("0").await?;

    // An empty reserve, then one yocto short.
    for reserve in [0, COMMIT_COST - 1] {
        ctx.set_riddle_reserve(reserve).await?;
        let snapshot = ctx.snapshot("alice.near").await?;
        let refused = ctx.riddle_commit(&"ab".repeat(32)).await?;
        assert_refused(&refused, "reserve_empty");
        assert!(event_logs(&refused).is_empty());
        let view = ctx.riddle_view(day).await?;
        assert!(view["hash"].is_null());
        assert_eq!(reserve_of(&view), reserve);
        assert_eq!(ctx.snapshot("alice.near").await?, snapshot);
    }
    assert_eq!(ctx.pool().await?, pool);
    assert_eq!(ctx.pet_view("0").await?, pet);

    // Exactly the cost passes and empties the reserve.
    ctx.set_riddle_reserve(COMMIT_COST).await?;
    ctx.riddle_commit(&"ab".repeat(32)).await?.into_result()?;
    assert_eq!(reserve_of(&ctx.riddle_view(day).await?), 0);
    assert_eq!(ctx.pool().await?, pool);
    Ok(())
}

/// The prepaid gas of `riddle_commit` as the Worker sends it.
// spec: add-daily-ritual › Riddle commit contract › коммит записан × gas
#[tokio::test]
async fn gas_of_a_commit() -> anyhow::Result<()> {
    let prepaid: Gas = tgas_const("RIDDLE_COMMIT_TGAS");
    let ctx = with_reserve(2).await?;
    let result = ctx
        .server
        .call(ctx.contract.id(), "riddle_commit")
        .args_json(json!({ "hash": "ab".repeat(32) }))
        .gas(prepaid)
        .transact()
        .await?;
    let burnt = result.total_gas_burnt.as_gas();
    eprintln!(
        "gas_of_a_commit: burnt {burnt} gas, prepaid {} gas",
        prepaid.as_gas()
    );
    assert!(result.is_success(), "{:?}", result.failures());
    assert!(burnt < prepaid.as_gas());
    Ok(())
}

/// A sandbox with the commit of a past `day` in place and a reserve of two commits: the state a
/// real commit of that day would have left (a sandbox day is a state patch, not 40 minutes).
async fn with_commit(day: u64, hash: [u8; 32]) -> anyhow::Result<Ctx> {
    let ctx = with_reserve(0).await?;
    ctx.put_commit(day, hash).await?;
    ctx.set_riddle_reserve(2 * COMMIT_COST).await?;
    Ok(ctx)
}

// spec: add-daily-ritual › Riddle reveal contract › раскрытие записано
// spec: add-daily-ritual › Riddle reveal contract › раскрытие записано × the reserve back
// spec: add-daily-ritual › Riddle reveal contract › нет нераскрытого коммита × a second reveal
#[tokio::test]
async fn a_reveal_that_hashes_to_the_commit_emits_the_event_deletes_the_record_and_returns_the_storage()
-> anyhow::Result<()> {
    let fixture = fixture();
    let day = fixture["day"].as_u64().unwrap();
    let riddle = fixture["riddle"].as_str().unwrap();
    let answers = answers_of(&fixture);
    let salt = fixture["salt"].as_str().unwrap();
    let ctx = with_commit(day, unhex(fixture["hash"].as_str().unwrap())).await?;
    assert_eq!(ctx.riddle_view(day).await?["hash"], fixture["hash"]);
    let storage = ctx.storage_usage().await?;
    let pool = ctx.pool().await?;
    let reserve = reserve_of(&ctx.riddle_view(day).await?);

    let revealed = ctx
        .riddle_reveal_as(&ctx.server, day, riddle, &answers, salt, Gas::from_tgas(30))
        .await?;
    let events = event_logs(&revealed);
    revealed.into_result()?;
    assert_eq!(events.len(), 1, "{events:?}");
    let event: Value = serde_json::from_str(&events[0])?;
    assert_eq!(event["standard"], "nearling");
    assert_eq!(event["version"], "1.0.0");
    assert_eq!(event["event"], "riddle_reveal");
    assert_eq!(
        event["data"],
        json!({ "day": day, "riddle": riddle, "answers": answers, "salt": salt })
    );

    // The record is gone, its bytes are freed and their price is back in the reserve.
    let view = ctx.riddle_view(day).await?;
    assert!(view["hash"].is_null());
    assert_eq!(reserve_of(&view), reserve + COMMIT_COST);
    assert_eq!(storage - ctx.storage_usage().await?, RIDDLE_COMMIT_BYTES);
    assert_eq!(ctx.pool().await?, pool);

    // A second reveal of the same day finds no unrevealed commit.
    let snapshot = ctx.snapshot("nobody.near").await?;
    let again = ctx
        .riddle_reveal_as(&ctx.server, day, riddle, &answers, salt, Gas::from_tgas(30))
        .await?;
    assert_refused(&again, "no_commit");
    assert!(event_logs(&again).is_empty());
    assert_eq!(
        reserve_of(&ctx.riddle_view(day).await?),
        reserve + COMMIT_COST
    );
    assert_eq!(ctx.snapshot("nobody.near").await?, snapshot);
    Ok(())
}

// spec: add-daily-ritual › Riddle reveal contract › чужой вызов
#[tokio::test]
async fn a_foreign_caller_cannot_reveal() -> anyhow::Result<()> {
    let fixture = fixture();
    let day = fixture["day"].as_u64().unwrap();
    let riddle = fixture["riddle"].as_str().unwrap();
    let answers = answers_of(&fixture);
    let salt = fixture["salt"].as_str().unwrap();
    let ctx = with_commit(day, unhex(fixture["hash"].as_str().unwrap())).await?;
    let view = ctx.riddle_view(day).await?;
    let snapshot = ctx.snapshot("nobody.near").await?;

    for caller in [&ctx.funder, &ctx.treasury] {
        let refused = ctx
            .riddle_reveal_as(caller, day, riddle, &answers, salt, Gas::from_tgas(30))
            .await?;
        assert_refused(&refused, "not_server");
        assert!(event_logs(&refused).is_empty());
    }
    let with_deposit = ctx
        .server
        .call(ctx.contract.id(), "riddle_reveal")
        .args_json(json!({ "day": day, "riddle": riddle, "answers": answers, "salt": salt }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(with_deposit.is_failure());
    assert_eq!(ctx.riddle_view(day).await?, view);
    assert_eq!(ctx.snapshot("nobody.near").await?, snapshot);
    Ok(())
}

// spec: add-daily-ritual › Riddle reveal contract › раскрытие в сутки загадки
#[tokio::test]
async fn a_reveal_in_the_day_of_the_riddle_or_later_is_refused() -> anyhow::Result<()> {
    let ctx = with_reserve(3).await?;
    let day = today(&ctx).await?;
    let riddle = "What has hands but can't clap?";
    let answers = vec!["a clock".to_string()];
    let hash = hash_of(day, riddle, &answers, "salt");
    ctx.riddle_commit(&hex(&hash)).await?.into_result()?;
    let view = ctx.riddle_view(day).await?;
    let snapshot = ctx.snapshot("nobody.near").await?;

    // The right words, the commit of today: not yet, and nothing of them reaches the logs.
    for revealed_day in [day, day + 1] {
        let refused = ctx
            .riddle_reveal_as(
                &ctx.server,
                revealed_day,
                riddle,
                &answers,
                "salt",
                Gas::from_tgas(30),
            )
            .await?;
        assert_refused(&refused, "reveal_too_early");
        assert!(refused.logs().is_empty(), "{:?}", refused.logs());
    }
    assert_eq!(ctx.riddle_view(day).await?, view);
    assert_eq!(ctx.snapshot("nobody.near").await?, snapshot);
    // The real `block_timestamp` boundary is the unit test in `src/lib.rs`.
    Ok(())
}

// spec: add-daily-ritual › Riddle reveal contract › не сходится с коммитом
#[tokio::test]
async fn a_reveal_that_does_not_hash_to_the_commit_leaves_it_unrevealed() -> anyhow::Result<()> {
    let fixture = fixture();
    let day = fixture["day"].as_u64().unwrap();
    let riddle = fixture["riddle"].as_str().unwrap();
    let answers = answers_of(&fixture);
    let salt = fixture["salt"].as_str().unwrap();
    let ctx = with_commit(day, unhex(fixture["hash"].as_str().unwrap())).await?;
    let view = ctx.riddle_view(day).await?;
    let snapshot = ctx.snapshot("nobody.near").await?;

    let mut fewer = answers.clone();
    fewer.pop();
    let mut reordered = answers.clone();
    reordered.reverse();
    let wrong: [(&str, &[String], &str); 4] = [
        ("Another riddle", &answers, salt),
        (riddle, &fewer, salt),
        (riddle, &reordered, salt),
        (riddle, &answers, "another salt"),
    ];
    for (r, a, s) in wrong {
        let refused = ctx
            .riddle_reveal_as(&ctx.server, day, r, a, s, Gas::from_tgas(30))
            .await?;
        assert_refused(&refused, "bad_reveal");
        assert!(event_logs(&refused).is_empty());
    }
    assert_eq!(ctx.riddle_view(day).await?, view);
    assert_eq!(view["hash"], fixture["hash"]);
    assert_eq!(ctx.snapshot("nobody.near").await?, snapshot);
    Ok(())
}

// spec: add-daily-ritual › Riddle reveal contract › нет нераскрытого коммита
#[tokio::test]
async fn a_day_with_no_commit_cannot_be_revealed() -> anyhow::Result<()> {
    let fixture = fixture();
    let day = fixture["day"].as_u64().unwrap();
    let ctx = with_reserve(1).await?;
    let snapshot = ctx.snapshot("nobody.near").await?;

    let refused = ctx
        .riddle_reveal_as(
            &ctx.server,
            day,
            fixture["riddle"].as_str().unwrap(),
            &answers_of(&fixture),
            fixture["salt"].as_str().unwrap(),
            Gas::from_tgas(30),
        )
        .await?;
    assert_refused(&refused, "no_commit");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(ctx.snapshot("nobody.near").await?, snapshot);
    Ok(())
}

/// The prepaid gas of `riddle_reveal` as the Worker sends it, on the worst case: the longest list
/// entry, which the 5 KB of the `RIDDLE_LIST` secret allows. Read from the Worker's source.
// spec: add-daily-ritual › Riddle reveal contract › раскрытие записано × gas
#[tokio::test]
async fn gas_of_a_reveal() -> anyhow::Result<()> {
    let prepaid: Gas = tgas_const("RIDDLE_REVEAL_TGAS");
    let day = fixture()["day"].as_u64().unwrap();
    // One entry of the list: the text and 12 answers, close to the 5,000 bytes the secret holds.
    let riddle = "r".repeat(3_900);
    let answers: Vec<String> = (0..12)
        .map(|n| format!("{n:02}{}", "a".repeat(38)))
        .collect();
    let salt = "f".repeat(32);
    assert!(riddle.len() + answers.iter().map(String::len).sum::<usize>() + salt.len() <= 5_000);
    let ctx = with_commit(day, hash_of(day, &riddle, &answers, &salt)).await?;

    let result = ctx
        .riddle_reveal_as(&ctx.server, day, &riddle, &answers, &salt, prepaid)
        .await?;
    let burnt = result.total_gas_burnt.as_gas();
    eprintln!(
        "gas_of_a_reveal: burnt {burnt} gas, prepaid {} gas, event {} bytes",
        prepaid.as_gas(),
        result.logs().iter().map(|l| l.len()).sum::<usize>()
    );
    assert!(result.is_success(), "{:?}", result.failures());
    assert!(burnt < prepaid.as_gas());
    Ok(())
}

// riddle_storage_fund and riddle_view stand in §8 with no Requirement of their own (an accepted
// exception, as `pool_fund`): their tests carry no Scenario anchor.
#[tokio::test]
async fn anyone_funds_the_reserve_and_it_grows_with_no_way_out() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    let day = today(&ctx).await?;
    let pool = ctx.pool().await?;
    assert_eq!(reserve_of(&ctx.riddle_view(day).await?), 0);

    // The server's own account, and a stranger.
    ctx.fund_riddles(5_000_000).await?.into_result()?;
    let funded = ctx
        .funder
        .call(ctx.contract.id(), "riddle_storage_fund")
        .deposit(NearToken::from_yoctonear(7))
        .transact()
        .await?;
    funded.into_result()?;
    assert_eq!(reserve_of(&ctx.riddle_view(day).await?), 5_000_007);
    assert_eq!(ctx.pool().await?, pool, "the pool is another purse");

    // No deposit, no growth.
    let before = ctx.snapshot("nobody.near").await?;
    let refused = ctx
        .funder
        .call(ctx.contract.id(), "riddle_storage_fund")
        .transact()
        .await?;
    assert_refused(&refused, "zero_deposit");
    assert_eq!(reserve_of(&ctx.riddle_view(day).await?), 5_000_007);
    assert_eq!(ctx.snapshot("nobody.near").await?, before);

    // Nothing takes the reserve out: the only methods with `riddle_` in the wasm are the four of
    // §8, and none of them transfers.
    let wasm = wasm();
    let mut names = std::collections::BTreeSet::new();
    let mut at = 0;
    while let Some(found) = wasm[at..].windows(7).position(|w| w == b"riddle_") {
        let start = at + found;
        let end = wasm[start..]
            .iter()
            .position(|b| !(b.is_ascii_lowercase() || *b == b'_'))
            .map_or(wasm.len(), |n| start + n);
        names.insert(String::from_utf8_lossy(&wasm[start..end]).to_string());
        at = end;
    }
    let allowed = [
        "riddle_commit",
        "riddle_reveal",
        "riddle_storage_fund",
        "riddle_view",
    ];
    for name in &names {
        assert!(
            allowed.contains(&name.as_str()),
            "{name} is not a method of §8: {names:?}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn riddle_view_shows_a_day_with_a_commit_one_with_none_the_reserve_and_the_price()
-> anyhow::Result<()> {
    let ctx = with_reserve(2).await?;
    let day = today(&ctx).await?;
    let hash = "cd".repeat(32);
    ctx.riddle_commit(&hash).await?.into_result()?;

    let with = ctx.riddle_view(day).await?;
    assert_eq!(with["hash"], hash);
    assert_eq!(with["reserve"], COMMIT_COST.to_string());
    assert_eq!(with["commit_cost"], COMMIT_COST.to_string());
    let without = ctx.riddle_view(day - 1).await?;
    assert!(without["hash"].is_null());
    assert_eq!(without["reserve"], with["reserve"]);
    assert_eq!(without["commit_cost"], with["commit_cost"]);
    // Any account reads it: it is a view.
    assert!(ctx.riddle_view(0).await?["hash"].is_null());
    Ok(())
}
