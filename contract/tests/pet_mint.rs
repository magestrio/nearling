mod common;

use common::*;
use nearling_contract::limits::{
    BIRTHS_PER_DAY, MAX_BIRTH_COST, MAX_CHARACTER_BYTES, MAX_NAME_BYTES, OWNER_LIST_ENTRY_BYTES,
};
use near_workspaces::types::Gas;
use serde_json::json;

const CHARACTER:&str = "I'm curious about everything, and I notice the small things.";

fn longest_character() -> String {
    "c".repeat(MAX_CHARACTER_BYTES)
}

// spec: add-pet › Pet mint contract › чужой вызов
#[tokio::test]
async fn a_foreign_caller_cannot_mint() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let before = ctx.snapshot("alice.near").await?;
    let refused = ctx
        .mint_as(&ctx.funder, "alice.near", "Pixel", CHARACTER)
        .await?;
    assert_refused(&refused, "not_server");
    assert_eq!(ctx.snapshot("alice.near").await?, before);
    // A function-call-key-style attempt with a deposit is refused as well: the method takes none.
    let with_deposit = ctx
        .server
        .call(ctx.contract.id(), "pet_mint")
        .args_json(json!({ "receiver": "alice.near", "name": "Pixel", "character": CHARACTER }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(with_deposit.is_failure());
    assert_eq!(ctx.snapshot("alice.near").await?, before);
    Ok(())
}

// spec: add-pet › Pet mint contract › второй рождённый питомец
#[tokio::test]
async fn a_receiver_who_hatched_cannot_hatch_again() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    let before = ctx.snapshot("alice.near").await?;
    let refused = ctx.mint("alice.near", "Second", CHARACTER).await?;
    assert_refused(&refused, "already_hatched");
    assert_eq!(ctx.snapshot("alice.near").await?, before);
    // The gift case ("даже если подарил") is the unit test
    // `a_second_mint_fails_even_after_the_pet_was_given` in `src/lib.rs`: `nft_transfer` is not
    // exposed here, so the move is the standard's internal one.
    Ok(())
}

// spec: add-pet › Pet mint contract › пул проекта пуст
#[tokio::test]
async fn a_pool_one_yocto_short_of_the_cost_refuses_and_exactly_the_cost_passes()
-> anyhow::Result<()> {
    // The cost of this very birth, measured on a pool that is large enough.
    let rich = setup(BIG_POOL).await?;
    rich.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    let cost = BIG_POOL - rich.pool().await?;
    assert!(cost > STARTER_FOOD);

    let ctx = setup(cost - 1).await?;
    let before = ctx.snapshot("alice.near").await?;
    let refused = ctx.mint("alice.near", "Pixel", CHARACTER).await?;
    assert_refused(&refused, "pool_empty");
    assert_eq!(ctx.snapshot("alice.near").await?, before);
    assert_eq!(ctx.pool().await?, cost - 1);

    ctx.fund(1).await?;
    ctx.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    assert_eq!(ctx.pool().await?, 0);
    Ok(())
}

// spec: add-pet › Pet mint contract › 51-е рождение за сутки
#[tokio::test]
async fn the_fifty_first_birth_of_a_day_is_refused() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL * 2).await?;
    ctx.avoid_midnight().await?;
    for n in 0..BIRTHS_PER_DAY {
        let receiver = format!("player{n}.near");
        ctx.mint(&receiver, "Pixel", CHARACTER)
            .await?
            .into_result()?;
    }
    assert_eq!(
        ctx.hatch_view("player0.near").await?["born_today"],
        BIRTHS_PER_DAY
    );
    let before = ctx.snapshot("player51.near").await?;
    let refused = ctx.mint("player51.near", "Pixel", CHARACTER).await?;
    assert_refused(&refused, "daily_births");
    assert_eq!(ctx.snapshot("player51.near").await?, before);
    assert_eq!(
        ctx.hatch_view("player51.near").await?["token_id"],
        serde_json::Value::Null
    );

    // 00:00 UTC: the 50 births now belong to the day before, the counter reads 0, the mint passes.
    ctx.age_births_by_a_day().await?;
    assert_eq!(ctx.hatch_view("player51.near").await?["born_today"], 0);
    ctx.mint("player51.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    assert_eq!(ctx.hatch_view("player51.near").await?["born_today"], 1);
    Ok(())
}

// spec: add-pet › Pet mint contract › имя длиннее 32 байт
#[tokio::test]
async fn a_name_of_33_bytes_is_refused_and_32_bytes_with_emoji_pass() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let name_32 = "🚀".repeat(8);
    assert_eq!(name_32.len(), MAX_NAME_BYTES);
    let name_33 = format!("{name_32}a");
    let before = ctx.snapshot("alice.near").await?;
    let refused = ctx.mint("alice.near", &name_33, CHARACTER).await?;
    assert_refused(&refused, "name_too_long");
    assert_eq!(ctx.snapshot("alice.near").await?, before);

    ctx.mint("alice.near", &name_32, CHARACTER)
        .await?
        .into_result()?;
    assert_eq!(ctx.pet_view("0").await?["name"], name_32);
    Ok(())
}

// spec: add-pet › Pet mint contract › характер длиннее предела
#[tokio::test]
async fn a_character_over_the_longest_assembly_is_refused() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let before = ctx.snapshot("alice.near").await?;
    let too_long = "c".repeat(MAX_CHARACTER_BYTES + 1);
    let refused = ctx.mint("alice.near", "Pixel", &too_long).await?;
    assert_refused(&refused, "character_too_long");
    assert_eq!(ctx.snapshot("alice.near").await?, before);

    ctx.mint("alice.near", "Pixel", &longest_character())
        .await?
        .into_result()?;
    assert_eq!(ctx.pet_view("0").await?["character"], longest_character());
    Ok(())
}

/// A birth writes the record the Requirement lists, and takes the cost out of the pool.
#[tokio::test]
async fn a_birth_records_the_pet_and_enumerates_it() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let before_storage = ctx.storage_usage().await?;
    let finished = ctx.mint("alice.near", "Pixel", CHARACTER).await?;
    let events = event_logs(&finished);
    let result = finished.into_result()?;
    assert_eq!(result.json::<String>()?, "0");

    let pet = ctx.pet_view("0").await?;
    assert_eq!(pet["owner_id"], "alice.near");
    assert_eq!(pet["name"], "Pixel");
    assert_eq!(pet["character"], CHARACTER);
    assert_eq!(pet["project_food"], STARTER_FOOD.to_string());
    assert_eq!(pet["given_food"], "0");
    assert_eq!(pet["last_debit_id"], 0);
    assert_eq!(pet["stage"], "Baby");
    assert_eq!(pet["streak"], 0);
    assert_eq!(pet["freezes"], 1);
    assert_eq!(pet["debited_today"], "0");
    // The snack counters of `add-feeding` start at zero.
    assert_eq!(pet["friend_snack_day"], 0);
    assert_eq!(pet["friend_snacks"], 0);
    assert_eq!(pet["owner_snack_at"], "0");

    let hatch = ctx.hatch_view("alice.near").await?;
    assert_eq!(hatch["token_id"], "0");
    assert_eq!(hatch["born_today"], 1);
    assert_eq!(ctx.supply_for("alice.near").await?, "1");
    let listed: serde_json::Value = ctx
        .contract
        .view("nft_tokens_for_owner")
        .args_json(json!({ "account_id": "alice.near" }))
        .await?
        .json()?;
    assert_eq!(listed[0]["token_id"], "0");
    assert_eq!(listed[0]["owner_id"], "alice.near");
    let token: serde_json::Value = ctx
        .contract
        .view("nft_token")
        .args_json(json!({ "token_id": "0" }))
        .await?
        .json()?;
    assert_eq!(token["owner_id"], "alice.near");
    assert_eq!(ctx.pet_view("1").await?, serde_json::Value::Null);

    // The pool paid the bytes the chain counted plus the owner-list entry and the starter food.
    let bytes = ctx.storage_usage().await? - before_storage;
    let byte_cost = 10_000_000_000_000_000_000u128;
    let cost = BIG_POOL - ctx.pool().await?;
    assert_eq!(
        cost,
        (bytes + OWNER_LIST_ENTRY_BYTES) as u128 * byte_cost + STARTER_FOOD
    );

    // The events: the standard's mint and the game's birth.
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(events[0].contains("\"nep171\"") && events[0].contains("nft_mint"));
    assert!(events[1].contains("\"nearling\"") && events[1].contains("pet_born"));
    Ok(())
}

/// The measured storage of a birth with the longest character, the 32-byte name and a 64-byte
/// receiver, against `MAX_BIRTH_COST`; and the gas of `pet_mint`. The numbers go to design.md.
#[tokio::test]
async fn storage_of_a_birth() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let receiver = "a".repeat(64);
    let name = "🚀".repeat(8);
    let before = ctx.storage_usage().await?;
    let result = ctx.mint(&receiver, &name, &longest_character()).await?;
    let gas = result.total_gas_burnt.as_gas();
    result.into_result()?;
    let bytes = ctx.storage_usage().await? - before;
    let cost = BIG_POOL - ctx.pool().await?;
    eprintln!(
        "storage_of_a_birth: {bytes} bytes written, +{OWNER_LIST_ENTRY_BYTES} owner-list bytes, cost {cost} yocto, gas {gas}"
    );
    assert!(
        cost <= MAX_BIRTH_COST,
        "cost {cost} > MAX_BIRTH_COST {MAX_BIRTH_COST}"
    );
    // The token id could be 19 digits longer; the bound must still hold.
    let extra_id_bytes = 19 * 5; // the id is in five records: the owner row, the set element and its index, the pet key, the hatched value
    let widened = cost + extra_id_bytes as u128 * 10_000_000_000_000_000_000u128;
    assert!(widened <= MAX_BIRTH_COST);
    assert!(
        gas < attached_gas().as_gas(),
        "pet_mint burnt {gas} gas, attached {}",
        attached_gas().as_gas()
    );
    Ok(())
}

/// The prepaid gas of `pet_mint` as the Worker sends it, read from its source: a test on another
/// number would prove nothing about the transactions that really go out.
fn attached_gas() -> Gas {
    let source = include_str!("../../server/src/chain.ts");
    let line = source
        .lines()
        .find(|l| l.contains("PET_MINT_TGAS ="))
        .expect("PET_MINT_TGAS in server/src/chain.ts");
    let digits: String = line
        .split('=')
        .nth(1)
        .unwrap()
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    Gas::from_tgas(digits.parse().unwrap())
}

/// The births ADR-002's pool pays for (4.9 NEAR / 0.0206 ≈ 238, ~150 planned), and a margin.
const BIRTHS_IN_A_PLAYTEST: u64 = 260;

/// Every mint inserts into the standard's `owner_by_id` TreeMap, whose cost grows with the height
/// of its tree: the gas of the first birth says nothing about the 200th. The worst fields, the
/// Worker's own prepaid gas, on a growing contract.
// spec: add-pet › Birth flow › вылупился × the contract holds a playtest's pets
#[tokio::test]
async fn the_last_birth_of_a_playtest_fits_the_attached_gas() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL * 20).await?;
    ctx.avoid_midnight().await?;
    let name = "🚀".repeat(8);
    let character = longest_character();
    let attached = attached_gas();
    let mut most = 0u64;
    for n in 0..BIRTHS_IN_A_PLAYTEST {
        if n > 0 && n % u64::from(BIRTHS_PER_DAY) == 0 {
            ctx.age_births_by_a_day().await?;
        }
        let receiver = format!("{n:064x}");
        let result = ctx
            .server
            .call(ctx.contract.id(), "pet_mint")
            .args_json(json!({ "receiver": receiver, "name": name, "character": character }))
            .gas(attached)
            .transact()
            .await?;
        let burnt = result.total_gas_burnt.as_gas();
        assert!(
            result.is_success(),
            "birth {n} failed with {} attached, burnt {burnt}: {:?}",
            attached.as_gas(),
            result.failures()
        );
        most = most.max(burnt);
        if n % 20 == 0 || n + 1 == BIRTHS_IN_A_PLAYTEST {
            eprintln!("birth {n}: burnt {burnt} gas, most so far {most}");
        }
    }
    assert!(
        most < attached.as_gas(),
        "burnt {most} of {}",
        attached.as_gas()
    );
    Ok(())
}
