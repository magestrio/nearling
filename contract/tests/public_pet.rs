mod common;

use common::*;
use serde_json::{Value, json};

const CHARACTER: &str = "I'm bright and bouncy, and good news makes me want to celebrate.";

fn keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

// spec: add-pet › Public pet data › питомец в эксплорере
#[tokio::test]
async fn the_explorer_shows_the_owner_name_character_food_and_receipts_but_no_words()
-> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let born = ctx.mint("alice.near", "Pixel", CHARACTER).await?;
    let birth_events = event_logs(&born);
    born.into_result()?;

    // In the state: the owner, the name, the character, the food. Nothing else is stored about
    // a thought: the record has no field for a line or an answer.
    let pet = ctx.pet_view("0").await?;
    assert_eq!(pet["owner_id"], "alice.near");
    assert_eq!(pet["name"], "Pixel");
    assert_eq!(pet["character"], CHARACTER);
    assert_eq!(pet["project_food"], STARTER_FOOD.to_string());
    assert_eq!(
        keys(&pet),
        [
            "born_at",
            "character",
            "debit_day",
            "debited_today",
            "freezes",
            "friend_snack_day",
            "friend_snacks",
            "given_food",
            "jobs_today",
            "last_debit_id",
            "last_streak_day",
            "name",
            "outfits",
            "owner_id",
            "owner_snack_at",
            "project_food",
            "stage",
            "stage_day",
            "streak",
            "traits",
            "work_known",
        ]
    );

    // The birth event carries the character's hash, not its text.
    let pet_born: Value = serde_json::from_str(&birth_events[1])?;
    assert_eq!(pet_born["event"], "pet_born");
    assert_eq!(pet_born["data"]["owner_id"], "alice.near");
    assert_eq!(
        pet_born["data"]["character_sha256"].as_str().unwrap().len(),
        64
    );
    assert!(!birth_events[1].contains("bouncy"));

    // A debit leaves a receipt per thought: hashes, signature, its kind, the signer, the tokens.
    ctx.set_pet("0", |pet| pet.given_food = 10_000_000_000_000_000_000_000)
        .await?;
    let hashed = json!({
        "req_sha256": "1".repeat(64),
        "res_sha256": "2".repeat(64),
        "signature": format!("0x{}", "3".repeat(130)),
        "sig_kind": "provider_tee",
        "signer": format!("0x{}", "4".repeat(40)),
        "tokens_in": 2310,
        "tokens_out": 31,
        "tokens_reasoning": 7,
        "cut": true,
    });
    let thought =
        json!({ "model": "Qwen/Qwen3.8-27B", "price": "1234567", "calls": [hashed.clone()] });
    let debit = ctx.debit("0", 1, vec![thought.clone(), thought]).await?;
    let receipts = event_logs(&debit);
    assert_eq!(receipts.len(), 2);
    let receipt: Value = serde_json::from_str(&receipts[0])?;
    assert_eq!(receipt["standard"], "nearling");
    assert_eq!(receipt["version"], "1.0.0");
    assert_eq!(receipt["event"], "receipt");
    let data = &receipt["data"];
    assert_eq!(
        keys(data),
        ["calls", "debit_id", "model", "price", "token_id"]
    );
    assert_eq!(data["token_id"], "0");
    assert_eq!(data["debit_id"], 1);
    assert_eq!(data["model"], "Qwen/Qwen3.8-27B");
    assert_eq!(data["price"], "1234567");
    assert_eq!(
        keys(&data["calls"][0]),
        [
            "cut",
            "req_sha256",
            "res_sha256",
            "sig_kind",
            "signature",
            "signer",
            "tokens_in",
            "tokens_out",
            "tokens_reasoning",
        ]
    );
    assert_eq!(data["calls"][0], hashed);
    // The food after the debit is public too.
    let after = ctx.pet_view("0").await?;
    let food: u128 = after["project_food"].as_str().unwrap().parse::<u128>()?
        + after["given_food"].as_str().unwrap().parse::<u128>()?;
    assert_eq!(
        food,
        STARTER_FOOD + 10_000_000_000_000_000_000_000 - 2 * 1_234_567
    );
    Ok(())
}

// spec: add-wardrobe › Earned outfit contract › вещь за серию записана × pet_view and nft_token
#[tokio::test]
async fn pet_view_and_the_token_list_the_items_as_ids_ascending() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    ctx.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([]));
    let extra = |token: &Value| -> anyhow::Result<Value> {
        Ok(serde_json::from_str(
            token["metadata"]["extra"].as_str().unwrap(),
        )?)
    };
    assert_eq!(
        extra(&ctx.nft_token("0").await?)?,
        json!({ "stage": "Baby", "traits": [], "outfits": [] })
    );

    // Bits 6, 0 and 2 set out of order: both reads give the ids ascending.
    ctx.set_pet("0", |pet| pet.outfits = 0b0100_0101).await?;
    assert_eq!(ctx.pet_view("0").await?["outfits"], json!([0, 2, 6]));
    let token = ctx.nft_token("0").await?;
    assert_eq!(
        extra(&token)?,
        json!({ "stage": "Baby", "traits": [], "outfits": [0, 2, 6] })
    );
    assert_eq!(token["owner_id"], "alice.near");
    Ok(())
}
