mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use nearling_contract::limits::MAX_CHARACTER_BYTES;
use nearling_contract::pet::{PetV2, VersionedPet};
use serde_json::{Value, json};

const CHARACTER: &str = "I am curious about everything.";

/// A sandbox with the pet "0" born to `alice.near` today (UTC), clear of 00:00.
async fn with_newborn() -> anyhow::Result<Ctx> {
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    ctx.mint("alice.near", "Pixel", CHARACTER)
        .await?
        .into_result()?;
    Ok(ctx)
}

/// The same, with the last stage change a day old: a transition may be written now.
async fn with_due_pet() -> anyhow::Result<Ctx> {
    let ctx = with_newborn().await?;
    ctx.age_stage_by_a_day("0").await?;
    Ok(ctx)
}

async fn today(ctx: &Ctx) -> anyhow::Result<u64> {
    Ok(ctx.hatch_view("nobody.near").await?["day"]
        .as_u64()
        .unwrap())
}

fn trait_words(pet: &Value) -> Vec<String> {
    pet["traits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap().to_string())
        .collect()
}

// spec: add-pet-life › Pet growth contract › чужой вызов
#[tokio::test]
async fn a_foreign_caller_cannot_grow_a_pet() -> anyhow::Result<()> {
    let ctx = with_due_pet().await?;
    let pet = ctx.pet_view("0").await?;

    let before = ctx.snapshot("alice.near").await?;
    for caller in [&ctx.funder, &ctx.treasury] {
        let refused = ctx.grow_as(caller, "0", "Teen", "clever").await?;
        assert_refused(&refused, "not_server");
        assert!(event_logs(&refused).is_empty());
    }
    assert_eq!(ctx.snapshot("alice.near").await?, before);
    // The owner of the pet is not the server either.
    let owner = ctx.account("keeper", 2).await?;
    ctx.mint(owner.id().as_str(), "Biscuit", CHARACTER)
        .await?
        .into_result()?;
    ctx.age_stage_by_a_day("1").await?;
    let refused = ctx.grow_as(&owner, "1", "Teen", "clever").await?;
    assert_refused(&refused, "not_server");
    assert_eq!(ctx.pet_view("1").await?["stage"], "Baby");

    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.pet_view("0").await?["stage"], "Baby");
    assert!(trait_words(&ctx.pet_view("0").await?).is_empty());
    Ok(())
}

// spec: add-pet-life › Pet growth contract › чужой вызов × a deposit attached
#[tokio::test]
async fn a_deposit_is_refused_even_from_the_server() -> anyhow::Result<()> {
    let ctx = with_due_pet().await?;
    let before = ctx.snapshot("alice.near").await?;
    let pet = ctx.pet_view("0").await?;

    let with_deposit = ctx
        .server
        .call(ctx.contract.id(), "pet_grow")
        .args_json(json!({ "token_id": "0", "stage": "Teen", "trait": "clever" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(with_deposit.is_failure());
    assert!(event_logs(&with_deposit).is_empty());

    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.snapshot("alice.near").await?, before);
    Ok(())
}

// spec: add-pet-life › Pet growth contract › стадия не следующая
#[tokio::test]
async fn only_the_next_stage_passes_and_a_refusal_changes_nothing() -> anyhow::Result<()> {
    let ctx = with_due_pet().await?;
    let pet = ctx.pet_view("0").await?;
    let snapshot = ctx.snapshot("alice.near").await?;

    // A baby: the same, and one step skipped.
    for stage in ["Baby", "Adult"] {
        let refused = ctx.grow("0", stage, "clever").await?;
        assert_refused(&refused, "bad_stage");
        assert!(event_logs(&refused).is_empty());
        assert_eq!(ctx.pet_view("0").await?, pet);
    }
    assert_eq!(ctx.snapshot("alice.near").await?, snapshot);

    ctx.grow("0", "Teen", "clever").await?.into_result()?;
    ctx.age_stage_by_a_day("0").await?;
    // A teen: the same, and the previous.
    let teen = ctx.pet_view("0").await?;
    for stage in ["Teen", "Baby"] {
        let refused = ctx.grow("0", stage, "sociable").await?;
        assert_refused(&refused, "bad_stage");
        assert_eq!(ctx.pet_view("0").await?, teen);
    }

    ctx.grow("0", "Adult", "sociable").await?.into_result()?;
    ctx.age_stage_by_a_day("0").await?;
    // An adult: the same, the previous, the one before, and «after adult» has no name.
    let adult = ctx.pet_view("0").await?;
    for stage in ["Adult", "Teen", "Baby"] {
        let refused = ctx.grow("0", stage, "cozy").await?;
        assert_refused(&refused, "bad_stage");
        assert_eq!(ctx.pet_view("0").await?, adult);
    }
    let refused = ctx.grow("0", "Elder", "cozy").await?;
    assert!(refused.is_failure());
    assert_eq!(ctx.pet_view("0").await?, adult);

    // The stage is checked before the day: a wrong stage on a day that is already used.
    let fresh = ctx.account("fresh", 2).await?;
    ctx.mint(fresh.id().as_str(), "Biscuit", CHARACTER)
        .await?
        .into_result()?;
    let refused = ctx.grow("1", "Baby", "clever").await?;
    assert_refused(&refused, "bad_stage");
    Ok(())
}

// spec: add-pet-life › Pet growth contract › второе изменение стадии за сутки
#[tokio::test]
async fn a_pet_changes_its_stage_once_a_utc_day_and_the_birth_counts() -> anyhow::Result<()> {
    let ctx = with_newborn().await?;
    let day = today(&ctx).await?;
    let newborn = ctx.pet_view("0").await?;
    assert_eq!(newborn["stage_day"], day);

    // The birth was today: no transition yet.
    let refused = ctx.grow("0", "Teen", "clever").await?;
    assert_refused(&refused, "stage_today");
    assert!(event_logs(&refused).is_empty());
    assert_eq!(ctx.pet_view("0").await?, newborn);

    // A day later it passes and takes the day.
    ctx.age_stage_by_a_day("0").await?;
    ctx.grow("0", "Teen", "clever").await?.into_result()?;
    assert_eq!(ctx.pet_view("0").await?["stage_day"], day);

    // The transition counts too.
    let teen = ctx.pet_view("0").await?;
    let refused = ctx.grow("0", "Adult", "clever").await?;
    assert_refused(&refused, "stage_today");
    assert_eq!(ctx.pet_view("0").await?, teen);

    ctx.age_stage_by_a_day("0").await?;
    ctx.grow("0", "Adult", "clever").await?.into_result()?;
    assert_eq!(ctx.pet_view("0").await?["stage"], "Adult");
    // The real `block_timestamp` boundary is the unit test in `src/lib.rs`.
    Ok(())
}

// spec: add-pet-life › Pet growth contract › черта не из списка
#[tokio::test]
async fn a_trait_outside_the_five_fails_before_anything_is_written() -> anyhow::Result<()> {
    let ctx = with_due_pet().await?;
    let pet = ctx.pet_view("0").await?;
    let snapshot = ctx.snapshot("alice.near").await?;

    for bad in ["brave", "Clever", "hard-working", "", " cozy"] {
        let refused = ctx.grow("0", "Teen", bad).await?;
        assert!(refused.is_failure(), "{bad:?} must fail");
        assert!(event_logs(&refused).is_empty());
    }
    for args in [
        json!({ "token_id": "0", "stage": "Teen" }),
        json!({ "token_id": "0", "stage": "Teen", "trait": null }),
        json!({ "token_id": "0", "stage": "Teen", "trait": 3 }),
    ] {
        let refused = ctx
            .server
            .call(ctx.contract.id(), "pet_grow")
            .args_json(args)
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        assert!(refused.is_failure());
    }
    assert_eq!(ctx.pet_view("0").await?, pet);
    assert_eq!(ctx.snapshot("alice.near").await?, snapshot);

    // All five are accepted, one per pet.
    for (n, word) in ["clever", "sociable", "hard_working", "thoughtful", "cozy"]
        .into_iter()
        .enumerate()
    {
        if n > 0 {
            let receiver = ctx.account(&format!("pet{n}"), 2).await?;
            ctx.mint(receiver.id().as_str(), "Biscuit", CHARACTER)
                .await?
                .into_result()?;
            ctx.age_stage_by_a_day(&n.to_string()).await?;
        }
        ctx.grow(&n.to_string(), "Teen", word)
            .await?
            .into_result()?;
        assert_eq!(
            trait_words(&ctx.pet_view(&n.to_string()).await?),
            vec![word.to_string()]
        );
    }
    Ok(())
}

// spec: add-pet-life › Pet growth contract › стадия не следующая × a pet that does not exist
#[tokio::test]
async fn a_pet_that_does_not_exist_cannot_grow() -> anyhow::Result<()> {
    let ctx = with_due_pet().await?;
    let snapshot = ctx.snapshot("alice.near").await?;
    let refused = ctx.grow("7", "Teen", "clever").await?;
    assert_refused(&refused, "no_pet");
    // Not a stage error, whatever the stage says.
    let refused = ctx.grow("7", "Adult", "clever").await?;
    assert_refused(&refused, "no_pet");
    assert_eq!(ctx.snapshot("alice.near").await?, snapshot);
    Ok(())
}

// spec: add-pet-life › Pet growth contract › стадия не следующая × a written transition in order
#[tokio::test]
async fn a_written_transition_is_public_in_the_event_the_view_and_the_token() -> anyhow::Result<()>
{
    let ctx = with_due_pet().await?;
    let storage = ctx.storage_usage().await?;
    let balance = ctx.contract_balance().await?;
    let pool = ctx.pool().await?;

    let teen = ctx.grow("0", "Teen", "clever").await?;
    let events = event_logs(&teen);
    teen.into_result()?;
    assert_eq!(events.len(), 1, "{events:?}");
    let event: Value = serde_json::from_str(&events[0])?;
    assert_eq!(event["standard"], "nearling");
    assert_eq!(event["version"], "1.0.0");
    assert_eq!(event["event"], "grow");
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "stage": "Teen", "trait": "clever" })
    );
    let view = ctx.pet_view("0").await?;
    assert_eq!(view["stage"], "Teen");
    assert_eq!(view["stage_day"], today(&ctx).await?);
    assert_eq!(trait_words(&view), ["clever"]);

    // No byte, no money moved: the pool, the stake and the balance stay.
    assert_eq!(ctx.storage_usage().await?, storage);
    assert_eq!(ctx.pool().await?, pool);
    assert!(ctx.contract_balance().await? >= balance);

    ctx.age_stage_by_a_day("0").await?;
    // The adult's trait may be the teen's: it grew stronger.
    let adult = ctx.grow("0", "Adult", "clever").await?;
    let events = event_logs(&adult);
    adult.into_result()?;
    let event: Value = serde_json::from_str(&events[0])?;
    assert_eq!(
        event["data"],
        json!({ "token_id": "0", "stage": "Adult", "trait": "clever" })
    );
    let view = ctx.pet_view("0").await?;
    assert_eq!(view["stage"], "Adult");
    assert_eq!(trait_words(&view), ["clever", "clever"]);
    assert_eq!(ctx.storage_usage().await?, storage);

    // `nft_token` carries the same, as NEP-177 `extra`, and the rest of the standard's fields stay.
    let token = ctx.nft_token("0").await?;
    assert_eq!(token["token_id"], "0");
    assert_eq!(token["owner_id"], "alice.near");
    let extra: Value = serde_json::from_str(token["metadata"]["extra"].as_str().unwrap())?;
    assert_eq!(
        extra,
        json!({ "stage": "Adult", "traits": ["clever", "clever"], "outfits": [] })
    );
    assert!(token["metadata"]["title"].is_null());
    assert_eq!(ctx.nft_token("9").await?, Value::Null);

    // A teen's trait differs from the adult's: both are listed in the order gained.
    let other = ctx.account("other", 2).await?;
    ctx.mint(other.id().as_str(), "Biscuit", CHARACTER)
        .await?
        .into_result()?;
    ctx.age_stage_by_a_day("1").await?;
    ctx.grow("1", "Teen", "cozy").await?.into_result()?;
    ctx.age_stage_by_a_day("1").await?;
    ctx.grow("1", "Adult", "sociable").await?.into_result()?;
    assert_eq!(trait_words(&ctx.pet_view("1").await?), ["cozy", "sociable"]);
    Ok(())
}

// spec: add-pet-life › Pet growth contract › чужой вызов × a pet of version 2
#[tokio::test]
async fn a_pet_of_version_2_reads_with_no_traits_and_grows_by_twenty_bytes() -> anyhow::Result<()> {
    let ctx = with_newborn().await?;
    let view = ctx.pet_view("0").await?;
    let amount = |k: &str| -> u128 { view[k].as_str().unwrap().parse().unwrap() };
    let day = today(&ctx).await?;
    // The record `add-feeding` wrote, patched in.
    let v2 = PetV2 {
        name: view["name"].as_str().unwrap().to_string(),
        character: view["character"].as_str().unwrap().to_string(),
        born_at: view["born_at"].as_u64().unwrap(),
        project_food: amount("project_food"),
        given_food: amount("given_food"),
        debit_day: 0,
        debited_today: 0,
        last_debit_id: 0,
        stage: nearling_contract::pet::Stage::Baby,
        stage_day: day - 1,
        streak: 0,
        freezes: 1,
        friend_snack_day: 0,
        friend_snacks: 0,
        owner_snack_at: 0,
    };
    ctx.put_record("0", VersionedPet::V2(v2)).await?;

    let old = ctx.pet_view("0").await?;
    assert_eq!(old["stage"], "Baby");
    assert!(trait_words(&old).is_empty());
    let extra: Value = serde_json::from_str(
        ctx.nft_token("0").await?["metadata"]["extra"]
            .as_str()
            .unwrap(),
    )?;
    assert_eq!(
        extra,
        json!({ "stage": "Baby", "traits": [], "outfits": [] })
    );

    // A foreign caller is refused on the old record too.
    let refused = ctx.grow_as(&ctx.funder, "0", "Teen", "clever").await?;
    assert_refused(&refused, "not_server");

    // The first write upgrades the record in place to the current one: the traits (2 bytes) and,
    // since `add-daily-ritual`, the counted streak day (8) and, since `add-wardrobe`, the items
    // (1), since `add-pet-work`, the job counter (9), and the public wish reserve (17),
    // paid by the project's pool.
    let storage = ctx.storage_usage().await?;
    let pool = ctx.pool().await?;
    ctx.grow("0", "Teen", "cozy").await?.into_result()?;
    // spec: add-pet-will › Will reserve contract › start accepted
    assert_eq!(ctx.storage_usage().await? - storage, 37);
    assert_eq!(
        pool - ctx.pool().await?,
        37 * 10_000_000_000_000_000_000u128
    );
    assert_eq!(trait_words(&ctx.pet_view("0").await?), ["cozy"]);
    assert_eq!(ctx.pet_view("0").await?["stage"], "Teen");

    // From then on a transition writes no byte.
    ctx.age_stage_by_a_day("0").await?;
    let storage = ctx.storage_usage().await?;
    ctx.grow("0", "Adult", "cozy").await?.into_result()?;
    assert_eq!(ctx.storage_usage().await?, storage);
    Ok(())
}

/// The prepaid gas of `pet_grow` as the Worker sends it, on the worst case: the longest character
/// (read and written whole with the record), a 64-byte owner, the adult step with the longest
/// trait word. Read from the Worker's source.
#[tokio::test]
async fn gas_of_a_grow() -> anyhow::Result<()> {
    let prepaid: Gas = tgas_const("PET_GROW_TGAS");
    let ctx = setup(BIG_POOL).await?;
    ctx.avoid_midnight().await?;
    let receiver = "a".repeat(64);
    let name = "🚀".repeat(8);
    let character = "x".repeat(MAX_CHARACTER_BYTES);
    ctx.mint(&receiver, &name, &character)
        .await?
        .into_result()?;

    let mut most = 0;
    for (stage, word) in [("Teen", "hard_working"), ("Adult", "hard_working")] {
        ctx.age_stage_by_a_day("0").await?;
        let result = ctx
            .server
            .call(ctx.contract.id(), "pet_grow")
            .args_json(json!({ "token_id": "0", "stage": stage, "trait": word }))
            .gas(prepaid)
            .transact()
            .await?;
        let burnt = result.total_gas_burnt.as_gas();
        eprintln!(
            "gas_of_a_grow: {stage} burnt {burnt} gas, prepaid {} gas",
            prepaid.as_gas()
        );
        assert!(result.is_success(), "{:?}", result.failures());
        assert!(burnt < prepaid.as_gas());
        most = most.max(burnt);
    }
    eprintln!("gas_of_a_grow: most {most} gas");
    Ok(())
}
