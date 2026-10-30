//! Shared setup of the sandbox tests: the wasm built from the crate as it is now (never a
//! stale artifact), a contract with a server, a treasury and a funder, and small helpers.
#![allow(dead_code)]

use std::sync::OnceLock;

use near_contract_standards::non_fungible_token::NonFungibleToken;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::store::LookupMap;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountDetailsPatch, AccountId, Contract, Worker};
use nearling_contract::limits::DAY_NS;
#[allow(unused_imports)]
pub use nearling_contract::limits::STARTER_FOOD;
use nearling_contract::pet::{Pet, Stage, VersionedPet};
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

    /// Rewrites a pet's record through the sandbox's state patch: the contract has no method that
    /// adds food before `add-feeding`, and the caps (0.005 / 0.05 NEAR) are above the starter food.
    pub async fn set_pet(&self, token_id: &str, edit: impl FnOnce(&mut Pet)) -> anyhow::Result<()> {
        let view = self.pet_view(token_id).await?;
        let amount = |k: &str| -> u128 { view[k].as_str().unwrap().parse().unwrap() };
        let mut pet = Pet {
            name: view["name"].as_str().unwrap().to_string(),
            character: view["character"].as_str().unwrap().to_string(),
            born_at: view["born_at"].as_u64().unwrap(),
            project_food: amount("project_food"),
            given_food: amount("given_food"),
            debit_day: view["debit_day"].as_u64().unwrap(),
            debited_today: amount("debited_today"),
            last_debit_id: view["last_debit_id"].as_u64().unwrap(),
            stage: Stage::Baby,
            stage_day: view["stage_day"].as_u64().unwrap(),
            streak: view["streak"].as_u64().unwrap() as u32,
            freezes: view["freezes"].as_u64().unwrap() as u8,
        };
        edit(&mut pet);
        let mut key = b"p".to_vec();
        key.extend(borsh::to_vec(&token_id.to_string())?);
        let value = borsh::to_vec(&VersionedPet::V1(pet))?;
        self.worker
            .patch_state(self.contract.id(), &key, &value)
            .await?;
        Ok(())
    }

    /// Moves the birth counter's day one day back: the births counted so far "happened
    /// yesterday", which is what a clock past 00:00 UTC would show. (`fast_forward` to the next
    /// UTC day costs ~290,000 blocks, ~40 minutes; the real `block_timestamp` boundary is the unit
    /// test `the_utc_day_changes_at_the_block_timestamp_boundary`.)
    pub async fn age_births_by_a_day(&self) -> anyhow::Result<()> {
        // A node refuses to view a contract's state past 50 kB by the account's `storage_usage`,
        // even for one key: the number is lowered for this one read and put back.
        let id = self.contract.id();
        let details = self.worker.view_account(id).await?;
        let real_usage = details.storage_usage;
        let mut lowered: AccountDetailsPatch = details.into();
        lowered.storage_usage = Some(1);
        self.worker.patch(id).account(lowered).transact().await?;
        let raw = self.worker.view_state(id).prefix(b"STATE").await?;
        let mut restored: AccountDetailsPatch = self.worker.view_account(id).await?.into();
        restored.storage_usage = Some(real_usage);
        self.worker.patch(id).account(restored).transact().await?;
        let state = raw.get(b"STATE".as_slice()).expect("the contract state");
        let mut mirror: StateMirror = borsh::from_slice(state)?;
        assert!(mirror.births_day > 0);
        mirror.births_day -= 1;
        self.worker
            .patch_state(self.contract.id(), b"STATE", &borsh::to_vec(&mirror)?)
            .await?;
        Ok(())
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

pub fn thoughts(n: usize, price: u128) -> Vec<Value> {
    (0..n).map(|_| thought_json(price)).collect()
}
