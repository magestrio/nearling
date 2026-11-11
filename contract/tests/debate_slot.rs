mod common;

use common::*;
use near_sdk::borsh;
use nearling_contract::debate::{DEBATE_DAILY_CAP, DEBATE_SLOT_BYTES, DebateSlot, next_slot};
use nearling_contract::events::DebateReceipt;
use nearling_contract::limits::MAX_THOUGHT_PRICE;
use serde_json::{Value, json};

const BYTE_COST: u128 = 10_000_000_000_000_000_000;

fn id(sequence_low: u64, sequence_high: u64) -> String {
    format!(
        "{sequence_low:016x}{sequence_high:016x}{:016x}{}",
        1u64,
        "ab".repeat(8)
    )
}

fn line(id: &str, order: u8, price: u128) -> Value {
    let mut thought = thought_json(price);
    thought["debate"] = json!({
        "id": id,
        "line_order": order,
        "other_token_id": "1",
        "speaker_transfer_generation": 0,
        "other_transfer_generation": 0,
    });
    thought
}

async fn pair(pool: u128) -> anyhow::Result<Ctx> {
    let ctx = setup(pool).await?;
    let alice = ctx.account("alice", 20).await?;
    let bob = ctx.account("bob", 20).await?;
    ctx.mint(alice.id().as_str(), "Pixel", "Curious")
        .await?
        .into_result()?;
    ctx.mint(bob.id().as_str(), "Nori", "Thoughtful")
        .await?
        .into_result()?;
    ctx.set_pet("0", |pet| pet.project_food = NEAR).await?;
    Ok(ctx)
}

async fn paid_slot(ctx: &Ctx, token_id: &str) -> anyhow::Result<(Vec<u8>, DebateSlot)> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let mut input = b"d".to_vec();
    input.extend(borsh::to_vec(&token_id.to_owned())?);
    let key = near_sdk::env::sha256_array(&input).to_vec();
    let stored = ctx.read_key(&key).await?.expect("paid slot stored");
    Ok((key, borsh::from_slice(&stored)?))
}

async fn set_paid_slot_day(ctx: &Ctx, token_id: &str, day: u64) -> anyhow::Result<()> {
    let (key, mut slot) = paid_slot(ctx, token_id).await?;
    slot.occupied_day = day;
    ctx.worker
        .patch_state(ctx.contract.id(), &key, &borsh::to_vec(&slot)?)
        .await?;
    Ok(())
}

// spec: add-debates › Debate debit contract › accepted line
// spec: add-debates › Debate debit contract › slot storage unavailable
// spec: add-debates › Debate paid-slot view contract › paid slot read
#[tokio::test]
async fn first_line_stakes_exact_slot_bytes_and_pool_shortage_changes_nothing() -> anyhow::Result<()>
{
    let ctx = pair(BIG_POOL).await?;
    let debate_id = id(1, 1);
    let before = ctx.pet_view("0").await?;
    assert!(before["paid_debate"].is_null());
    let before_storage = ctx.storage_usage().await?;
    let before_pool = ctx.pool().await?;
    let treasury_before = ctx.balance_of(ctx.treasury.id()).await?;
    let result = ctx
        .debit("0", 1, vec![line(&debate_id, 1, MAX_THOUGHT_PRICE)])
        .await?;
    let debit_gas = result.outcomes()[1].gas_burnt.as_gas();
    let total_gas = result.total_gas_burnt.as_gas();
    eprintln!("debate paid first line: {debit_gas} receipt gas, {total_gas} transaction gas");
    result.into_result()?;
    let after = ctx.pet_view("0").await?;
    let bytes = ctx.storage_usage().await? - before_storage;
    eprintln!(
        "debate paid slot: {bytes} bytes, {} yoctoNEAR stake",
        u128::from(bytes) * BYTE_COST
    );
    assert_eq!(bytes, DEBATE_SLOT_BYTES);
    assert_eq!(
        before_pool - ctx.pool().await?,
        u128::from(bytes) * BYTE_COST
    );
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await? - treasury_before,
        MAX_THOUGHT_PRICE
    );
    assert_eq!(after["paid_debate"]["id"], debate_id);
    assert_eq!(after["paid_debate"]["accepted_lines"], 1);
    assert_eq!(after["paid_debate"]["used_orders"], 1);
    assert_eq!(
        after["project_food"].as_str().unwrap().parse::<u128>()?,
        NEAR - MAX_THOUGHT_PRICE
    );
    assert_eq!(
        ctx.pet_view("0").await?,
        after,
        "view reads do not write or move food"
    );
    assert_eq!(ctx.storage_usage().await?, before_storage + bytes);

    let short = pair(BIG_POOL).await?;
    short.set_pool(0).await?;
    let food = short.pet_view("0").await?;
    let storage = short.storage_usage().await?;
    let treasury = short.balance_of(short.treasury.id()).await?;
    let failed = short
        .debit("0", 1, vec![line(&debate_id, 1, MAX_THOUGHT_PRICE)])
        .await?;
    assert_refused(&failed, "pool_empty");
    assert!(event_logs(&failed).is_empty());
    assert_eq!(short.pet_view("0").await?, food);
    assert_eq!(short.storage_usage().await?, storage);
    assert_eq!(short.balance_of(short.treasury.id()).await?, treasury);
    Ok(())
}

// spec: add-debates › Debate debit contract › third paid line
// spec: add-debates › Debate debit contract › repeated line order
// spec: add-debates › Debate debit contract › different paid debate today
#[tokio::test]
async fn paid_slot_rejects_third_duplicate_and_other_id_without_a_new_receipt() -> anyhow::Result<()>
{
    let ctx = pair(BIG_POOL).await?;
    let first = id(1, 1);
    ctx.debit("0", 1, vec![line(&first, 1, MAX_THOUGHT_PRICE)])
        .await?
        .into_result()?;
    let storage_after_first = ctx.storage_usage().await?;
    let pool_after_first = ctx.pool().await?;
    let duplicate = ctx
        .debit("0", 2, vec![line(&first, 1, MAX_THOUGHT_PRICE)])
        .await?;
    assert_refused(&duplicate, "debate_order_used");
    assert!(event_logs(&duplicate).is_empty());
    let other = ctx
        .debit("0", 2, vec![line(&id(2, 2), 3, MAX_THOUGHT_PRICE)])
        .await?;
    assert_refused(&other, "debate_day_occupied");
    assert!(event_logs(&other).is_empty());
    ctx.debit("0", 2, vec![line(&first, 3, MAX_THOUGHT_PRICE)])
        .await?
        .into_result()?;
    assert_eq!(ctx.storage_usage().await?, storage_after_first);
    assert_eq!(ctx.pool().await?, pool_after_first);
    let settled = ctx.pet_view("0").await?;
    assert_eq!(settled["paid_debate"]["accepted_lines"], 2);
    assert_eq!(settled["paid_debate"]["used_orders"], 5);
    let third = ctx.debit("0", 3, vec![line(&first, 4, 1)]).await?;
    assert_refused(&third, "debate_lines_cap");
    assert!(event_logs(&third).is_empty());
    assert_eq!(ctx.pet_view("0").await?, settled);
    Ok(())
}

// spec: add-debates › Debate debit contract › carried line after reset
// spec: add-debates › Debate debit contract › different paid debate today
// spec: add-debates › Debate debit contract › repeated debit id
#[tokio::test]
async fn a_carried_line_keeps_its_count_and_an_old_id_cannot_reappear_after_replacement()
-> anyhow::Result<()> {
    let ctx = pair(BIG_POOL).await?;
    let first = id(1, 1);
    ctx.debit("0", 1, vec![line(&first, 1, MAX_THOUGHT_PRICE)])
        .await?
        .into_result()?;
    let today = ctx.block_timestamp().await? / nearling_contract::limits::DAY_NS;
    set_paid_slot_day(&ctx, "0", today - 1).await?;
    ctx.debit("0", 2, vec![line(&first, 3, MAX_THOUGHT_PRICE)])
        .await?
        .into_result()?;
    let (_, carried) = paid_slot(&ctx, "0").await?;
    assert_eq!(carried.accepted_lines, 2);
    assert_eq!(carried.occupied_day, today);
    assert_eq!(carried.debited_today, MAX_THOUGHT_PRICE);
    let other_today = ctx.debit("0", 3, vec![line(&id(2, 2), 1, 1)]).await?;
    assert_refused(&other_today, "debate_day_occupied");
    set_paid_slot_day(&ctx, "0", today - 1).await?;
    let second = id(2, 2);
    ctx.debit("0", 3, vec![line(&second, 1, 1)])
        .await?
        .into_result()?;
    let (_, replaced) = paid_slot(&ctx, "0").await?;
    assert_eq!(replaced.last_sequence, 2);
    assert_eq!(replaced.accepted_lines, 1);
    set_paid_slot_day(&ctx, "0", today - 1).await?;
    let before = ctx.pet_view("0").await?;
    let replay = ctx.debit("0", 4, vec![line(&first, 4, 1)]).await?;
    assert_refused(&replay, "bad_debate_sequence");
    assert!(event_logs(&replay).is_empty());
    assert_eq!(ctx.pet_view("0").await?, before);
    Ok(())
}

// spec: add-debates › Debate debit contract › repeated debit id
#[tokio::test]
async fn a_public_id_cannot_be_reinterpreted_with_another_partner() -> anyhow::Result<()> {
    let ctx = pair(BIG_POOL).await?;
    let cara = ctx.account("cara", 20).await?;
    ctx.mint(cara.id().as_str(), "Pip", "Curious")
        .await?
        .into_result()?;
    let before = ctx.pet_view("0").await?;
    let mut forged = line(&id(1, 1), 1, 1);
    forged["debate"]["other_token_id"] = json!("2");
    let rejected = ctx.debit("0", 1, vec![forged]).await?;
    assert_refused(&rejected, "bad_debate_pair");
    assert!(event_logs(&rejected).is_empty());
    assert_eq!(ctx.pet_view("0").await?, before);
    Ok(())
}

// spec: add-debates › Debate debit contract › carried line after reset
// spec: add-debates › Debate debit contract › different paid debate today
// spec: add-debates › Debate debit contract › repeated debit id
#[test]
fn utc_reset_keeps_lifetime_count_and_next_id_rejects_an_old_replay() {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let first_id = id(1, 1);
    let receipt = |id: String, order| DebateReceipt {
        id,
        line_order: order,
        other_token_id: "1".to_owned(),
        speaker_transfer_generation: 0,
        other_transfer_generation: 0,
    };
    let first = next_slot(
        None,
        &receipt(first_id.clone(), 1),
        &"0".to_owned(),
        MAX_THOUGHT_PRICE,
        10,
    );
    let carried = next_slot(
        Some(&first),
        &receipt(first_id.clone(), 3),
        &"0".to_owned(),
        MAX_THOUGHT_PRICE,
        11,
    );
    assert_eq!(carried.occupied_day, 11);
    assert_eq!(carried.accepted_lines, 2);
    assert_eq!(carried.used_orders, 5);
    assert_eq!(carried.debited_today, MAX_THOUGHT_PRICE);
    let second_id = id(2, 2);
    let second = next_slot(
        Some(&carried),
        &receipt(second_id.clone(), 1),
        &"0".to_owned(),
        MAX_THOUGHT_PRICE,
        12,
    );
    assert_eq!(second.last_sequence, 2);
    assert_eq!(second.accepted_lines, 1);
    assert!(
        std::panic::catch_unwind(|| next_slot(
            Some(&second),
            &receipt(first_id, 2),
            &"0".to_owned(),
            1,
            13
        ))
        .is_err()
    );
    assert!(
        std::panic::catch_unwind(|| next_slot(
            Some(&second),
            &receipt(second_id, 1),
            &"0".to_owned(),
            1,
            13
        ))
        .is_err()
    );
}

// spec: add-debates › Debate debit contract › daily cap
#[test]
fn debate_day_cap_accepts_exact_limit_and_rejects_one_more() {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let debate_id = id(1, 1);
    let receipt = |order| DebateReceipt {
        id: debate_id.clone(),
        line_order: order,
        other_token_id: "1".to_owned(),
        speaker_transfer_generation: 0,
        other_transfer_generation: 0,
    };
    let first = next_slot(None, &receipt(1), &"0".to_owned(), MAX_THOUGHT_PRICE, 10);
    let exact = next_slot(
        Some(&first),
        &receipt(3),
        &"0".to_owned(),
        MAX_THOUGHT_PRICE,
        10,
    );
    assert_eq!(exact.debited_today, DEBATE_DAILY_CAP);
    let near_limit = DebateSlot {
        accepted_lines: 1,
        used_orders: 1,
        debited_today: DEBATE_DAILY_CAP,
        ..first
    };
    assert!(
        std::panic::catch_unwind(|| next_slot(
            Some(&near_limit),
            &receipt(3),
            &"0".to_owned(),
            1,
            10
        ))
        .is_err()
    );
}

// spec: add-debates › Debate debit contract › repeated debit id
#[test]
fn debate_id_sequences_are_independent_for_the_two_pets() {
    let lower = DebateReceipt {
        id: id(2, 1),
        line_order: 2,
        other_token_id: "0".to_owned(),
        speaker_transfer_generation: 0,
        other_transfer_generation: 0,
    };
    let higher_first = next_slot(None, &lower, &"1".to_owned(), 1, 10);
    assert_eq!(higher_first.last_sequence, 1);
    let higher_next = DebateReceipt {
        id: id(2, 2),
        line_order: 4,
        ..lower
    };
    let next = next_slot(Some(&higher_first), &higher_next, &"1".to_owned(), 1, 11);
    assert_eq!(next.last_sequence, 2);
}

// spec: add-debates › Debate paid-slot view contract › paid slot read
#[tokio::test]
async fn migration_preserves_old_collections_and_appends_only_the_empty_map() -> anyhow::Result<()>
{
    let ctx = pair(BIG_POOL).await?;
    let friend = ctx.account("friend", 20).await?;
    ctx.feed_as(&friend, "0", nearling_contract::limits::MIN_FEED)
        .await?
        .into_result()?;
    assert!(ctx.knows("0", friend.id().as_str()).await?);
    let mut errand = thought_json(1);
    errand["completed_errand"] = json!(true);
    ctx.debit("0", 1, vec![errand]).await?.into_result()?;
    let pool = ctx.pool().await?;
    let pet = ctx.pet_view("0").await?;
    let other = ctx.pet_view("1").await?;
    let showcase: Value = ctx.contract.view("showcase_view").await?.json()?;
    let experience: Value = ctx
        .contract
        .view("experience_view")
        .args_json(json!({"token_id": "0"}))
        .await?
        .json()?;
    ctx.restore_v9_state().await?;
    let old_size = ctx.read_state().await?.len();
    let outsider = ctx
        .funder
        .call(ctx.contract.id(), "migrate_debates")
        .transact()
        .await?;
    assert_refused(&outsider, "private");
    ctx.contract
        .call("migrate_debates")
        .transact()
        .await?
        .into_result()?;
    let current = ctx.read_state().await?;
    let _: nearling_contract::Contract = borsh::from_slice(&current)?;
    assert!(current.len() > old_size + 5);
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.pet_view("1").await?, other);
    assert!(ctx.knows("0", friend.id().as_str()).await?);
    assert_eq!(
        ctx.contract
            .view("experience_view")
            .args_json(json!({"token_id": "0"}))
            .await?
            .json::<Value>()?,
        experience
    );
    assert_eq!(ctx.pool().await?, pool);
    assert_eq!(
        ctx.contract.view("showcase_view").await?.json::<Value>()?,
        showcase
    );
    let migrated = ctx.read_state().await?;
    let repeated = ctx.contract.call("migrate_debates").transact().await?;
    assert!(repeated.is_failure(), "migration is one-time");
    assert_eq!(ctx.read_state().await?, migrated);
    Ok(())
}
