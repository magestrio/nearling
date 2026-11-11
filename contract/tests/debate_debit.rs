mod common;

use common::*;
use near_workspaces::types::NearToken;
use nearling_contract::limits::{DAILY_CAP, DAY_NS, MAX_THOUGHT_PRICE};
use serde_json::{Value, json};

const ID: &str = "000000000000000100000000000000010000000000000001ffffffffffffffff";
const PRICE: u128 = 1_000_000_000_000_000_000_000;

fn line(price: u128, order: u8, speaker_version: u64, other_version: u64) -> Value {
    let mut thought = thought_json(price);
    thought["debate"] = json!({
        "id": ID,
        "line_order": order,
        "other_token_id": "1",
        "speaker_transfer_generation": speaker_version,
        "other_transfer_generation": other_version,
    });
    thought
}

async fn pair() -> anyhow::Result<(Ctx, near_workspaces::Account, near_workspaces::Account)> {
    let ctx = setup(BIG_POOL).await?;
    let alice = ctx.account("alice", 20).await?;
    let bob = ctx.account("bob", 20).await?;
    ctx.mint(alice.id().as_str(), "Pixel", "Curious")
        .await?
        .into_result()?;
    ctx.mint(bob.id().as_str(), "Nori", "Thoughtful")
        .await?
        .into_result()?;
    ctx.set_pet("0", |pet| pet.project_food = NEAR).await?;
    Ok((ctx, alice, bob))
}

async fn unchanged(
    ctx: &Ctx,
    before: &Value,
    result: &near_workspaces::result::ExecutionFinalResult,
) -> anyhow::Result<()> {
    assert_eq!(&ctx.pet_view("0").await?, before);
    assert!(event_logs(result).is_empty());
    Ok(())
}

// spec: add-debates › Debate debit contract › accepted line
#[tokio::test]
async fn accepted_line_moves_exact_food_and_emits_public_metadata() -> anyhow::Result<()> {
    let (ctx, _, _) = pair().await?;
    let before = ctx.pet_view("0").await?;
    let treasury_before = ctx.balance_of(ctx.treasury.id()).await?;
    let result = ctx.debit("0", 1, vec![line(PRICE, 1, 0, 0)]).await?;
    let logs = event_logs(&result);
    result.into_result()?;
    let after = ctx.pet_view("0").await?;
    let food = |view: &Value| -> u128 {
        view["project_food"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap()
            + view["given_food"]
                .as_str()
                .unwrap()
                .parse::<u128>()
                .unwrap()
    };
    assert_eq!(food(&before) - food(&after), PRICE);
    assert_eq!(
        ctx.balance_of(ctx.treasury.id()).await? - treasury_before,
        PRICE
    );
    assert_eq!(logs.len(), 1);
    let event: Value = serde_json::from_str(&logs[0])?;
    assert_eq!(event["event"], "receipt");
    assert_eq!(event["data"]["debate_id"], ID);
    assert_eq!(event["data"]["line_order"], 1);
    for field in ["model", "price", "calls", "token_id", "debit_id"] {
        assert!(!event["data"][field].is_null(), "missing {field}");
    }
    for field in ["topic", "words", "share_code", "other_token_id"] {
        assert!(event["data"][field].is_null(), "leaked {field}");
    }
    Ok(())
}

// spec: add-debates › Debate debit contract › wrong caller
// spec: add-debates › Debate debit contract › price cap
// spec: add-debates › Debate debit contract › insufficient food
// spec: add-debates › Debate debit contract › daily cap
// spec: add-debates › Debate debit contract › repeated debit id
#[tokio::test]
async fn rejected_debate_debits_leave_food_treasury_and_receipts_untouched() -> anyhow::Result<()> {
    let (ctx, _, _) = pair().await?;
    let mut before = ctx.pet_view("0").await?;
    let treasury_before = ctx.balance_of(ctx.treasury.id()).await?;
    let wrong = ctx
        .debit_as(&ctx.funder, "0", 1, vec![line(PRICE, 1, 0, 0)])
        .await?;
    assert_refused(&wrong, "not_server");
    unchanged(&ctx, &before, &wrong).await?;

    let over = ctx
        .debit("0", 1, vec![line(MAX_THOUGHT_PRICE + 1, 1, 0, 0)])
        .await?;
    assert_refused(&over, "price_over_cap");
    unchanged(&ctx, &before, &over).await?;

    ctx.set_pet("0", |pet| {
        pet.project_food = 0;
        pet.given_food = 0;
    })
    .await?;
    before = ctx.pet_view("0").await?;
    let hungry = ctx.debit("0", 1, vec![line(PRICE, 1, 0, 0)]).await?;
    assert_refused(&hungry, "over_food");
    unchanged(&ctx, &before, &hungry).await?;

    let day = ctx.block_timestamp().await? / DAY_NS;
    ctx.set_pet("0", |pet| {
        pet.project_food = NEAR;
        pet.debit_day = day;
        pet.debited_today = DAILY_CAP;
    })
    .await?;
    before = ctx.pet_view("0").await?;
    let capped = ctx.debit("0", 1, vec![line(PRICE, 1, 0, 0)]).await?;
    assert_refused(&capped, "daily_cap");
    unchanged(&ctx, &before, &capped).await?;

    let jumped = ctx.debit("0", 2, vec![line(PRICE, 1, 0, 0)]).await?;
    assert_refused(&jumped, "bad_debit_id");
    unchanged(&ctx, &before, &jumped).await?;
    assert_eq!(ctx.balance_of(ctx.treasury.id()).await?, treasury_before);
    Ok(())
}

// spec: add-debates › Debate debit contract › invalid line order
#[tokio::test]
async fn malformed_debate_context_is_rejected_before_payment() -> anyhow::Result<()> {
    let (ctx, _, _) = pair().await?;
    let before = ctx.pet_view("0").await?;
    for order in [0, 5] {
        let failed = ctx.debit("0", 1, vec![line(PRICE, order, 0, 0)]).await?;
        assert_refused(&failed, "bad_debate_order");
        unchanged(&ctx, &before, &failed).await?;
    }
    for id in ["", "not a debate id"] {
        let mut invalid = line(PRICE, 1, 0, 0);
        invalid["debate"]["id"] = json!(id);
        let failed = ctx.debit("0", 1, vec![invalid]).await?;
        assert_refused(&failed, "bad_debate_id");
        unchanged(&ctx, &before, &failed).await?;
    }
    Ok(())
}

// spec: add-debates › Debate transfer version contract › accepted gift version
// spec: add-debates › Debate debit contract › gift before settlement
#[tokio::test]
async fn either_pets_gift_invalidates_old_versions_and_current_versions_pass() -> anyhow::Result<()>
{
    let (ctx, alice, bob) = pair().await?;
    let cara = ctx.account("cara", 20).await?;
    let before = ctx.pet_view("0").await?;
    bob.call(ctx.contract.id(), "nft_transfer")
        .args_json(
            json!({"receiver_id": cara.id(), "token_id": "1", "approval_id": null, "memo": null}),
        )
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(ctx.pet_view("1").await?["transfer_generation"], 1);
    let old_other = ctx.debit("0", 1, vec![line(PRICE, 1, 0, 0)]).await?;
    assert_refused(&old_other, "gift_version_changed");
    unchanged(&ctx, &before, &old_other).await?;

    alice
        .call(ctx.contract.id(), "nft_transfer")
        .args_json(
            json!({"receiver_id": bob.id(), "token_id": "0", "approval_id": null, "memo": null}),
        )
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(ctx.pet_view("0").await?["transfer_generation"], 1);
    let before = ctx.pet_view("0").await?;
    let old_speaker = ctx.debit("0", 1, vec![line(PRICE, 1, 0, 1)]).await?;
    assert_refused(&old_speaker, "gift_version_changed");
    unchanged(&ctx, &before, &old_speaker).await?;
    ctx.debit("0", 1, vec![line(PRICE, 1, 1, 1)])
        .await?
        .into_result()?;
    Ok(())
}

// spec: add-debates › Debate debit contract › accepted line
#[tokio::test]
async fn maximal_debate_receipt_stays_within_log_budget_and_measures_gas() -> anyhow::Result<()> {
    let (ctx, _, _) = pair().await?;
    let mut thought = line(MAX_THOUGHT_PRICE, 4, 0, 0);
    thought["model"] = json!("m".repeat(64));
    let mut call = call_json();
    call["tokens_in"] = json!(u32::MAX);
    call["tokens_out"] = json!(u32::MAX);
    call["tokens_reasoning"] = json!(u32::MAX);
    thought["calls"] = json!([call.clone(), call.clone(), call.clone(), call]);
    let result = ctx.debit("0", 1, vec![thought]).await?;
    let logs = event_logs(&result);
    let bytes: usize = logs
        .iter()
        .map(|log| log.len() + "EVENT_JSON:".len())
        .sum::<usize>()
        + 19;
    let debit_gas = result.outcomes()[1].gas_burnt.as_gas();
    let total_gas = result.total_gas_burnt.as_gas();
    eprintln!(
        "debate_receipt_log_bytes_20_digit_token={bytes} debate_debit_gas={debit_gas} debate_line_total_gas={total_gas}"
    );
    result.into_result()?;
    assert!(bytes < 16_384, "debate receipt exceeds protocol log budget");
    Ok(())
}
