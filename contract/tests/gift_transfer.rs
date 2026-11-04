mod common;

use common::*;
use near_sdk::borsh;
use near_workspaces::{
    Account, AccountDetailsPatch, AccountId,
    result::ExecutionFinalResult,
    types::{Gas, KeyType, NearToken, SecretKey},
};
use serde_json::{Value, json};

/// The sandbox's up-front price floor is 0.001 NEAR for one Tgas.
const MILLI_NEAR: u128 = 1_000_000_000_000_000_000_000;
const GIFT_PREPAID_GAS: Gas = Gas::from_tgas(5);
/// Sandbox transaction admission cost: 5 Tgas prepaid plus 0.919523854717 Tgas of fees.
const GIFT_REQUIRED_GAS: u128 = 5_919_523_854_717_000_000_000;
const GIFT_GAS_RESERVE: u128 = 6 * MILLI_NEAR;

async fn transfer(
    ctx: &Ctx,
    caller: &Account,
    receiver: &str,
    token_id: &str,
    deposit: u128,
    memo: Option<&str>,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(caller
        .call(ctx.contract.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": receiver,
            "token_id": token_id,
            "approval_id": null,
            "memo": memo,
        }))
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?)
}

async fn owner_tokens(ctx: &Ctx, owner: &str) -> anyhow::Result<Value> {
    Ok(ctx
        .contract
        .view("nft_tokens_for_owner")
        .args_json(json!({ "account_id": owner }))
        .await?
        .json()?)
}

async fn state(ctx: &Ctx, token_id: &str, old: &str, new: &str) -> anyhow::Result<Value> {
    Ok(json!({
        "token": ctx.nft_token(token_id).await?,
        "pet": ctx.pet_view(token_id).await?,
        "old_supply": ctx.supply_for(old).await?,
        "new_supply": ctx.supply_for(new).await?,
        "old_list": owner_tokens(ctx, old).await?,
        "new_list": owner_tokens(ctx, new).await?,
        "storage": ctx.storage_usage().await?,
        "balance": ctx.contract_balance().await?.to_string(),
    }))
}

// spec: add-gift › Pet transfer contract › передача принята
#[tokio::test]
async fn owner_gives_the_whole_pet_with_one_standard_event() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let alice = ctx.account("alice", 20).await?;
    let bob = ctx.account("bob", 20).await?;
    let alice_id = alice.id().to_string();
    let bob_id = bob.id().to_string();
    ctx.mint(&alice_id, "Pixel", "Curious forever")
        .await?
        .into_result()?;
    ctx.set_pet("0", |pet| {
        pet.given_food = 123;
        pet.streak = 3;
        pet.freezes = 2;
        pet.outfits = 1;
    })
    .await?;
    let record_before = borsh::to_vec(&ctx.read_record("0").await?)?;
    let extra_before = ctx.nft_token("0").await?["metadata"]["extra"].clone();
    let pool_before = ctx.pool().await?;
    let balance_before = ctx.contract_balance().await?;

    let result = transfer(&ctx, &alice, &bob_id, "0", 1, None).await?;
    assert!(result.is_success(), "{:?}", result.failures());
    let events = event_logs(&result);
    assert_eq!(events.len(), 1, "{events:?}");
    let event: Value = serde_json::from_str(&events[0])?;
    assert_eq!(event["standard"], "nep171");
    assert_eq!(event["version"], "1.0.0");
    assert_eq!(event["event"], "nft_transfer");
    assert_eq!(
        event["data"],
        json!([{
            "old_owner_id": alice_id,
            "new_owner_id": bob_id,
            "token_ids": ["0"],
        }])
    );
    assert_eq!(ctx.nft_token("0").await?["owner_id"], json!(bob_id));
    assert_eq!(ctx.pet_view("0").await?["owner_id"], json!(bob_id));
    assert_eq!(ctx.nft_token("0").await?["metadata"]["extra"], extra_before);
    assert_eq!(borsh::to_vec(&ctx.read_record("0").await?)?, record_before);
    assert_eq!(ctx.supply_for(&alice_id).await?, "0");
    assert_eq!(ctx.supply_for(&bob_id).await?, "1");
    assert_eq!(owner_tokens(&ctx, &alice_id).await?, json!([]));
    assert_eq!(owner_tokens(&ctx, &bob_id).await?[0]["token_id"], "0");
    assert_eq!(ctx.hatch_view(&alice_id).await?["token_id"], "0");
    assert_eq!(ctx.pool().await?, pool_before);
    assert_eq!(ctx.contract_balance().await?, balance_before + 1);
    let former_owner_call = transfer(&ctx, &alice, &alice_id, "0", 1, None).await?;
    assert_refused(&former_owner_call, "not_owner");
    assert!(event_logs(&former_owner_call).is_empty());
    Ok(())
}

// spec: add-gift › Pet transfer contract › не владелец
// spec: add-gift › Pet transfer contract › не 1 yocto
// spec: add-gift › Pet transfer contract › unknown token
// spec: add-gift › Pet transfer contract › owner as receiver
// spec: add-gift › Pet transfer contract › memo непустой
#[tokio::test]
async fn refused_transfers_return_the_deposit_and_leave_no_event_or_state() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let alice = ctx.account("alice", 20).await?;
    let bob = ctx.account("bob", 20).await?;
    let alice_id = alice.id().to_string();
    let bob_id = bob.id().to_string();
    ctx.mint(&alice_id, "Pixel", "Curious forever")
        .await?
        .into_result()?;
    let before = state(&ctx, "0", &alice_id, &bob_id).await?;

    for (caller, receiver, token, deposit, memo, code) in [
        (&ctx.server, &bob_id, "0", 1, None, "not_owner"),
        (&bob, &bob_id, "0", 1, None, "not_owner"),
        (&alice, &bob_id, "0", 0, None, "one_yocto"),
        (&alice, &bob_id, "0", NEAR, None, "one_yocto"),
        (&alice, &bob_id, "missing", 1, None, "no_pet"),
        (
            &alice,
            &alice_id,
            "0",
            1,
            None,
            "Current and next owner must differ",
        ),
        (
            &alice,
            &bob_id,
            "0",
            1,
            Some("public words"),
            "memo_not_empty",
        ),
    ] {
        let signer_before = ctx.balance_of(caller.id()).await?;
        let refused = transfer(&ctx, caller, receiver, token, deposit, memo).await?;
        assert_refused(&refused, code);
        assert!(event_logs(&refused).is_empty());
        assert_eq!(state(&ctx, "0", &alice_id, &bob_id).await?, before);
        let signer_after = ctx.balance_of(caller.id()).await?;
        // A failed call burns gas, but its attached deposit is returned.
        assert!(
            signer_after + NEAR / 10 > signer_before,
            "deposit was not returned for {code}"
        );
    }
    Ok(())
}

// spec: add-gift › Pet transfer contract › передача принята × owner-list storage
#[tokio::test]
async fn transfer_storage_stays_within_the_birth_funded_owner_list_reserve() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let alice = ctx.account("alice", 20).await?;
    let carol = ctx.account("carol", 20).await?;
    let dan = ctx.account("dan", 20).await?;
    let bob = ctx.account("bob", 20).await?;
    let erin = ctx.account("erin", 20).await?;
    for (account, name) in [(&alice, "Pixel"), (&carol, "Biscuit"), (&dan, "Mochi")] {
        ctx.mint(&account.id().to_string(), name, "Curious forever")
            .await?
            .into_result()?;
    }
    let byte_cost = 10_000_000_000_000_000_000u128;
    let balance_before = ctx.contract_balance().await?;
    let pool_before = ctx.pool().await?;
    let initial_storage = ctx.storage_usage().await?;
    let mut previous = initial_storage;
    for (caller, receiver, token) in [(&alice, &bob, "0"), (&carol, &bob, "1"), (&dan, &erin, "2")]
    {
        let result = transfer(&ctx, caller, &receiver.id().to_string(), token, 1, None).await?;
        result.into_result()?;
        let after = ctx.storage_usage().await?;
        let delta = i128::from(after) - i128::from(previous);
        eprintln!(
            "gift transfer {token}: {delta} storage bytes, {} yocto stake delta",
            delta * byte_cost as i128
        );
        assert!(delta <= i128::from(nearling_contract::limits::OWNER_LIST_ENTRY_BYTES));
        previous = after;
    }
    assert_eq!(ctx.contract_balance().await?, balance_before + 3);
    assert_eq!(ctx.pool().await?, pool_before);
    // The three birth reserves cover even three newly populated owner lists.
    let growth = previous.saturating_sub(initial_storage);
    assert!(growth <= 3 * nearling_contract::limits::OWNER_LIST_ENTRY_BYTES);
    assert!(ctx.contract_balance().await? >= u128::from(previous) * byte_cost);
    Ok(())
}

async fn transfer_with_gift_gas(
    ctx: &Ctx,
    signer: &Account,
    receiver: &Account,
    token_id: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(signer
        .call(ctx.contract.id(), "nft_transfer")
        .args_json(json!({
            "receiver_id": receiver.id(),
            "token_id": token_id,
            "approval_id": null,
            "memo": null,
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(GIFT_PREPAID_GAS)
        .transact()
        .await?)
}

// spec: add-gift › Gift transaction data › аккаунта дарящего нет в сети
// spec: add-gift › Gift transaction data › газ уже доливали
#[tokio::test]
async fn a_gift_needs_its_deposit_prepaid_gas_and_receipt_fees() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let receiver = ctx.account("receiver", 20).await?;

    // The signer is as long as a Privy implicit account. Measure the gas actually burned,
    // then prove that the chosen prepaid amount can run the whole transaction.
    let rich = ctx.account(&"a".repeat(54), 20).await?;
    assert_eq!(rich.id().as_str().len(), 64);
    ctx.mint(&rich.id().to_string(), "Pixel", "Curious forever")
        .await?
        .into_result()?;
    let result = transfer_with_gift_gas(&ctx, &rich, &receiver, "0").await?;
    assert!(result.is_success(), "{:?}", result.failures());
    let burnt = result.total_gas_burnt.as_gas();
    eprintln!(
        "gift: burnt {burnt} gas, prepaid {} gas, reserve {GIFT_GAS_RESERVE} yocto",
        GIFT_PREPAID_GAS.as_gas()
    );
    assert!(burnt < GIFT_PREPAID_GAS.as_gas());
    assert!(GIFT_GAS_RESERVE >= GIFT_REQUIRED_GAS);

    let exact = ctx.account(&"b".repeat(54), 1).await?;
    ctx.mint(&exact.id().to_string(), "Biscuit", "Curious forever")
        .await?
        .into_result()?;
    // One yocto under the sandbox's measured admission cost is rejected before the
    // contract runs. This includes the attached 1 yocto and the receipt fees.
    let short_amount = GIFT_REQUIRED_GAS;
    let mut details: AccountDetailsPatch = ctx.worker.view_account(exact.id()).await?.into();
    details.balance = Some(NearToken::from_yoctonear(short_amount));
    ctx.worker
        .patch(exact.id())
        .account(details)
        .transact()
        .await?;
    assert_eq!(ctx.balance_of(exact.id()).await?, short_amount);
    let rejected = transfer_with_gift_gas(&ctx, &exact, &receiver, "1")
        .await
        .expect_err("one yocto below the measured requirement must be insufficient");
    let rejection = format!("{rejected:?}");
    eprintln!("gift one yocto below admission balance: {rejection}");
    assert!(rejection.contains("NotEnoughBalance"), "{rejection}");
    assert_eq!(ctx.nft_token("1").await?["owner_id"], exact.id().as_str());

    let full = ctx.account(&"c".repeat(54), 1).await?;
    ctx.mint(&full.id().to_string(), "Mochi", "Curious forever")
        .await?
        .into_result()?;
    let mut details: AccountDetailsPatch = ctx.worker.view_account(full.id()).await?.into();
    details.balance = Some(NearToken::from_yoctonear(GIFT_REQUIRED_GAS + 1));
    ctx.worker
        .patch(full.id())
        .account(details)
        .transact()
        .await?;
    assert_eq!(ctx.balance_of(full.id()).await?, GIFT_REQUIRED_GAS + 1);
    let full_result = full
        .call(ctx.contract.id(), "nft_transfer")
        .args_json(json!({"receiver_id": receiver.id(), "token_id": "2", "approval_id": null, "memo": null}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(GIFT_PREPAID_GAS)
        .transact()
        .await?;
    assert!(full_result.is_success(), "{:?}", full_result.failures());
    assert_eq!(
        ctx.nft_token("2").await?["owner_id"],
        receiver.id().as_str()
    );
    Ok(())
}

// spec: add-gift › Gift transaction data › аккаунта дарящего нет в сети
#[tokio::test]
async fn a_top_up_creates_an_implicit_giver_who_can_sign_the_gift() -> anyhow::Result<()> {
    let ctx = setup(BIG_POOL).await?;
    let receiver = ctx.account("receiver", 20).await?;
    let key = SecretKey::from_seed(KeyType::ED25519, "nearling-gift-implicit-giver");
    let id: AccountId = key
        .public_key()
        .key_data()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .parse()?;
    assert_eq!(id.as_str().len(), 64);
    assert!(ctx.worker.view_account(&id).await.is_err());
    ctx.mint(id.as_str(), "Pixel", "Curious forever")
        .await?
        .into_result()?;
    let funder_before = ctx.balance_of(ctx.funder.id()).await?;
    let top_up = GIFT_GAS_RESERVE + 1;
    ctx.funder
        .transfer_near(&id, NearToken::from_yoctonear(top_up))
        .await?
        .into_result()?;
    let funder_spent = funder_before - ctx.balance_of(ctx.funder.id()).await?;
    eprintln!("implicit gift giver: top-up {top_up} yocto, funder spent {funder_spent} yocto");
    assert_eq!(ctx.balance_of(&id).await?, top_up);
    assert!(funder_spent >= top_up + 7 * MILLI_NEAR);
    let giver = Account::from_secret_key(id, key, &ctx.worker);
    let result = transfer_with_gift_gas(&ctx, &giver, &receiver, "0").await?;
    assert!(result.is_success(), "{:?}", result.failures());
    assert_eq!(
        ctx.nft_token("0").await?["owner_id"],
        receiver.id().as_str()
    );
    Ok(())
}
