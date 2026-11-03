//! Shared setup of the sandbox tests: the wasm built from the crate as it is now (never a
//! stale artifact), a contract with a server, a treasury and a funder, and small helpers.
#![allow(dead_code)]

use std::sync::OnceLock;

use near_contract_standards::non_fungible_token::NonFungibleToken;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::store::key::Sha256;
use near_sdk::store::{LookupMap, LookupSet};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountDetailsPatch, AccountId, Contract, Worker};
use nearling_contract::limits::DAY_NS;
#[allow(unused_imports)]
pub use nearling_contract::limits::STARTER_FOOD;
use nearling_contract::pet::{Pet, VersionedPet};
use serde_json::{Value, json};

pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// 1 NEAR of pool is far more than any birth costs.
pub const BIG_POOL: u128 = NEAR;

static WASM: OnceLock<Vec<u8>> = OnceLock::new();

pub fn wasm() -> &'static [u8] {
    WASM.get_or_init(|| {
        let path = cargo_near_build::build_with_cli(Default::default())
            .unwrap_or_else(|e| panic!("wasm build failed: {e:?}"));
        std::fs::read(path).expect("read the built wasm")
    })
}

/// The contract's state layout, mirrored so a test can move the birth counter's day. A change of
/// the layout makes `from_slice` fail loudly here.
#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
struct StateMirror {
    owner_id: near_sdk::AccountId,
    server_id: near_sdk::AccountId,
    treasury_id: near_sdk::AccountId,
    tokens: NonFungibleToken,
    pets: LookupMap<String, VersionedPet>,
    hatched: LookupMap<near_sdk::AccountId, String>,
    births_day: u64,
    births_today: u32,
    next_token_id: u64,
    pool: u128,
    known: LookupSet<(String, near_sdk::AccountId), Sha256>,
    riddle_commits: LookupMap<u64, [u8; 32]>,
    riddle_reserve: u128,
    work_pairs: LookupSet<(String, String), Sha256>,
    work_index: LookupMap<u64, Vec<u64>>,
}

pub struct Ctx {
    pub worker: Worker<Sandbox>,
    pub contract: Contract,
    pub server: Account,
    pub treasury: Account,
    pub funder: Account,
}

/// A sandbox with the contract initialized and `pool` yoctoNEAR in its pool.
pub async fn setup(pool: u128) -> anyhow::Result<Ctx> {
    let wasm = wasm();
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let make = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            let account = root
                .create_subaccount(name)
                .initial_balance(NearToken::from_yoctonear(near * NEAR))
                .transact()
                .await?
                .into_result()?;
            anyhow::Ok(account)
        }
    };
    let server = make("server", 100).await?;
    let treasury = make("treasury", 1).await?;
    let funder = make("funder", 100).await?;
    let owner = make("owner", 1).await?;
    let contract = worker.dev_deploy(wasm).await?;
    contract
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "server_id": server.id(),
            "treasury_id": treasury.id(),
        }))
        .transact()
        .await?
        .into_result()?;
    let ctx = Ctx {
        worker,
        contract,
        server,
        treasury,
        funder,
    };
    if pool > 0 {
        ctx.fund(pool).await?;
    }
    Ok(ctx)
}

impl Ctx {
    pub async fn fund(&self, yocto: u128) -> anyhow::Result<()> {
        self.funder
            .call(self.contract.id(), "pool_fund")
            .deposit(NearToken::from_yoctonear(yocto))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn mint_as(
        &self,
        caller: &Account,
        receiver: &str,
        name: &str,
        character: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.contract.id(), "pet_mint")
            .args_json(json!({ "receiver": receiver, "name": name, "character": character }))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?)
    }

    pub async fn mint(
        &self,
        receiver: &str,
        name: &str,
        character: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.mint_as(&self.server, receiver, name, character).await
    }

    pub async fn debit_as(
        &self,
        caller: &Account,
        token_id: &str,
        debit_id: u64,
        thoughts: Vec<Value>,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.contract.id(), "debit_session")
            .args_json(json!({ "token_id": token_id, "debit_id": debit_id, "thoughts": thoughts }))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?)
    }

    pub async fn debit(
        &self,
        token_id: &str,
        debit_id: u64,
        thoughts: Vec<Value>,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.debit_as(&self.server, token_id, debit_id, thoughts)
            .await
    }

    /// A pet "0" born to `alice.near` whose food is set to the given amounts.
    pub async fn pet_with_food(&self, project: u128, given: u128) -> anyhow::Result<()> {
        self.mint("alice.near", "Pixel", "I am curious.")
            .await?
            .into_result()?;
        self.set_pet("0", |pet| {
            pet.project_food = project;
            pet.given_food = given;
        })
        .await
    }

    pub async fn hatch_view(&self, account: &str) -> anyhow::Result<Value> {
        Ok(self
            .contract
            .view("hatch_view")
            .args_json(json!({ "account_id": account }))
            .await?
            .json()?)
    }

    pub async fn pet_view(&self, token_id: &str) -> anyhow::Result<Value> {
        Ok(self
            .contract
            .view("pet_view")
            .args_json(json!({ "token_id": token_id }))
            .await?
            .json()?)
    }

    pub async fn supply_for(&self, account: &str) -> anyhow::Result<String> {
        Ok(self
            .contract
            .view("nft_supply_for_owner")
            .args_json(json!({ "account_id": account }))
            .await?
            .json()?)
    }

    pub async fn feed_as(
        &self,
        caller: &Account,
        token_id: &str,
        deposit: u128,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.contract.id(), "pet_feed")
            .args_json(json!({ "token_id": token_id }))
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?)
    }

    pub async fn snack_as(
        &self,
        caller: &Account,
        token_id: &str,
        feeder: &str,
        kind: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.contract.id(), "pet_snack")
            .args_json(json!({ "token_id": token_id, "feeder": feeder, "kind": kind }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?)
    }

    pub async fn snack(
        &self,
        token_id: &str,
        feeder: &str,
        kind: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.snack_as(&self.server, token_id, feeder, kind).await
    }

    pub async fn knows(&self, token_id: &str, account: &str) -> anyhow::Result<bool> {
        Ok(self
            .contract
            .view("pet_knows")
            .args_json(json!({ "token_id": token_id, "account_id": account }))
            .await?
            .json()?)
    }

    /// A funded sandbox account, named by the caller.
    pub async fn account(&self, name: &str, near: u128) -> anyhow::Result<Account> {
        Ok(self
            .worker
            .root_account()?
            .create_subaccount(name)
            .initial_balance(NearToken::from_yoctonear(near * NEAR))
            .transact()
            .await?
            .into_result()?)
    }

    pub async fn pool(&self) -> anyhow::Result<u128> {
        let view = self.hatch_view("nobody.near").await?;
        Ok(view["pool"].as_str().unwrap().parse()?)
    }

    pub async fn contract_balance(&self) -> anyhow::Result<u128> {
        Ok(self
            .worker
            .view_account(self.contract.id())
            .await?
            .balance
            .as_yoctonear())
    }

    pub async fn storage_usage(&self) -> anyhow::Result<u64> {
        Ok(self
            .worker
            .view_account(self.contract.id())
            .await?
            .storage_usage)
    }

    pub async fn balance_of(&self, id: &AccountId) -> anyhow::Result<u128> {
        Ok(self.worker.view_account(id).await?.balance.as_yoctonear())
    }

    /// Everything a refused call must leave as it was.
    pub async fn snapshot(&self, receiver: &str) -> anyhow::Result<Value> {
        Ok(json!({
            "hatch": self.hatch_view(receiver).await?,
            "supply": self.supply_for(receiver).await?,
            "storage": self.storage_usage().await?,
            "balance": self.contract_balance().await?.to_string(),
        }))
    }

    /// Rewrites a pet's record through the sandbox's state patch: the caps (0.005 / 0.05 NEAR) are
    /// above the starter food, and a test needs a pet at a given food or a given day's counter.
    pub async fn set_pet(&self, token_id: &str, edit: impl FnOnce(&mut Pet)) -> anyhow::Result<()> {
        // The stored record itself, not the view: the job counter's day is not in the view.
        let mut pet = self.read_record(token_id).await?.current();
        edit(&mut pet);
        self.put_record(token_id, VersionedPet::V6(pet)).await
    }

    /// Writes a record as it is, in any version: a test of an older pet needs the old bytes.
    pub async fn put_record(&self, token_id: &str, record: VersionedPet) -> anyhow::Result<()> {
        let mut key = b"p".to_vec();
        key.extend(borsh::to_vec(&token_id.to_string())?);
        let value = borsh::to_vec(&record)?;
        self.worker
            .patch_state(self.contract.id(), &key, &value)
            .await?;
        Ok(())
    }

    pub async fn grow_as(
        &self,
        caller: &Account,
        token_id: &str,
        stage: &str,
        r#trait: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.contract.id(), "pet_grow")
            .args_json(json!({ "token_id": token_id, "stage": stage, "trait": r#trait }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?)
    }

    pub async fn grow(
        &self,
        token_id: &str,
        stage: &str,
        r#trait: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.grow_as(&self.server, token_id, stage, r#trait).await
    }

    pub async fn nft_token(&self, token_id: &str) -> anyhow::Result<Value> {
        Ok(self
            .contract
            .view("nft_token")
            .args_json(json!({ "token_id": token_id }))
            .await?
            .json()?)
    }

    /// The pet's record one UTC day older: the last stage change "happened yesterday". Like
    /// `age_births_by_a_day`, this stands in for a clock past 00:00 UTC.
    pub async fn age_stage_by_a_day(&self, token_id: &str) -> anyhow::Result<()> {
        self.set_pet(token_id, |pet| pet.stage_day -= 1).await
    }

    /// The pet's last counted streak day `days` older: stands in for a clock `days` past 00:00
    /// UTC, as `age_stage_by_a_day` does for the stage (`fast_forward` to the next UTC day costs
    /// ~40 minutes; the real `block_timestamp` boundary is the unit tests in `src/lib.rs`).
    pub async fn age_streak_by_days(&self, token_id: &str, days: u64) -> anyhow::Result<()> {
        self.set_pet(token_id, |pet| {
            assert!(pet.last_streak_day > days, "a counted day to age");
            pet.last_streak_day -= days;
        })
        .await
    }

    /// The pet born `days` UTC days ago (its birth time moves back).
    pub async fn age_birth_by_days(&self, token_id: &str, days: u64) -> anyhow::Result<()> {
        self.set_pet(token_id, |pet| pet.born_at -= days * DAY_NS)
            .await
    }

    pub async fn streak_mark_as(
        &self,
        caller: &Account,
        token_id: &str,
        day: u64,
        skipped: u32,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.streak_mark_with(caller, token_id, day, skipped, Gas::from_tgas(30))
            .await
    }

    pub async fn streak_mark_with(
        &self,
        caller: &Account,
        token_id: &str,
        day: u64,
        skipped: u32,
        gas: Gas,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.contract.id(), "streak_mark")
            .args_json(json!({ "token_id": token_id, "day": day, "skipped": skipped }))
            .gas(gas)
            .transact()
            .await?)
    }

    pub async fn streak_mark(
        &self,
        token_id: &str,
        day: u64,
        skipped: u32,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.streak_mark_as(&self.server, token_id, day, skipped)
            .await
    }

    pub async fn outfit_grant_with(
        &self,
        caller: &Account,
        token_id: &str,
        gas: Gas,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.contract.id(), "outfit_grant")
            .args_json(json!({ "token_id": token_id }))
            .gas(gas)
            .transact()
            .await?)
    }

    pub async fn outfit_grant_as(
        &self,
        caller: &Account,
        token_id: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.outfit_grant_with(caller, token_id, Gas::from_tgas(30))
            .await
    }

    pub async fn outfit_grant(&self, token_id: &str) -> anyhow::Result<ExecutionFinalResult> {
        self.outfit_grant_as(&self.server, token_id).await
    }

    pub async fn outfit_buy_with(
        &self,
        caller: &Account,
        token_id: &str,
        item: u8,
        gas: Gas,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.contract.id(), "outfit_buy")
            .args_json(json!({ "token_id": token_id, "item": item }))
            .gas(gas)
            .transact()
            .await?)
    }

    pub async fn outfit_buy_as(
        &self,
        caller: &Account,
        token_id: &str,
        item: u8,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.outfit_buy_with(caller, token_id, item, Gas::from_tgas(30))
            .await
    }

    pub async fn outfit_buy(
        &self,
        token_id: &str,
        item: u8,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.outfit_buy_as(&self.server, token_id, item).await
    }

    pub async fn riddle_commit_as(
        &self,
        caller: &Account,
        hash: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.contract.id(), "riddle_commit")
            .args_json(json!({ "hash": hash }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?)
    }

    pub async fn riddle_commit(&self, hash: &str) -> anyhow::Result<ExecutionFinalResult> {
        self.riddle_commit_as(&self.server, hash).await
    }

    pub async fn riddle_reveal_as(
        &self,
        caller: &Account,
        day: u64,
        riddle: &str,
        answers: &[String],
        salt: &str,
        gas: Gas,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.contract.id(), "riddle_reveal")
            .args_json(json!({ "day": day, "riddle": riddle, "answers": answers, "salt": salt }))
            .gas(gas)
            .transact()
            .await?)
    }

    pub async fn riddle_view(&self, day: u64) -> anyhow::Result<Value> {
        Ok(self
            .contract
            .view("riddle_view")
            .args_json(json!({ "day": day }))
            .await?
            .json()?)
    }

    pub async fn fund_riddles(&self, yocto: u128) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self
            .server
            .call(self.contract.id(), "riddle_storage_fund")
            .deposit(NearToken::from_yoctonear(yocto))
            .transact()
            .await?)
    }

    /// Sets the riddle reserve in the state (the contract's balance is not touched).
    pub async fn set_riddle_reserve(&self, reserve: u128) -> anyhow::Result<()> {
        let state = self.read_state().await?;
        let mut mirror: StateMirror = borsh::from_slice(&state)?;
        mirror.riddle_reserve = reserve;
        self.worker
            .patch_state(self.contract.id(), b"STATE", &borsh::to_vec(&mirror)?)
            .await?;
        Ok(())
    }

    /// A commit of a past `day`, as if the server had sealed it then: the record in the trie and
    /// its bytes in the account's storage usage, so a reveal frees exactly what it took. The
    /// reserve is the caller's to set.
    pub async fn put_commit(&self, day: u64, hash: [u8; 32]) -> anyhow::Result<()> {
        let mut key = b"r".to_vec();
        key.extend(borsh::to_vec(&day)?);
        self.worker
            .patch_state(self.contract.id(), &key, &hash)
            .await?;
        let id = self.contract.id();
        let details = self.worker.view_account(id).await?;
        let usage = details.storage_usage;
        let mut patch: AccountDetailsPatch = details.into();
        patch.storage_usage = Some(usage + nearling_contract::limits::RIDDLE_COMMIT_BYTES);
        self.worker.patch(id).account(patch).transact().await?;
        Ok(())
    }

    /// Moves the birth counter's day one day back: the births counted so far "happened
    /// yesterday", which is what a clock past 00:00 UTC would show. (`fast_forward` to the next
    /// UTC day costs ~290,000 blocks, ~40 minutes; the real `block_timestamp` boundary is the unit
    /// test `the_utc_day_changes_at_the_block_timestamp_boundary`.)
    pub async fn age_births_by_a_day(&self) -> anyhow::Result<()> {
        let state = self.read_state().await?;
        let mut mirror: StateMirror = borsh::from_slice(&state)?;
        assert!(mirror.births_day > 0);
        mirror.births_day -= 1;
        self.worker
            .patch_state(self.contract.id(), b"STATE", &borsh::to_vec(&mirror)?)
            .await?;
        Ok(())
    }

    /// Sets the pool to `pool` in the state (the contract's balance is not touched).
    pub async fn set_pool(&self, pool: u128) -> anyhow::Result<()> {
        let state = self.read_state().await?;
        let mut mirror: StateMirror = borsh::from_slice(&state)?;
        mirror.pool = pool;
        self.worker
            .patch_state(self.contract.id(), b"STATE", &borsh::to_vec(&mirror)?)
            .await?;
        Ok(())
    }

    /// The contract's `STATE` record. A node refuses to view a contract's state past 50 kB by the
    /// account's `storage_usage`, even for one key: the number is lowered for this one read and put
    /// back.
    pub async fn read_state(&self) -> anyhow::Result<Vec<u8>> {
        Ok(self.read_key(b"STATE").await?.expect("the contract state"))
    }

    /// One key of the contract's trie, by the same lowered-usage read as `read_state`.
    pub async fn read_key(&self, key: &[u8]) -> anyhow::Result<Option<Vec<u8>>> {
        let id = self.contract.id();
        let details = self.worker.view_account(id).await?;
        let real_usage = details.storage_usage;
        let mut lowered: AccountDetailsPatch = details.into();
        lowered.storage_usage = Some(1);
        self.worker.patch(id).account(lowered).transact().await?;
        let raw = self.worker.view_state(id).prefix(key).await?;
        let mut restored: AccountDetailsPatch = self.worker.view_account(id).await?.into();
        restored.storage_usage = Some(real_usage);
        self.worker.patch(id).account(restored).transact().await?;
        Ok(raw.get(key).cloned())
    }

    /// The pet's stored record, in whatever version it is written.
    pub async fn read_record(&self, token_id: &str) -> anyhow::Result<VersionedPet> {
        let mut key = b"p".to_vec();
        key.extend(borsh::to_vec(&token_id.to_string())?);
        let bytes = self
            .read_key(&key)
            .await?
            .unwrap_or_else(|| panic!("a record of pet {token_id}"));
        Ok(borsh::from_slice(&bytes)?)
    }

    /// If the sandbox clock is within five minutes of 00:00 UTC, moves it past midnight, so a
    /// test that counts a UTC day does not straddle the boundary.
    pub async fn avoid_midnight(&self) -> anyhow::Result<()> {
        let now = self.block_timestamp().await?;
        let left_ns = DAY_NS - now % DAY_NS;
        if left_ns < 300_000_000_000 {
            // ~0.3 s of sandbox time per block, plus a margin
            self.worker
                .fast_forward(left_ns / 300_000_000 + 200)
                .await?;
        }
        Ok(())
    }

    pub async fn block_timestamp(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }
}

/// The failure text of a refused call (the contract's panic code is in it).
pub fn failure_text(result: &ExecutionFinalResult) -> String {
    format!("{:?}", result.failures())
}

pub fn assert_refused(result: &ExecutionFinalResult, code: &str) {
    assert!(
        result.is_failure(),
        "expected {code}, but the call succeeded"
    );
    let text = failure_text(result);
    assert!(text.contains(code), "expected {code} in: {text}");
}

pub fn event_logs(result: &ExecutionFinalResult) -> Vec<String> {
    result
        .logs()
        .into_iter()
        .filter(|l| l.starts_with("EVENT_JSON:"))
        .map(|l| l.trim_start_matches("EVENT_JSON:").to_string())
        .collect()
}

/// One call of a thought with realistic field lengths.
pub fn call_json() -> Value {
    json!({
        "req_sha256": "a".repeat(64),
        "res_sha256": "b".repeat(64),
        "signature": format!("0x{}", "c".repeat(130)),
        "sig_kind": "provider_tee",
        "signer": format!("0x{}", "d".repeat(40)),
        "tokens_in": 2300,
        "tokens_out": 30,
        "tokens_reasoning": 0,
        "cut": false,
    })
}

pub fn thought_json(price: u128) -> Value {
    json!({ "model": "Qwen/Qwen3.8-27B", "price": price.to_string(), "calls": [call_json()] })
}

/// A worker's answer as the hirer's batch carries it: the receipt with the worker's token id and,
/// for `hire = Some((kind, fee, skill))`, the hire entry the contract records.
pub fn hired_json(price: u128, worker: &str, hire: Option<(&str, u128, bool)>) -> Value {
    let mut thought = thought_json(price);
    thought["worker"] = json!(worker);
    if let Some((kind, fee, skill)) = hire {
        thought["hire"] = json!({ "kind": kind, "skill": skill, "fee": fee.to_string() });
    }
    thought
}

pub fn thoughts(n: usize, price: u128) -> Vec<Value> {
    (0..n).map(|_| thought_json(price)).collect()
}

/// The prepaid gas the Worker sends a method with: the `<NAME> = <n>n;` constant of
/// `server/src/chain.ts`.
pub fn tgas_const(name: &str) -> Gas {
    let source = include_str!("../../../server/src/chain.ts");
    let line = source
        .lines()
        .find(|l| l.contains(&format!("{name} =")))
        .unwrap_or_else(|| panic!("{name} in server/src/chain.ts"));
    let digits: String = line
        .split('=')
        .nth(1)
        .unwrap()
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    Gas::from_tgas(digits.parse().unwrap())
}
