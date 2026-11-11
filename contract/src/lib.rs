pub mod any_chain;
pub mod debate;
pub mod events;
pub mod limits;
pub mod pet;
pub mod shared_job;

use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::TokenMetadata;
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::borsh;
use near_sdk::json_types::U128;
use near_sdk::store::key::Sha256;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near};
use std::collections::HashMap;

const WNEAR_SETTING_KEY: &[u8] = b"wnear_account";

fn fixed_wnear_account() -> AccountId {
    let bytes = env::storage_read(WNEAR_SETTING_KEY).unwrap_or_else(|| fail("wnear_not_configured"));
    String::from_utf8(bytes).ok().and_then(|value| value.parse().ok())
        .unwrap_or_else(|| fail("bad_wrap_account"))
}

fn set_wnear_account(account: &AccountId) {
    if account.as_str() != "wrap.near" && account.as_str() != "wrap.testnet" {
        fail("bad_wrap_account");
    }
    if env::storage_has_key(WNEAR_SETTING_KEY) {
        fail("wnear_already_configured");
    }
    env::storage_write(WNEAR_SETTING_KEY, account.as_bytes());
}

use crate::debate::{DEBATE_SLOT_BYTES, DebateSlot, DebateSlotView, next_slot};
use crate::any_chain::{ActiveSweep, CreditState, HeldRelease, HELD_RELEASE_RECORD_BYTES, MAX_PENDING_CREDITS, PENDING_RECORD_BYTES, PendingCredit, RouteKind, SweepApprovalEnvelope, SweepChain, SweepOwnerApproval, SweepSignerView, SWEEP_ACTIVE_RECORD_BYTES, SWEEP_SEQUENCE_RECORD_BYTES, SWEEP_WINDOW_MS, checked_sweep_payload, route_id_valid, sweep_approval_hash};
use crate::events::{
    FundingSpend, HireKind, NearlingEvent, OutfitVia, SnackKind, ThoughtReceipt, hex, unhex32,
};
use crate::limits::*;
use crate::pet::{
    HatchView, Pet, PetV7, PetView, RiddleView, Stage, THINKING_CAP, Trait, VersionedPet,
    is_bought, next_streak, streak_item, token_extra,
};
use crate::shared_job::{
    FundingKind, OwnerCloseApproval, SharedFunding, SharedJob, SharedJobState, SharedJobView,
    close_intent_message,
};

/// The state layout before `add-pet-work`, which `migrate` reads on the dev account: the same
/// prefixes as `Contract`, without the work pairs and their index.
#[near(serializers = [borsh])]
pub struct ContractV3 {
    owner_id: AccountId,
    server_id: AccountId,
    treasury_id: AccountId,
    tokens: NonFungibleToken,
    pets: LookupMap<TokenId, VersionedPet>,
    hatched: LookupMap<AccountId, TokenId>,
    births_day: u64,
    births_today: u32,
    next_token_id: u64,
    pool: u128,
    known: LookupSet<(TokenId, AccountId), Sha256>,
    riddle_commits: LookupMap<u64, [u8; 32]>,
    riddle_reserve: u128,
}

/// The layout deployed before receipt links were bound to direct NFT transfers.
#[near(serializers = [borsh])]
pub struct ContractV4 {
    owner_id: AccountId,
    server_id: AccountId,
    treasury_id: AccountId,
    tokens: NonFungibleToken,
    pets: LookupMap<TokenId, VersionedPet>,
    hatched: LookupMap<AccountId, TokenId>,
    births_day: u64,
    births_today: u32,
    next_token_id: u64,
    pool: u128,
    known: LookupSet<(TokenId, AccountId), Sha256>,
    riddle_commits: LookupMap<u64, [u8; 32]>,
    riddle_reserve: u128,
    work_pairs: LookupSet<(TokenId, TokenId), Sha256>,
    work_index: LookupMap<u64, Vec<u64>>,
}

/// The deployed layout immediately before the Showcase counters.
#[near(serializers = [borsh])]
pub struct ContractV5 {
    owner_id: AccountId,
    server_id: AccountId,
    treasury_id: AccountId,
    tokens: NonFungibleToken,
    pets: LookupMap<TokenId, VersionedPet>,
    hatched: LookupMap<AccountId, TokenId>,
    births_day: u64,
    births_today: u32,
    next_token_id: u64,
    pool: u128,
    known: LookupSet<(TokenId, AccountId), Sha256>,
    riddle_commits: LookupMap<u64, [u8; 32]>,
    riddle_reserve: u128,
    work_pairs: LookupSet<(TokenId, TokenId), Sha256>,
    work_index: LookupMap<u64, Vec<u64>>,
    transfer_generation: LookupMap<TokenId, u64>,
}

/// The deployed layout after the first Showcase upgrade.
#[near(serializers = [borsh])]
pub struct ContractV6 {
    owner_id: AccountId,
    server_id: AccountId,
    treasury_id: AccountId,
    tokens: NonFungibleToken,
    pets: LookupMap<TokenId, VersionedPet>,
    hatched: LookupMap<AccountId, TokenId>,
    births_day: u64,
    births_today: u32,
    next_token_id: u64,
    pool: u128,
    known: LookupSet<(TokenId, AccountId), Sha256>,
    riddle_commits: LookupMap<u64, [u8; 32]>,
    riddle_reserve: u128,
    work_pairs: LookupSet<(TokenId, TokenId), Sha256>,
    work_index: LookupMap<u64, Vec<u64>>,
    transfer_generation: LookupMap<TokenId, u64>,
    pets_hatched: u64,
    thoughts_paid: u64,
    spent: u128,
}

/// The deployed layout immediately before the bounded shared-job map.
#[near(serializers = [borsh])]
pub struct ContractV7 {
    owner_id: AccountId,
    server_id: AccountId,
    treasury_id: AccountId,
    tokens: NonFungibleToken,
    pets: LookupMap<TokenId, VersionedPet>,
    hatched: LookupMap<AccountId, TokenId>,
    births_day: u64,
    births_today: u32,
    next_token_id: u64,
    pool: u128,
    known: LookupSet<(TokenId, AccountId), Sha256>,
    riddle_commits: LookupMap<u64, [u8; 32]>,
    riddle_reserve: u128,
    work_pairs: LookupSet<(TokenId, TokenId), Sha256>,
    work_index: LookupMap<u64, Vec<u64>>,
    transfer_generation: LookupMap<TokenId, u64>,
    pets_hatched: u64,
    thoughts_paid: u64,
    spent: u128,
    hires_completed: u64,
    friend_snacks: u64,
    counted_since: u64,
}

/// The deployed state before per-pet experience, byte-for-byte through `shared_jobs`.
#[near(serializers = [borsh])]
pub struct ContractV8 {
    owner_id: AccountId,
    server_id: AccountId,
    treasury_id: AccountId,
    tokens: NonFungibleToken,
    pets: LookupMap<TokenId, VersionedPet>,
    hatched: LookupMap<AccountId, TokenId>,
    births_day: u64,
    births_today: u32,
    next_token_id: u64,
    pool: u128,
    known: LookupSet<(TokenId, AccountId), Sha256>,
    riddle_commits: LookupMap<u64, [u8; 32]>,
    riddle_reserve: u128,
    work_pairs: LookupSet<(TokenId, TokenId), Sha256>,
    work_index: LookupMap<u64, Vec<u64>>,
    transfer_generation: LookupMap<TokenId, u64>,
    pets_hatched: u64,
    thoughts_paid: u64,
    spent: u128,
    hires_completed: u64,
    friend_snacks: u64,
    counted_since: u64,
    shared_jobs: LookupMap<TokenId, SharedJob>,
}

/// The deployed layout before the fixed debate paid slot was appended.
#[near(serializers = [borsh])]
pub struct ContractV9 {
    owner_id: AccountId,
    server_id: AccountId,
    treasury_id: AccountId,
    tokens: NonFungibleToken,
    pets: LookupMap<TokenId, VersionedPet>,
    hatched: LookupMap<AccountId, TokenId>,
    births_day: u64,
    births_today: u32,
    next_token_id: u64,
    pool: u128,
    known: LookupSet<(TokenId, AccountId), Sha256>,
    riddle_commits: LookupMap<u64, [u8; 32]>,
    riddle_reserve: u128,
    work_pairs: LookupSet<(TokenId, TokenId), Sha256>,
    work_index: LookupMap<u64, Vec<u64>>,
    transfer_generation: LookupMap<TokenId, u64>,
    pets_hatched: u64,
    thoughts_paid: u64,
    spent: u128,
    hires_completed: u64,
    friend_snacks: u64,
    counted_since: u64,
    shared_jobs: LookupMap<TokenId, SharedJob>,
    experience_counts: LookupMap<TokenId, ExperienceCounts, Sha256>,
    experience_counted_since: u64,
}

/// Exact deployed debates layout, before the receipt and release fields were appended.
#[near(serializers = [borsh])]
pub struct ContractDebates {
    old: ContractV9,
    debate_slots: LookupMap<TokenId, DebateSlot, Sha256>,
}

/// The exact deployed stage-2 tail, before signer pin and sweep state.
#[near(serializers = [borsh])]
pub struct ContractAnyChainV1 {
    old: ContractDebates,
    next_credit_id: u64,
    pending_credits: LookupMap<u64, PendingCredit>,
    pending_count: u32,
    pub held_total: u128,
    pub next_delivery_id: u64,
    held_release_ids: LookupMap<u64, HeldRelease, Sha256>,
    settlement_account: AccountId,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct ExperienceCounts {
    paid_hires: u64,
    completed_errands: u64,
}

#[near(serializers = [json])]
pub struct ExperienceView {
    pub token_id: TokenId,
    pub paid_hires: u64,
    pub completed_errands: u64,
    pub counted_since: u64,
}

#[near(serializers = [json])]
pub struct ShowcaseView {
    pub pets_hatched: u64,
    pub thoughts_paid: u64,
    pub spent: U128,
    pub hires_completed: u64,
    pub friend_snacks: u64,
    pub counted_since: u64,
}

#[near(serializers = [json])]
pub struct CrossChainCapacityView {
    pub pending_count: u32,
    pub pending_cap: u32,
    pub capacity_available: bool,
    pub stake_available: bool,
}

/// The game's contract. Errors are `env::panic_str` with a code in the text; the Worker tells
/// the refusals apart by it (design.md › Контракт).
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    server_id: AccountId,
    treasury_id: AccountId,
    tokens: NonFungibleToken,
    pets: LookupMap<TokenId, VersionedPet>,
    /// Account → latest birth token, also after the pet was given away.
    hatched: LookupMap<AccountId, TokenId>,
    births_day: u64,
    births_today: u32,
    next_token_id: u64,
    /// The project's pool: pays the storage and the starter food of every birth, and the snacks.
    pool: u128,
    /// The feeders a pet knows. The hashed key makes every record `KNOWN_RECORD_BYTES`, whatever
    /// the ids' length, so the pool can check its price before it writes.
    known: LookupSet<(TokenId, AccountId), Sha256>,
    /// The riddle commits not yet revealed: UTC day → sha256. A record is `RIDDLE_COMMIT_BYTES`.
    riddle_commits: LookupMap<u64, [u8; 32]>,
    /// What `riddle_storage_fund` put in and the commits have not taken: pays the commits'
    /// storage, separate from the pool and from the pets' food.
    riddle_reserve: u128,
    /// The pairs of pets met through work: one record per pair, keyed {lower, higher} by numeric
    /// order. The hashed key makes every record `KNOWN_RECORD_BYTES`, so the pool can price it.
    work_pairs: LookupSet<(TokenId, TokenId), Sha256>,
    /// Each pet's partners (token ids as numbers, ascending): what `pet_view` lists for the
    /// server. The contract's token ids are its own decimal counters, so they fit a `u64`.
    work_index: LookupMap<u64, Vec<u64>>,
    /// Incremented on every public NFT transfer, including one outside the game UI.
    transfer_generation: LookupMap<TokenId, u64>,
    pets_hatched: u64,
    thoughts_paid: u64,
    spent: u128,
    hires_completed: u64,
    friend_snacks: u64,
    counted_since: u64,
    shared_jobs: LookupMap<TokenId, SharedJob>,
    experience_counts: LookupMap<TokenId, ExperienceCounts, Sha256>,
    experience_counted_since: u64,
    debate_slots: LookupMap<TokenId, DebateSlot, Sha256>,
    next_credit_id: u64,
    pending_credits: LookupMap<u64, PendingCredit>,
    pending_count: u32,
    held_total: u128,
    next_delivery_id: u64,
    held_release_ids: LookupMap<u64, HeldRelease, Sha256>,
    settlement_account: AccountId,
    sweep_signer_id: Option<AccountId>,
    sweep_sequences: LookupMap<(TokenId, SweepChain), u64, Sha256>,
    active_sweeps: LookupMap<(TokenId, SweepChain), ActiveSweep, Sha256>,
}

fn fail(code: &str) -> ! {
    env::panic_str(code)
}

fn assert_birth_cost(cost: u128) {
    if cost > MAX_BIRTH_COST {
        fail("birth_cost_limit");
    }
}

// Only unit tests can increase the measured write size. Valid current names and account
// lengths stay below the ceiling, so this exercises the rejection inside pet_mint itself.
#[cfg(test)]
thread_local! {
    static TEST_BIRTH_EXTRA_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn day_of(timestamp_ns: u64) -> u64 {
    timestamp_ns / DAY_NS
}

/// The refusal of the hire on thought `i`: the Worker reads `hire:<i>:<code>` to drop that record.
fn fail_hire(i: usize, code: &str) -> ! {
    fail(&format!("hire:{i}:{code}"))
}

/// The key of the pair of pets `a` and `b`, the lower id first by number; `None` for an id that is
/// not a number (no pet has one).
fn pair_key(a: &str, b: &str) -> Option<(TokenId, TokenId)> {
    let (x, y) = (a.parse::<u64>().ok()?, b.parse::<u64>().ok()?);
    Some(if x <= y {
        (x.to_string(), y.to_string())
    } else {
        (y.to_string(), x.to_string())
    })
}

/// Keep an active job's food out of every ordinary spend path.
fn take_ordinary_food(pet: &mut Pet, from_given: u128, rest: u128, job: Option<&SharedJob>) {
    let (reserved_given, reserved_project) = job
        .map(|job| (job.linked_near, job.linked_snack))
        .unwrap_or((0, 0));
    pet.given_food = pet
        .given_food
        .checked_sub(reserved_given)
        .unwrap_or_else(|| fail("over_food"));
    pet.project_food = pet
        .project_food
        .checked_sub(reserved_project)
        .unwrap_or_else(|| fail("over_food"));
    take_food_split(pet, from_given, rest);
    pet.given_food = pet
        .given_food
        .checked_add(reserved_given)
        .unwrap_or_else(|| fail("overflow"));
    pet.project_food = pet
        .project_food
        .checked_add(reserved_project)
        .unwrap_or_else(|| fail("overflow"));
}

/// `take_food` for a batch with hires of kind `pet`: `from_given` comes out of the given food
/// only (OD-491), `rest` project food first. The day's cap counts both. The caller has checked
/// that `from_given` is within the given food.
fn take_food_split(pet: &mut Pet, from_given: u128, rest: u128) {
    let amount = from_given
        .checked_add(rest)
        .unwrap_or_else(|| fail("overflow"));
    let day = day_of(env::block_timestamp());
    let debited_today = if pet.debit_day == day {
        pet.debited_today
    } else {
        0
    };
    let debited_today = debited_today
        .checked_add(amount)
        .filter(|d| *d <= DAILY_CAP)
        .unwrap_or_else(|| fail("daily_cap"));
    let given_left = pet
        .given_food
        .checked_sub(from_given)
        .unwrap_or_else(|| fail("over_food"));
    let food = pet
        .project_food
        .checked_add(given_left)
        .unwrap_or_else(|| fail("overflow"));
    if rest > food {
        fail("over_food");
    }
    let from_project = rest.min(pet.project_food);
    pet.project_food -= from_project;
    pet.given_food = given_left - (rest - from_project);
    pet.debit_day = day;
    pet.debited_today = debited_today;
}

/// Full plus three fixed thought-scale units: 14.5 of STARTER_FOOD's twelve units.
const WISH_FLOOR: u128 = STARTER_FOOD * 29 / 24;
const OUTFIT_TREASURY_DEBT_KEY: &[u8] = b"treasury_outfit_owed_v1";

fn outfit_treasury_owed() -> u128 {
    env::storage_read(OUTFIT_TREASURY_DEBT_KEY)
        .map(|bytes| borsh::from_slice(&bytes).unwrap_or_else(|_| fail("bad_treasury_debt")))
        .unwrap_or(0)
}

fn add_outfit_treasury_debt(amount: u128) {
    let owed = outfit_treasury_owed()
        .checked_add(amount)
        .unwrap_or_else(|| fail("overflow"));
    env::storage_write(
        OUTFIT_TREASURY_DEBT_KEY,
        &borsh::to_vec(&owed).unwrap_or_else(|_| fail("overflow")),
    );
}

/// One hire of a batch that passed its checks, with what `debit_session` writes for it.
struct PlannedHire {
    thought: usize,
    worker: TokenId,
    kind: HireKind,
    skill: bool,
    fee: u128,
    price: u128,
}

impl Contract {
    fn hold_cross_chain_delivery(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: &str,
        token_id: Option<String>,
        route_id: Option<String>,
        reason: &str,
    ) -> PromiseOrValue<U128> {
        let delivery_id = self.next_delivery_id;
        self.next_delivery_id = self.next_delivery_id.checked_add(1).unwrap_or_else(|| fail("delivery_ids_exhausted"));
        self.held_total = self.held_total.checked_add(amount.0).unwrap_or_else(|| fail("held_overflow"));
        NearlingEvent::CrossChainHeld {
            delivery_id,
            amount,
            reason: reason.to_string(),
            sender_id,
            msg_hash: hex(&env::sha256(msg.as_bytes())),
            token_id,
            route_id,
        }.emit();
        PromiseOrValue::Value(U128(0))
    }

    fn begin_cross_chain_unwrap(credit_id: u64, amount: U128) {
        Promise::new(fixed_wnear_account())
            .function_call(
                "near_withdraw".to_string(),
                near_sdk::serde_json::json!({"amount": amount}).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(10),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_unwrap".to_string(),
                near_sdk::serde_json::json!({"credit_id": credit_id}).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            ))
            .detach();
    }

    /// Account for the first generation write of every pet born before this reserve existed.
    /// The marker makes the current-layout migration one-time without changing state layout.
    fn reserve_legacy_generations(&mut self) {
        const MARKER: &[u8] = b"transfer_generation_reserve_v2";
        if env::storage_has_key(MARKER) {
            fail("already_migrated");
        }
        let before = env::storage_usage();
        env::storage_write(MARKER, b"1");
        let marker_bytes = env::storage_usage().saturating_sub(before);
        let bytes = self
            .next_token_id
            .checked_mul(TRANSFER_GENERATION_BYTES)
            .and_then(|reserve| reserve.checked_add(marker_bytes))
            .unwrap_or_else(|| fail("overflow"));
        let cost = u128::from(bytes)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"));
        self.pool = self
            .pool
            .checked_sub(cost)
            .unwrap_or_else(|| fail("pool_empty"));
    }

    fn fresh(owner_id: AccountId, server_id: AccountId, treasury_id: AccountId) -> Self {
        let tokens = NonFungibleToken::new(
            b"t".to_vec(),
            owner_id.clone(),
            None::<Vec<u8>>,
            Some(b"e".to_vec()),
            None::<Vec<u8>>,
        );
        Self {
            owner_id,
            server_id,
            treasury_id: treasury_id.clone(),
            tokens,
            pets: LookupMap::new(b"p".to_vec()),
            hatched: LookupMap::new(b"h".to_vec()),
            births_day: 0,
            births_today: 0,
            next_token_id: 0,
            pool: 0,
            known: LookupSet::with_hasher(b"k".to_vec()),
            riddle_commits: LookupMap::new(b"r".to_vec()),
            riddle_reserve: 0,
            work_pairs: LookupSet::with_hasher(b"w".to_vec()),
            work_index: LookupMap::new(b"x".to_vec()),
            transfer_generation: LookupMap::new(b"g".to_vec()),
            pets_hatched: 0,
            thoughts_paid: 0,
            spent: 0,
            hires_completed: 0,
            friend_snacks: 0,
            counted_since: env::block_timestamp(),
            shared_jobs: LookupMap::new(b"j".to_vec()),
            experience_counts: LookupMap::with_hasher(b"c".to_vec()),
            experience_counted_since: env::block_timestamp(),
            debate_slots: LookupMap::with_hasher(b"d".to_vec()),
            next_credit_id: 0,
            pending_credits: LookupMap::new(b"q".to_vec()),
            pending_count: 0,
            held_total: 0,
            next_delivery_id: 0,
            held_release_ids: LookupMap::with_hasher(b"R".to_vec()),
            settlement_account: treasury_id,
            sweep_signer_id: None,
            sweep_sequences: LookupMap::with_hasher(b"S".to_vec()),
            active_sweeps: LookupMap::with_hasher(b"A".to_vec()),
        }
    }

    /// What one commit's storage costs, yoctoNEAR.
    fn commit_cost() -> u128 {
        u128::from(RIDDLE_COMMIT_BYTES)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"))
    }

    /// Writes the acquaintance of `feeder` with the pet when it is new and the pool covers its
    /// storage on top of `reserve` (what the same call takes out of the pool for itself); the pool
    /// pays. Returns whether a record was written.
    fn introduce(&mut self, token_id: &TokenId, feeder: &AccountId, reserve: u128) -> bool {
        let key = (token_id.clone(), feeder.clone());
        if self.known.contains(&key) {
            return false;
        }
        let cost = u128::from(KNOWN_RECORD_BYTES)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"));
        let needed = cost
            .checked_add(reserve)
            .unwrap_or_else(|| fail("overflow"));
        if self.pool < needed {
            return false;
        }
        self.known.insert(key);
        self.pool -= cost;
        true
    }

    /// Writes the pair of pets `a` and `b` and both index entries when the pair is new and the
    /// pool holds `PAIR_MAX_BYTES` of storage; takes the bytes actually written from the pool.
    /// Returns whether a pair was written; a known pair and a short pool write nothing
    /// (`Known pets contract` › «пул не покрывает знакомство»).
    fn introduce_pair(&mut self, a: &str, b: &str) -> bool {
        let Some(key) = pair_key(a, b) else {
            return false;
        };
        if self.work_pairs.contains(&key) {
            return false;
        }
        let byte_cost = env::storage_byte_cost().as_yoctonear();
        let bound = u128::from(PAIR_MAX_BYTES)
            .checked_mul(byte_cost)
            .unwrap_or_else(|| fail("overflow"));
        if self.pool < bound {
            return false;
        }
        let (Ok(a), Ok(b)) = (a.parse::<u64>(), b.parse::<u64>()) else {
            return false;
        };
        let before = env::storage_usage();
        self.work_pairs.insert(key);
        for (pet, partner) in [(a, b), (b, a)] {
            let mut partners = self.work_index.get(&pet).cloned().unwrap_or_default();
            let at = partners.partition_point(|n| *n < partner);
            partners.insert(at, partner);
            self.work_index.insert(pet, partners);
        }
        self.work_index.flush();
        let written = env::storage_usage().saturating_sub(before);
        let cost = u128::from(written)
            .checked_mul(byte_cost)
            .unwrap_or_else(|| fail("overflow"));
        self.pool = self
            .pool
            .checked_sub(cost)
            .unwrap_or_else(|| fail("pool_empty"));
        true
    }

    fn assert_server(&self) {
        if env::predecessor_account_id() != self.server_id {
            fail("not_server");
        }
    }

    /// Charge only value growth when an older pet record first becomes V7.
    fn put_pet(&mut self, token_id: TokenId, record: VersionedPet) {
        let old = self.pets.get(&token_id).unwrap_or_else(|| fail("no_pet"));
        let old_len = borsh::to_vec(old)
            .unwrap_or_else(|_| fail("serialize"))
            .len();
        let new_len = borsh::to_vec(&record)
            .unwrap_or_else(|_| fail("serialize"))
            .len();
        let cost = (new_len.saturating_sub(old_len) as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"));
        self.pool = self
            .pool
            .checked_sub(cost)
            .unwrap_or_else(|| fail("pool_empty"));
        self.pets.insert(token_id, record);
    }

    fn births_today_now(&self) -> u32 {
        if self.births_day == day_of(env::block_timestamp()) {
            self.births_today
        } else {
            0
        }
    }
}

#[near]
impl Contract {
    // spec: add-any-chain-feed › wNEAR receipt contract › accepted transfer
    // spec: add-any-chain-feed › wNEAR receipt contract › wrong token caller
    // spec: add-any-chain-feed › wNEAR receipt contract › wrong sender
    // spec: add-any-chain-feed › wNEAR receipt contract › unknown pet
    // spec: add-any-chain-feed › wNEAR receipt contract › missing route id
    // spec: add-any-chain-feed › wNEAR receipt contract › second real delivery on one route
    // spec: add-any-chain-feed › wNEAR receipt contract › below food minimum
    // spec: add-any-chain-feed › wNEAR receipt contract › pending storage unavailable
    // spec: add-any-chain-feed › wNEAR receipt contract › pending cap reached
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != fixed_wnear_account() {
            fail("wrong_token_caller");
        }
        let parsed: Option<near_sdk::serde_json::Value> = near_sdk::serde_json::from_str(&msg).ok();
        let token_id = parsed.as_ref()
            .and_then(|value| value.get("token_id"))
            .and_then(|value| value.as_str())
            .filter(|value| value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit()))
            .map(str::to_string);
        let route_id = parsed.as_ref()
            .and_then(|value| value.get("route"))
            .and_then(|value| value.as_str())
            .filter(|value| route_id_valid(value))
            .map(str::to_string);
        let kind = parsed.as_ref()
            .and_then(|value| value.get("kind"))
            .and_then(|value| value.as_str())
            .and_then(|value| match value {
                "quote" => Some(RouteKind::Quote),
                "pet_address" => Some(RouteKind::PetAddress),
                _ => None,
            });
        let reason = if sender_id.as_str() != "intents.near" {
            Some("wrong_sender")
        } else if token_id.as_ref().is_none_or(|id| self.tokens.owner_by_id.get(id).is_none()) {
            Some("unknown_pet")
        } else if route_id.is_none() || kind.is_none() {
            Some("invalid_route")
        } else if amount.0 < MIN_FEED {
            Some("below_minimum")
        } else if self.pending_count >= MAX_PENDING_CREDITS {
            Some("capacity")
        } else {
            None
        };
        if let Some(reason) = reason {
            return self.hold_cross_chain_delivery(sender_id, amount, &msg, token_id, route_id, reason);
        }
        let token_id = token_id.expect("checked above");
        let route_id = route_id.expect("checked above");
        let kind = kind.expect("checked above");
        let mut current_pet = self.pets.get(&token_id).cloned().expect("checked above");
        let legacy_pet = !matches!(&current_pet, VersionedPet::V7(_));
        let old_pet_len = borsh::to_vec(&current_pet).unwrap_or_else(|_| fail("serialize")).len();
        current_pet.current_mut();
        let grown_pet_len = borsh::to_vec(&current_pet).unwrap_or_else(|_| fail("serialize")).len();
        let pet_growth = grown_pet_len.saturating_sub(old_pet_len) as u64;
        let cost = u128::from(PENDING_RECORD_BYTES)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"));
        let pet_growth_cost = u128::from(pet_growth)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"));
        let full_cost = cost.checked_add(pet_growth_cost).unwrap_or_else(|| fail("overflow"));
        let balance = env::account_balance().as_yoctonear();
        let required_stake = u128::from(env::storage_usage().saturating_add(PENDING_RECORD_BYTES).saturating_add(pet_growth))
            .saturating_mul(env::storage_byte_cost().as_yoctonear());
        if self.pool < full_cost || balance < required_stake.saturating_add(1) {
            return self.hold_cross_chain_delivery(sender_id, amount, &msg, Some(token_id), Some(route_id), "storage_unavailable");
        }
        if legacy_pet {
            self.put_pet(token_id.clone(), current_pet);
        }
        let credit_id = self.next_credit_id;
        self.next_credit_id = self.next_credit_id.checked_add(1).unwrap_or_else(|| fail("credit_ids_exhausted"));
        self.pending_credits.insert(credit_id, PendingCredit {
            token_id: token_id.clone(),
            route_id: route_id.clone(),
            kind,
            amount: amount.0,
            state: CreditState::InFlight,
        });
        self.pending_credits.flush();
        self.pending_count += 1;
        self.pool -= cost;
        NearlingEvent::CrossChainPending { credit_id, token_id, route_id, kind, amount }.emit();
        Self::begin_cross_chain_unwrap(credit_id, amount);
        PromiseOrValue::Value(U128(0))
    }

    /// Completion of the detached withdrawal; a failed withdrawal keeps its wNEAR for retry.
    #[private]
    pub fn on_unwrap(&mut self, credit_id: u64) {
        let mut credit = self.pending_credits.get(&credit_id).cloned().unwrap_or_else(|| fail("no_credit"));
        if !matches!(credit.state, CreditState::InFlight) {
            fail("credit_not_in_flight");
        }
        if env::promise_result_checked(0, 256).is_err() {
            credit.state = CreditState::Failed;
            self.pending_credits.insert(credit_id, credit);
            return;
        }
        let mut record = self.pets.get(&credit.token_id).cloned().unwrap_or_else(|| fail("no_pet"));
        let pet = record.current_mut();
        pet.given_food = pet.given_food.checked_add(credit.amount).unwrap_or_else(|| fail("overflow"));
        self.put_pet(credit.token_id.clone(), record);
        self.pending_credits.remove(&credit_id);
        self.pending_count -= 1;
        self.pool = self.pool.checked_add(u128::from(PENDING_RECORD_BYTES) * env::storage_byte_cost().as_yoctonear()).unwrap_or_else(|| fail("overflow"));
        NearlingEvent::CrossChainFeed { credit_id, token_id: credit.token_id, route_id: credit.route_id, kind: credit.kind, amount: U128(credit.amount) }.emit();
    }

    // spec: add-any-chain-feed › wNEAR recovery contract › retry failed route
    // spec: add-any-chain-feed › wNEAR recovery contract › route already settled
    // spec: add-any-chain-feed › wNEAR recovery contract › route not recoverable
    pub fn retry_unwrap(&mut self, credit_id: u64) {
        let mut credit = self.pending_credits.get(&credit_id).cloned()
            .unwrap_or_else(|| fail("credit_not_recoverable"));
        if !matches!(credit.state, CreditState::Failed) {
            fail("credit_not_recoverable");
        }
        credit.state = CreditState::InFlight;
        let amount = U128(credit.amount);
        self.pending_credits.insert(credit_id, credit);
        Self::begin_cross_chain_unwrap(credit_id, amount);
    }

    // spec: add-any-chain-feed › Held wNEAR release contract › operator release
    // spec: add-any-chain-feed › Held wNEAR release contract › unauthorized release
    // spec: add-any-chain-feed › Held wNEAR release contract › duplicate release
    // spec: add-any-chain-feed › Held wNEAR release contract › amount exceeds custody
    // spec: add-any-chain-feed › Held wNEAR release contract › resolution storage unavailable
    pub fn held_refund_release(&mut self, delivery_id: u64, amount: U128, settlement_account: AccountId) -> Promise {
        if env::predecessor_account_id() != env::current_account_id() {
            fail("operator_only");
        }
        if settlement_account != self.settlement_account {
            fail("wrong_settlement_account");
        }
        if delivery_id >= self.next_delivery_id || amount.0 == 0 {
            fail("unknown_delivery");
        }
        if self.held_release_ids.contains_key(&delivery_id) {
            fail("delivery_already_released");
        }
        if amount.0 > self.held_total {
            fail("held_custody_insufficient");
        }
        let cost = u128::from(HELD_RELEASE_RECORD_BYTES)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"));
        let required = u128::from(env::storage_usage().saturating_add(HELD_RELEASE_RECORD_BYTES))
            .saturating_mul(env::storage_byte_cost().as_yoctonear())
            .saturating_add(1);
        if self.pool < cost || env::account_balance().as_yoctonear() < required {
            fail("release_storage_unavailable");
        }
        let before = env::storage_usage();
        self.held_release_ids.insert(delivery_id, HeldRelease::InFlight(amount.0));
        self.held_release_ids.flush();
        if env::storage_usage().saturating_sub(before) > HELD_RELEASE_RECORD_BYTES {
            fail("release_marker_too_large");
        }
        self.pool -= cost;
        self.held_total -= amount.0;
        Promise::new(fixed_wnear_account())
            .function_call(
                "ft_transfer".to_string(),
                near_sdk::serde_json::json!({"receiver_id": settlement_account, "amount": amount, "memo": null}).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(10),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_held_refund_release".to_string(),
                near_sdk::serde_json::json!({"delivery_id": delivery_id, "amount": amount}).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            ))
    }

    // spec: add-any-chain-feed › Held wNEAR release contract › settlement transfer failed
    #[private]
    pub fn on_held_refund_release(&mut self, delivery_id: u64, amount: U128) {
        match self.held_release_ids.get(&delivery_id) {
            Some(HeldRelease::InFlight(value)) if *value == amount.0 => {},
            _ => fail("release_not_in_flight"),
        }
        if env::promise_result_checked(0, 256).is_err() {
            self.held_release_ids.remove(&delivery_id);
            self.held_total = self.held_total.checked_add(amount.0).unwrap_or_else(|| fail("overflow"));
            self.pool = self.pool.checked_add(u128::from(HELD_RELEASE_RECORD_BYTES) * env::storage_byte_cost().as_yoctonear()).unwrap_or_else(|| fail("overflow"));
            NearlingEvent::CrossChainHeldReleaseFailed { delivery_id, amount }.emit();
        } else {
            self.held_release_ids.insert(delivery_id, HeldRelease::Resolved(amount.0));
            NearlingEvent::CrossChainHeldReleased { delivery_id, amount, settlement_account: self.settlement_account.clone() }.emit();
        }
    }

    /// For a fresh account (prod at R1; a new dev account).
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, server_id: AccountId, treasury_id: AccountId, wnear_id: AccountId) -> Self {
        set_wnear_account(&wnear_id);
        Self::fresh(owner_id, server_id, treasury_id)
    }

    /// One-time setting for an existing account after its current layout has been migrated.
    #[init(ignore_state)]
    #[private]
    pub fn migrate_wnear(wnear_id: AccountId) -> Self {
        let state: Self = env::state_read().unwrap_or_else(|| fail("no_state"));
        set_wnear_account(&wnear_id);
        state
    }

    pub fn wnear_account_view(&self) -> AccountId {
        fixed_wnear_account()
    }

    /// Takes the layout before `add-pet-work` into this one: adds the work pairs and their index,
    /// empty; the pool, the pets, the feeders, the riddle commits and the counters stay as they
    /// were. The dev account upgrades with it (`cargo near deploy … with-init-call migrate`). A
    /// second call meets a state with the bytes of the new fields after the old layout and
    /// fails, so the pool is never reset.
    #[init(ignore_state)]
    #[private]
    pub fn migrate() -> Self {
        let old: ContractV3 = env::state_read().unwrap_or_else(|| fail("no_state"));
        Self {
            owner_id: old.owner_id,
            server_id: old.server_id,
            treasury_id: old.treasury_id.clone(),
            tokens: old.tokens,
            pets: old.pets,
            hatched: old.hatched,
            births_day: old.births_day,
            births_today: old.births_today,
            next_token_id: old.next_token_id,
            pool: old.pool,
            known: old.known,
            riddle_commits: old.riddle_commits,
            riddle_reserve: old.riddle_reserve,
            work_pairs: LookupSet::with_hasher(b"w".to_vec()),
            work_index: LookupMap::new(b"x".to_vec()),
            transfer_generation: LookupMap::new(b"g".to_vec()),
            pets_hatched: old.next_token_id,
            thoughts_paid: 0,
            spent: 0,
            hires_completed: 0,
            friend_snacks: 0,
            counted_since: env::block_timestamp(),
            shared_jobs: LookupMap::new(b"j".to_vec()),
            experience_counts: LookupMap::with_hasher(b"c".to_vec()),
            experience_counted_since: env::block_timestamp(),
            debate_slots: LookupMap::with_hasher(b"d".to_vec()),
            next_credit_id: 0,
            pending_credits: LookupMap::new(b"q".to_vec()),
            pending_count: 0,
            held_total: 0,
            next_delivery_id: 0,
            held_release_ids: LookupMap::with_hasher(b"R".to_vec()),
            settlement_account: old.treasury_id,
            sweep_signer_id: None,
            sweep_sequences: LookupMap::with_hasher(b"S".to_vec()),
            active_sweeps: LookupMap::with_hasher(b"A".to_vec()),
        }
    }

    /// Upgrade the deployed work-pair layout without resetting pets or their food.
    #[init(ignore_state)]
    #[private]
    pub fn migrate_verification() -> Self {
        let old: ContractV4 = env::state_read().unwrap_or_else(|| fail("no_state"));
        let mut contract = Self {
            owner_id: old.owner_id,
            server_id: old.server_id,
            treasury_id: old.treasury_id.clone(),
            tokens: old.tokens,
            pets: old.pets,
            hatched: old.hatched,
            births_day: old.births_day,
            births_today: old.births_today,
            next_token_id: old.next_token_id,
            pool: old.pool,
            known: old.known,
            riddle_commits: old.riddle_commits,
            riddle_reserve: old.riddle_reserve,
            work_pairs: old.work_pairs,
            work_index: old.work_index,
            transfer_generation: LookupMap::new(b"g".to_vec()),
            pets_hatched: old.next_token_id,
            thoughts_paid: 0,
            spent: 0,
            hires_completed: 0,
            friend_snacks: 0,
            counted_since: env::block_timestamp(),
            shared_jobs: LookupMap::new(b"j".to_vec()),
            experience_counts: LookupMap::with_hasher(b"c".to_vec()),
            experience_counted_since: env::block_timestamp(),
            debate_slots: LookupMap::with_hasher(b"d".to_vec()),
            next_credit_id: 0,
            pending_credits: LookupMap::new(b"q".to_vec()),
            pending_count: 0,
            held_total: 0,
            next_delivery_id: 0,
            held_release_ids: LookupMap::with_hasher(b"R".to_vec()),
            settlement_account: old.treasury_id,
            sweep_signer_id: None,
            sweep_sequences: LookupMap::with_hasher(b"S".to_vec()),
            active_sweeps: LookupMap::with_hasher(b"A".to_vec()),
        };
        contract.reserve_legacy_generations();
        contract
    }

    /// The already deployed transfer-map layout needs the new per-pet reserve exactly once.
    /// Fund the pool first if its balance cannot cover every existing pet.
    #[init(ignore_state)]
    #[private]
    pub fn migrate_generation_reserve() -> Self {
        let mut contract: Self = env::state_read().unwrap_or_else(|| fail("no_state"));
        contract.reserve_legacy_generations();
        contract
    }

    /// One-time upgrade of the deployed transfer-generation layout. Earlier receipts are not
    /// reconstructed; the monotonic mint id gives the count of already hatched pets.
    #[init(ignore_state)]
    #[private]
    pub fn migrate_showcase() -> Self {
        let old: ContractV5 = env::state_read().unwrap_or_else(|| fail("no_state"));
        Self {
            owner_id: old.owner_id,
            server_id: old.server_id,
            treasury_id: old.treasury_id.clone(),
            tokens: old.tokens,
            pets: old.pets,
            hatched: old.hatched,
            births_day: old.births_day,
            births_today: old.births_today,
            next_token_id: old.next_token_id,
            pool: old.pool,
            known: old.known,
            riddle_commits: old.riddle_commits,
            riddle_reserve: old.riddle_reserve,
            work_pairs: old.work_pairs,
            work_index: old.work_index,
            transfer_generation: old.transfer_generation,
            pets_hatched: old.next_token_id,
            thoughts_paid: 0,
            spent: 0,
            hires_completed: 0,
            friend_snacks: 0,
            counted_since: env::block_timestamp(),
            shared_jobs: LookupMap::new(b"j".to_vec()),
            experience_counts: LookupMap::with_hasher(b"c".to_vec()),
            experience_counted_since: env::block_timestamp(),
            debate_slots: LookupMap::with_hasher(b"d".to_vec()),
            next_credit_id: 0,
            pending_credits: LookupMap::new(b"q".to_vec()),
            pending_count: 0,
            held_total: 0,
            next_delivery_id: 0,
            held_release_ids: LookupMap::with_hasher(b"R".to_vec()),
            settlement_account: old.treasury_id,
            sweep_signer_id: None,
            sweep_sequences: LookupMap::with_hasher(b"S".to_vec()),
            active_sweeps: LookupMap::with_hasher(b"A".to_vec()),
        }
    }

    /// One-time upgrade of the deployed Showcase state, without recounting earlier activity.
    #[init(ignore_state)]
    #[private]
    pub fn migrate_showcase_totals() -> Self {
        let old: ContractV6 = env::state_read().unwrap_or_else(|| fail("no_state"));
        Self {
            owner_id: old.owner_id,
            server_id: old.server_id,
            treasury_id: old.treasury_id.clone(),
            tokens: old.tokens,
            pets: old.pets,
            hatched: old.hatched,
            births_day: old.births_day,
            births_today: old.births_today,
            next_token_id: old.next_token_id,
            pool: old.pool,
            known: old.known,
            riddle_commits: old.riddle_commits,
            riddle_reserve: old.riddle_reserve,
            work_pairs: old.work_pairs,
            work_index: old.work_index,
            transfer_generation: old.transfer_generation,
            pets_hatched: old.pets_hatched,
            thoughts_paid: old.thoughts_paid,
            spent: old.spent,
            hires_completed: 0,
            friend_snacks: 0,
            counted_since: env::block_timestamp(),
            shared_jobs: LookupMap::new(b"j".to_vec()),
            experience_counts: LookupMap::with_hasher(b"c".to_vec()),
            experience_counted_since: env::block_timestamp(),
            debate_slots: LookupMap::with_hasher(b"d".to_vec()),
            next_credit_id: 0,
            pending_credits: LookupMap::new(b"q".to_vec()),
            pending_count: 0,
            held_total: 0,
            next_delivery_id: 0,
            held_release_ids: LookupMap::with_hasher(b"R".to_vec()),
            settlement_account: old.treasury_id,
            sweep_signer_id: None,
            sweep_sequences: LookupMap::with_hasher(b"S".to_vec()),
            active_sweeps: LookupMap::with_hasher(b"A".to_vec()),
        }
    }

    /// Upgrade the deployed Showcase layout without resetting pets or counters.
    #[init(ignore_state)]
    #[private]
    pub fn migrate_shared_jobs() -> Self {
        let old: ContractV7 = env::state_read().unwrap_or_else(|| fail("no_state"));
        Self {
            owner_id: old.owner_id,
            server_id: old.server_id,
            treasury_id: old.treasury_id.clone(),
            tokens: old.tokens,
            pets: old.pets,
            hatched: old.hatched,
            births_day: old.births_day,
            births_today: old.births_today,
            next_token_id: old.next_token_id,
            pool: old.pool,
            known: old.known,
            riddle_commits: old.riddle_commits,
            riddle_reserve: old.riddle_reserve,
            work_pairs: old.work_pairs,
            work_index: old.work_index,
            transfer_generation: old.transfer_generation,
            pets_hatched: old.pets_hatched,
            thoughts_paid: old.thoughts_paid,
            spent: old.spent,
            hires_completed: old.hires_completed,
            friend_snacks: old.friend_snacks,
            counted_since: old.counted_since,
            shared_jobs: LookupMap::new(b"j".to_vec()),
            experience_counts: LookupMap::with_hasher(b"c".to_vec()),
            experience_counted_since: env::block_timestamp(),
            debate_slots: LookupMap::with_hasher(b"d".to_vec()),
            next_credit_id: 0,
            pending_credits: LookupMap::new(b"q".to_vec()),
            pending_count: 0,
            held_total: 0,
            next_delivery_id: 0,
            held_release_ids: LookupMap::with_hasher(b"R".to_vec()),
            settlement_account: old.treasury_id,
            sweep_signer_id: None,
            sweep_sequences: LookupMap::with_hasher(b"S".to_vec()),
            active_sweeps: LookupMap::with_hasher(b"A".to_vec()),
        }
    }

    /// Upgrade the exact shared-jobs layout without backfilling earlier work.
    #[init(ignore_state)]
    #[private]
    pub fn migrate_experience() -> Self {
        let old: ContractV8 = env::state_read().unwrap_or_else(|| fail("no_state"));
        Self {
            owner_id: old.owner_id,
            server_id: old.server_id,
            treasury_id: old.treasury_id.clone(),
            tokens: old.tokens,
            pets: old.pets,
            hatched: old.hatched,
            births_day: old.births_day,
            births_today: old.births_today,
            next_token_id: old.next_token_id,
            pool: old.pool,
            known: old.known,
            riddle_commits: old.riddle_commits,
            riddle_reserve: old.riddle_reserve,
            work_pairs: old.work_pairs,
            work_index: old.work_index,
            transfer_generation: old.transfer_generation,
            pets_hatched: old.pets_hatched,
            thoughts_paid: old.thoughts_paid,
            spent: old.spent,
            hires_completed: old.hires_completed,
            friend_snacks: old.friend_snacks,
            counted_since: old.counted_since,
            shared_jobs: old.shared_jobs,
            experience_counts: LookupMap::with_hasher(b"c".to_vec()),
            experience_counted_since: env::block_timestamp(),
            debate_slots: LookupMap::with_hasher(b"d".to_vec()),
            next_credit_id: 0,
            pending_credits: LookupMap::new(b"q".to_vec()),
            pending_count: 0,
            held_total: 0,
            next_delivery_id: 0,
            held_release_ids: LookupMap::with_hasher(b"R".to_vec()),
            settlement_account: old.treasury_id,
            sweep_signer_id: None,
            sweep_sequences: LookupMap::with_hasher(b"S".to_vec()),
            active_sweeps: LookupMap::with_hasher(b"A".to_vec()),
        }
    }

    /// One-time upgrade from the exact pre-debate state; all existing collections and counters
    /// retain their prefixes and values. Only the empty paid-slot map is appended.
    #[init(ignore_state)]
    #[private]
    pub fn migrate_debates() -> Self {
        let old: ContractV9 = env::state_read().unwrap_or_else(|| fail("no_state"));
        Self {
            owner_id: old.owner_id,
            server_id: old.server_id,
            treasury_id: old.treasury_id.clone(),
            tokens: old.tokens,
            pets: old.pets,
            hatched: old.hatched,
            births_day: old.births_day,
            births_today: old.births_today,
            next_token_id: old.next_token_id,
            pool: old.pool,
            known: old.known,
            riddle_commits: old.riddle_commits,
            riddle_reserve: old.riddle_reserve,
            work_pairs: old.work_pairs,
            work_index: old.work_index,
            transfer_generation: old.transfer_generation,
            pets_hatched: old.pets_hatched,
            thoughts_paid: old.thoughts_paid,
            spent: old.spent,
            hires_completed: old.hires_completed,
            friend_snacks: old.friend_snacks,
            counted_since: old.counted_since,
            shared_jobs: old.shared_jobs,
            experience_counts: old.experience_counts,
            experience_counted_since: old.experience_counted_since,
            debate_slots: LookupMap::with_hasher(b"d".to_vec()),
            next_credit_id: 0,
            pending_credits: LookupMap::new(b"q".to_vec()),
            pending_count: 0,
            held_total: 0,
            next_delivery_id: 0,
            held_release_ids: LookupMap::with_hasher(b"R".to_vec()),
            settlement_account: old.treasury_id,
            sweep_signer_id: None,
            sweep_sequences: LookupMap::with_hasher(b"S".to_vec()),
            active_sweeps: LookupMap::with_hasher(b"A".to_vec()),
        }
    }

    /// One-time dev upgrade from the exact deployed debates tail, before receipt custody.
    #[init(ignore_state)]
    #[private]
    pub fn migrate_any_chain() -> Self {
        let old: ContractDebates = env::state_read().unwrap_or_else(|| fail("no_state"));
        let debate_slots = old.debate_slots;
        let old = old.old;
        Self {
            owner_id: old.owner_id,
            server_id: old.server_id,
            treasury_id: old.treasury_id.clone(),
            tokens: old.tokens,
            pets: old.pets,
            hatched: old.hatched,
            births_day: old.births_day,
            births_today: old.births_today,
            next_token_id: old.next_token_id,
            pool: old.pool,
            known: old.known,
            riddle_commits: old.riddle_commits,
            riddle_reserve: old.riddle_reserve,
            work_pairs: old.work_pairs,
            work_index: old.work_index,
            transfer_generation: old.transfer_generation,
            pets_hatched: old.pets_hatched,
            thoughts_paid: old.thoughts_paid,
            spent: old.spent,
            hires_completed: old.hires_completed,
            friend_snacks: old.friend_snacks,
            counted_since: old.counted_since,
            shared_jobs: old.shared_jobs,
            experience_counts: old.experience_counts,
            experience_counted_since: old.experience_counted_since,
            debate_slots,
            next_credit_id: 0,
            pending_credits: LookupMap::new(b"q".to_vec()),
            pending_count: 0,
            held_total: 0,
            next_delivery_id: 0,
            held_release_ids: LookupMap::with_hasher(b"R".to_vec()),
            settlement_account: old.treasury_id,
            sweep_signer_id: None,
            sweep_sequences: LookupMap::with_hasher(b"S".to_vec()),
            active_sweeps: LookupMap::with_hasher(b"A".to_vec()),
        }
    }

    /// One-time dev upgrade from the deployed debates-plus-receipt/held state.
    #[init(ignore_state)]
    #[private]
    pub fn migrate_any_chain_sweep() -> Self {
        let old: ContractAnyChainV1 = env::state_read().unwrap_or_else(|| fail("no_state"));
        let debates = old.old;
        let debate_slots = debates.debate_slots;
        let legacy = debates.old;
        Self {
            owner_id: legacy.owner_id,
            server_id: legacy.server_id,
            treasury_id: legacy.treasury_id,
            tokens: legacy.tokens,
            pets: legacy.pets,
            hatched: legacy.hatched,
            births_day: legacy.births_day,
            births_today: legacy.births_today,
            next_token_id: legacy.next_token_id,
            pool: legacy.pool,
            known: legacy.known,
            riddle_commits: legacy.riddle_commits,
            riddle_reserve: legacy.riddle_reserve,
            work_pairs: legacy.work_pairs,
            work_index: legacy.work_index,
            transfer_generation: legacy.transfer_generation,
            pets_hatched: legacy.pets_hatched,
            thoughts_paid: legacy.thoughts_paid,
            spent: legacy.spent,
            hires_completed: legacy.hires_completed,
            friend_snacks: legacy.friend_snacks,
            counted_since: legacy.counted_since,
            shared_jobs: legacy.shared_jobs,
            experience_counts: legacy.experience_counts,
            experience_counted_since: legacy.experience_counted_since,
            debate_slots,
            next_credit_id: old.next_credit_id,
            pending_credits: old.pending_credits,
            pending_count: old.pending_count,
            held_total: old.held_total,
            next_delivery_id: old.next_delivery_id,
            held_release_ids: old.held_release_ids,
            settlement_account: old.settlement_account,
            sweep_signer_id: None,
            sweep_sequences: LookupMap::with_hasher(b"S".to_vec()),
            active_sweeps: LookupMap::with_hasher(b"A".to_vec()),
        }
    }

    /// Public configuration only; the signer derives addresses in its own view call.
    pub fn sweep_signer_view(&self) -> SweepSignerView {
        SweepSignerView {
            signer_id: self.sweep_signer_id.clone(),
            base_domain_id: SweepChain::Base.domain_id(),
            solana_domain_id: SweepChain::Solana.domain_id(),
            path_format: "<chain>:<token_id>".to_string(),
        }
    }

    /// A public preflight for the next receipt. The stake check includes a legacy pet's
    /// first-write growth, exactly as `ft_on_transfer` does. A missing pet has no stake.
    // spec: add-any-chain-feed › Cross-chain availability rule › pending stake unavailable
    // spec: add-any-chain-feed › Cross-chain availability rule › pending capacity full
    pub fn cross_chain_capacity_view(&self, token_id: TokenId) -> CrossChainCapacityView {
        let stake_available = self.pets.get(&token_id).and_then(|record| {
            self.tokens.owner_by_id.get(&token_id)?;
            let mut current = record.clone();
            let old_len = borsh::to_vec(&current).ok()?.len();
            current.current_mut();
            let new_len = borsh::to_vec(&current).ok()?.len();
            let growth = new_len.saturating_sub(old_len) as u64;
            let bytes = PENDING_RECORD_BYTES.checked_add(growth)?;
            let cost = u128::from(bytes).checked_mul(env::storage_byte_cost().as_yoctonear())?;
            let required = u128::from(env::storage_usage().checked_add(bytes)?)
                .checked_mul(env::storage_byte_cost().as_yoctonear())?;
            Some(self.pool >= cost && env::account_balance().as_yoctonear() >= required.saturating_add(1))
        }).unwrap_or(false);
        CrossChainCapacityView {
            pending_count: self.pending_count,
            pending_cap: MAX_PENDING_CREDITS,
            capacity_available: self.pending_count < MAX_PENDING_CREDITS,
            stake_available,
        }
    }

    /// The contract-account key pins the MPC signer once before any address is offered.
    #[private]
    pub fn pin_sweep_signer(&mut self, signer_id: AccountId) {
        if self.sweep_signer_id.is_some() {
            fail("sweep_signer_already_pinned");
        }
        let bytes = 1_u128 + 4 + signer_id.as_str().len() as u128;
        let cost = bytes.checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"));
        self.pool = self.pool.checked_sub(cost).unwrap_or_else(|| fail("pool_empty"));
        self.sweep_signer_id = Some(signer_id);
    }

    /// The owner signs this domain-separated Borsh envelope's raw SHA-256 hash.
    pub fn sweep_approval_hash_view(&self, envelope: SweepApprovalEnvelope) -> String {
        hex(&sweep_approval_hash(&envelope))
    }

    // spec: add-any-chain-feed › Pet sweep authorization contract › valid authorization
    // spec: add-any-chain-feed › Pet sweep authorization contract › wrong caller
    // spec: add-any-chain-feed › Pet sweep authorization contract › unknown pet
    // spec: add-any-chain-feed › Pet sweep authorization contract › wrong or stale owner approval
    // spec: add-any-chain-feed › Pet sweep authorization contract › expired or reused approval
    // spec: add-any-chain-feed › Pet sweep authorization contract › wrong derivation path
    pub fn sweep_sign(
        &mut self,
        token_id: TokenId,
        chain: SweepChain,
        path: String,
        usdc_contract: String,
        amount_base_units: u64,
        destination: String,
        refund_recipient: String,
        route_id: String,
        sequence: u64,
        expiry_ms: u64,
        signing_payload_hex: String,
        owner_approval: SweepOwnerApproval,
    ) -> Promise {
        self.assert_server();
        if env::attached_deposit().as_yoctonear() != 0 {
            fail("no_deposit");
        }
        let signer_id = self.sweep_signer_id.clone().unwrap_or_else(|| fail("sweep_signer_unpinned"));
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| fail("no_pet"));
        if path != chain.path(&token_id) {
            fail("wrong_sweep_path");
        }
        if !route_id_valid(&route_id) {
            fail("bad_route_id");
        }
        let named_usdc = match chain {
            SweepChain::Base => "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            SweepChain::Solana => "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        };
        let token_matches = match chain {
            SweepChain::Base => usdc_contract.eq_ignore_ascii_case(named_usdc),
            SweepChain::Solana => usdc_contract == named_usdc,
        };
        if !token_matches {
            fail("unsupported_sweep_asset");
        }
        if amount_base_units == 0 || amount_base_units > 1_000_000 {
            fail("sweep_amount_limit");
        }
        if destination.is_empty() || destination.len() > 128 {
            fail("bad_sweep_destination");
        }
        if refund_recipient.is_empty() || refund_recipient.len() > 128 {
            fail("bad_sweep_refund");
        }
        let now_ms = env::block_timestamp() / 1_000_000;
        if expiry_ms <= now_ms || expiry_ms > now_ms.saturating_add(SWEEP_WINDOW_MS) {
            fail("sweep_approval_expired");
        }
        let owner_key = unhex32(&owner_approval.public_key).unwrap_or_else(|| fail("bad_owner_approval"));
        if owner.as_str() != hex(&owner_key) {
            fail("not_current_owner");
        }
        let key = (token_id.clone(), chain);
        if self.active_sweeps.get(&key).is_some_and(|sweep| sweep.signing || sweep.expires_at_ms > now_ms) {
            fail("sweep_already_active");
        }
        let expected_sequence = self.sweep_sequences.get(&key).copied().unwrap_or(0);
        if sequence != expected_sequence {
            fail("sweep_sequence_used");
        }
        let payload = decode_hex(&signing_payload_hex).unwrap_or_else(|| fail("bad_sweep_payload"));
        let signer_payload = checked_sweep_payload(chain, &payload, &usdc_contract, amount_base_units, &destination)
            .unwrap_or_else(|| fail("bad_sweep_payload"));
        let envelope = SweepApprovalEnvelope {
            contract_id: env::current_account_id(),
            signer_id: signer_id.clone(),
            token_id: token_id.clone(),
            chain,
            path: path.clone(),
            usdc_contract: usdc_contract.clone(),
            amount_base_units,
            destination: destination.clone(),
            refund_recipient: refund_recipient.clone(),
            route_id: route_id.clone(),
            sequence,
            expiry_ms,
            signing_payload_sha256: env::sha256(&payload).try_into().unwrap_or_else(|_| fail("hash_length")),
        };
        let signature: [u8; 64] = decode_hex(&owner_approval.signature)
            .and_then(|bytes| bytes.try_into().ok())
            .unwrap_or_else(|| fail("bad_owner_approval"));
        if !env::ed25519_verify(&signature, &sweep_approval_hash(&envelope), &owner_key) {
            fail("bad_owner_approval");
        }
        let new_sequence = sequence.checked_add(1).unwrap_or_else(|| fail("sweep_sequence_exhausted"));
        let new_active = self.active_sweeps.get(&key).is_none();
        let new_sequence_record = self.sweep_sequences.get(&key).is_none();
        let reserve_bytes = u64::from(new_active) * SWEEP_ACTIVE_RECORD_BYTES
            + u64::from(new_sequence_record) * SWEEP_SEQUENCE_RECORD_BYTES;
        let reserve = u128::from(reserve_bytes)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"));
        let required = u128::from(env::storage_usage().saturating_add(reserve_bytes))
            .saturating_mul(env::storage_byte_cost().as_yoctonear())
            .saturating_add(1);
        if self.pool < reserve || env::account_balance().as_yoctonear() < required {
            fail("sweep_storage_unavailable");
        }
        let before = env::storage_usage();
        self.sweep_sequences.insert(key.clone(), new_sequence);
        self.active_sweeps.insert(key, ActiveSweep {
            route_id: route_id.clone(), sequence,
            expires_at_ms: now_ms.saturating_add(SWEEP_WINDOW_MS), signing: true,
        });
        self.sweep_sequences.flush();
        self.active_sweeps.flush();
        if env::storage_usage().saturating_sub(before) > reserve_bytes {
            fail("sweep_record_too_large");
        }
        self.pool -= reserve;
        NearlingEvent::CrossChainSweepAuthorized {
            token_id: token_id.clone(), owner_id: owner.clone(), chain, route_id: route_id.clone(), amount_base_units,
            destination, refund_recipient, sequence,
        }.emit();
        let payload_kind = match chain {
            SweepChain::Base => "Ecdsa",
            SweepChain::Solana => "Eddsa",
        };
        let request = near_sdk::serde_json::json!({"request": {
            "path": path,
            "payload_v2": {payload_kind: hex(&signer_payload)},
            "domain_id": chain.domain_id(),
        }});
        Promise::new(signer_id).function_call(
            "sign".to_string(), request.to_string().into_bytes(),
            NearToken::from_yoctonear(1), Gas::from_tgas(30),
        ).then(Promise::new(env::current_account_id()).function_call(
            "on_sweep_signed".to_string(),
            near_sdk::serde_json::json!({"token_id": token_id, "chain": chain,
                "route_id": route_id, "sequence": sequence}).to_string().into_bytes(),
            NearToken::from_yoctonear(0), Gas::from_tgas(10),
        ))
    }

    #[private]
    pub fn on_sweep_signed(&mut self, token_id: TokenId, chain: SweepChain,
        route_id: String, sequence: u64) -> Option<String> {
        let key = (token_id.clone(), chain);
        let active = self.active_sweeps.get(&key).cloned().unwrap_or_else(|| fail("sweep_not_active"));
        if active.route_id != route_id || active.sequence != sequence || !active.signing {
            fail("sweep_not_active");
        }
        if let Ok(bytes) = env::promise_result_checked(0, 1024) {
            if let Ok(value) = near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&bytes) {
                let expected = match chain { SweepChain::Base => "Secp256k1", SweepChain::Solana => "Ed25519" };
                if value.get("scheme").and_then(|v| v.as_str()) == Some(expected) {
                    self.active_sweeps.insert(key, ActiveSweep { signing: false, ..active });
                    return String::from_utf8(bytes).ok();
                }
            }
        }
        self.active_sweeps.remove(&key);
        self.pool = self.pool.checked_add(u128::from(SWEEP_ACTIVE_RECORD_BYTES)
            * env::storage_byte_cost().as_yoctonear()).unwrap_or_else(|| fail("overflow"));
        NearlingEvent::CrossChainSweepSignFailed { token_id, chain, route_id, sequence }.emit();
        None
    }

    // spec: add-pet-experience › Experience view contract › public read
    // spec: add-pet-experience › Experience view contract › unknown pet
    pub fn experience_view(&self, token_id: TokenId) -> Option<ExperienceView> {
        if self.tokens.owner_by_id.get(&token_id).is_none() {
            return None;
        }
        let counts = self
            .experience_counts
            .get(&token_id)
            .cloned()
            .unwrap_or_default();
        Some(ExperienceView {
            token_id,
            paid_hires: counts.paid_hires,
            completed_errands: counts.completed_errands,
            counted_since: self.experience_counted_since,
        })
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    /// Public, read-only totals kept by the calls that change them.
    pub fn showcase_view(&self) -> ShowcaseView {
        ShowcaseView {
            pets_hatched: self.pets_hatched,
            thoughts_paid: self.thoughts_paid,
            spent: U128(self.spent),
            hires_completed: self.hires_completed,
            friend_snacks: self.friend_snacks,
            counted_since: self.counted_since,
        }
    }

    /// One active public hash per pet. The words and link code never enter contract state.
    // spec: add-pet-errands › Shared job open contract › open a job
    pub fn shared_job_open(&mut self, token_id: TokenId, job_hash: String, allowance_yocto: U128) {
        self.assert_server();
        let allowance = allowance_yocto.0;
        if allowance == 0 {
            fail("zero_allowance");
        }
        if allowance > MAX_THOUGHT_PRICE {
            fail("allowance_over_cap");
        }
        let hash = unhex32(&job_hash).unwrap_or_else(|| fail("bad_job_hash"));
        if self.pets.get(&token_id).is_none() {
            fail("no_pet");
        }
        if self.shared_jobs.get(&token_id).is_some() {
            fail("shared_job_active");
        }
        let stake = u128::from(SHARED_JOB_MAX_BYTES)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"));
        self.pool = self
            .pool
            .checked_sub(stake)
            .unwrap_or_else(|| fail("pool_empty"));
        self.shared_jobs.insert(
            token_id.clone(),
            SharedJob {
                hash,
                allowance,
                state: SharedJobState::Funding,
                linked_near: 0,
                linked_snack: 0,
                funding: Vec::new(),
            },
        );
        NearlingEvent::SharedJobOpen {
            token_id,
            job_hash: hex(&hash),
            allowance: U128(allowance),
            state: SharedJobState::Funding,
        }
        .emit();
    }

    // spec: add-pet-errands › Shared job start contract › funded job starts
    pub fn shared_job_start(&mut self, token_id: TokenId, job_hash: String) {
        self.assert_server();
        let hash = unhex32(&job_hash).unwrap_or_else(|| fail("bad_job_hash"));
        let mut job = self
            .shared_jobs
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_shared_job"));
        if job.hash != hash {
            fail("wrong_job_hash");
        }
        if job.state != SharedJobState::Funding {
            fail("job_not_funding");
        }
        let linked = job
            .linked_near
            .checked_add(job.linked_snack)
            .unwrap_or_else(|| fail("overflow"));
        if linked < job.allowance {
            fail("job_unfunded");
        }
        job.state = SharedJobState::Running;
        self.shared_jobs.insert(token_id.clone(), job);
        NearlingEvent::SharedJobStart {
            token_id,
            job_hash: hex(&hash),
            state: SharedJobState::Running,
        }
        .emit();
    }

    /// A settled job closes by the server; otherwise the current implicit owner must sign.
    // spec: add-pet-errands › Shared job close contract › owner closes a waiting job
    pub fn shared_job_close(
        &mut self,
        token_id: TokenId,
        job_hash: String,
        owner_approval: Option<OwnerCloseApproval>,
    ) {
        self.assert_server();
        let hash = unhex32(&job_hash).unwrap_or_else(|| fail("bad_job_hash"));
        let job = self
            .shared_jobs
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_shared_job"));
        if job.hash != hash {
            fail("wrong_job_hash");
        }
        if job.state != SharedJobState::Settled {
            let approval = owner_approval.unwrap_or_else(|| fail("owner_approval_required"));
            let key = unhex32(&approval.public_key).unwrap_or_else(|| fail("bad_owner_approval"));
            let owner = self
                .tokens
                .owner_by_id
                .get(&token_id)
                .unwrap_or_else(|| fail("no_pet"));
            if owner.as_str() != hex(&key) {
                fail("not_current_owner");
            }
            let signature: [u8; 64] = decode_hex(&approval.signature)
                .and_then(|bytes| bytes.try_into().ok())
                .unwrap_or_else(|| fail("bad_owner_approval"));
            let message =
                close_intent_message(env::current_account_id().as_str(), &token_id, &hash);
            let digest = env::sha256(message.as_bytes());
            if !env::ed25519_verify(&signature, &digest, &key) {
                fail("bad_owner_approval");
            }
        }
        self.release_shared_job(token_id, job);
    }

    fn release_shared_job(&mut self, token_id: TokenId, job: SharedJob) {
        self.shared_jobs.remove(&token_id);
        let stake = u128::from(SHARED_JOB_MAX_BYTES)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"));
        self.pool = self
            .pool
            .checked_add(stake)
            .unwrap_or_else(|| fail("overflow"));
        // Linked food was already credited to the pet at feed/snack time. Removing the
        // reservation makes it ordinary without writing to the pet record again.
        NearlingEvent::SharedJobClose {
            token_id,
            job_hash: hex(&job.hash),
            linked_near_released: U128(job.linked_near),
            linked_snack_released: U128(job.linked_snack),
        }
        .emit();
    }

    /// Anyone adds NEAR to the project's pool.
    #[payable]
    pub fn pool_fund(&mut self) {
        let deposit = env::attached_deposit().as_yoctonear();
        if deposit == 0 {
            fail("zero_deposit");
        }
        self.pool = self
            .pool
            .checked_add(deposit)
            .unwrap_or_else(|| fail("overflow"));
    }

    /// Anyone adds NEAR to the reserve that pays the storage of the riddle commits. No way out.
    #[payable]
    pub fn riddle_storage_fund(&mut self) {
        let deposit = env::attached_deposit().as_yoctonear();
        if deposit == 0 {
            fail("zero_deposit");
        }
        self.riddle_reserve = self
            .riddle_reserve
            .checked_add(deposit)
            .unwrap_or_else(|| fail("overflow"));
    }

    /// Server only, no deposit. The pool pays the storage and the starter food.
    pub fn pet_mint(&mut self, receiver: AccountId, name: String, character: String) -> TokenId {
        self.assert_server();
        if self.tokens.nft_supply_for_owner(receiver.clone()).0 > 0 {
            fail("already_owns_pet");
        }
        let now = env::block_timestamp();
        let day = day_of(now);
        let born_today = self.births_today_now();
        if born_today >= BIRTHS_PER_DAY {
            fail("daily_births");
        }
        if name.len() > MAX_NAME_BYTES {
            fail("name_too_long");
        }
        if character.len() > MAX_CHARACTER_BYTES {
            fail("character_too_long");
        }

        let token_id = self.next_token_id.to_string();
        let character_sha256 = hex(&env::sha256(character.as_bytes()));
        let storage_before = env::storage_usage();
        self.tokens
            .internal_mint_with_refund(token_id.clone(), receiver.clone(), None, None);
        self.pets.insert(
            token_id.clone(),
            VersionedPet::V7(PetV7::from(Pet {
                name,
                character,
                born_at: now,
                project_food: STARTER_FOOD,
                given_food: 0,
                debit_day: 0,
                debited_today: 0,
                last_debit_id: 0,
                stage: Stage::Baby,
                stage_day: day,
                streak: 0,
                freezes: 1,
                friend_snack_day: 0,
                friend_snacks: 0,
                owner_snack_at: 0,
                traits: [0, 0],
                last_streak_day: 0,
                outfits: 0,
                job_day: 0,
                jobs_today: 0,
            })),
        );
        self.hatched.insert(receiver.clone(), token_id.clone());
        self.pets.flush();
        self.hatched.flush();

        // The birth, its next owner's list entry and its first transfer-generation entry
        // are all paid from the pool before a transfer can use the reserve.
        let bytes = env::storage_usage()
            .saturating_sub(storage_before)
            .checked_add(OWNER_LIST_ENTRY_BYTES)
            .and_then(|bytes| bytes.checked_add(TRANSFER_GENERATION_BYTES))
            .unwrap_or_else(|| fail("overflow"));
        #[cfg(test)]
        let bytes = bytes
            .checked_add(TEST_BIRTH_EXTRA_BYTES.with(|extra| extra.get()))
            .unwrap_or_else(|| fail("overflow"));
        let cost = u128::from(bytes)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .and_then(|storage| storage.checked_add(STARTER_FOOD))
            .unwrap_or_else(|| fail("overflow"));
        assert_birth_cost(cost);
        if self.pool < cost {
            fail("pool_empty");
        }
        self.pool -= cost;
        self.births_day = day;
        self.births_today = born_today + 1;
        self.next_token_id = self
            .next_token_id
            .checked_add(1)
            .unwrap_or_else(|| fail("overflow"));
        self.pets_hatched = self
            .pets_hatched
            .checked_add(1)
            .unwrap_or_else(|| fail("overflow"));

        NftMint {
            owner_id: &receiver,
            token_ids: &[&token_id],
            memo: None,
        }
        .emit();
        NearlingEvent::PetBorn {
            token_id: token_id.clone(),
            owner_id: receiver,
            character_sha256,
        }
        .emit();
        token_id
    }

    /// Server only. Activates the public reserve while retaining any saved food after a gift.
    // spec: add-pet-will › Will reserve contract › start accepted
    // spec: add-pet-will › Will reserve contract › wrong caller
    // spec: add-pet-will › Will reserve contract › unknown pet
    pub fn will_start(&mut self, token_id: TokenId) {
        self.assert_server();
        let mut record = self
            .pets
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_pet"));
        record.current_mut().wish_active = true;
        self.put_pet(token_id, record);
    }

    /// Server only. Returns saved food to this same pet; no account can receive it.
    // spec: add-pet-will › Wish release contract › release accepted
    // spec: add-pet-will › Wish release contract › wrong caller
    // spec: add-pet-will › Wish release contract › release exceeds reserve
    pub fn will_release(&mut self, token_id: TokenId, amount: U128) {
        self.assert_server();
        let mut record = self
            .pets
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_pet"));
        let pet = record.current_mut();
        pet.wish_reserve = pet
            .wish_reserve
            .checked_sub(amount.0)
            .unwrap_or_else(|| fail("reserve_short"));
        pet.given_food = pet
            .given_food
            .checked_add(amount.0)
            .unwrap_or_else(|| fail("overflow"));
        if pet.wish_reserve == 0 {
            pet.wish_active = false;
        }
        self.put_pet(token_id, record);
    }

    /// The owner gives a whole pet away. Only NEP-171 ownership and enumeration move;
    /// every game record stays under the same token id.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        if env::attached_deposit() != NearToken::from_yoctonear(1) {
            fail("one_yocto");
        }
        if memo.as_deref().is_some_and(|text| !text.is_empty()) {
            fail("memo_not_empty");
        }
        let owner_id = self
            .tokens
            .owner_by_id
            .get(&token_id)
            .unwrap_or_else(|| fail("no_pet"));
        if env::predecessor_account_id() != owner_id {
            fail("not_owner");
        }
        self.tokens
            .nft_transfer(receiver_id, token_id.clone(), approval_id, None);
        let mut record = self
            .pets
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_pet"));
        record.current_mut().wish_active = false;
        self.put_pet(token_id.clone(), record);
        if let Some(mut job) = self.shared_jobs.get(&token_id).cloned() {
            match job.state {
                SharedJobState::Funding => self.release_shared_job(token_id.clone(), job),
                SharedJobState::Running => {
                    job.state = SharedJobState::Transferred;
                    self.shared_jobs.insert(token_id.clone(), job.clone());
                    NearlingEvent::SharedJobTransferred {
                        token_id: token_id.clone(),
                        job_hash: hex(&job.hash),
                        state: job.state,
                    }
                    .emit();
                }
                SharedJobState::Transferred | SharedJobState::Settled => {}
            }
        }
        let next = self
            .transfer_generation
            .get(&token_id)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .unwrap_or_else(|| fail("overflow"));
        self.transfer_generation.insert(token_id, next);
        self.transfer_generation.flush();
    }

    /// Server only, no deposit. One call debits a session's batch of 1–12 thoughts, whole or not
    /// at all; the sum goes to the treasury.
    pub fn debit_session(
        &mut self,
        token_id: TokenId,
        debit_id: u64,
        thoughts: Vec<ThoughtReceipt>,
    ) {
        self.assert_server();
        if thoughts.is_empty() {
            fail("empty_batch");
        }
        if thoughts.len() > MAX_THOUGHTS_PER_DEBIT {
            fail("too_many_thoughts");
        }
        let mut record = self
            .pets
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_pet"));
        let pet = record.current_mut();
        if Some(debit_id) != pet.last_debit_id.checked_add(1) {
            fail("bad_debit_id");
        }

        // A debate line has one payer and one receipt. Validate both current owners' transfer
        // versions before touching food, storage or the receipt sequence.
        if thoughts.iter().any(|thought| thought.debate.is_some()) {
            if thoughts.len() != 1 {
                fail("debate_one_line");
            }
            let thought = &thoughts[0];
            let debate = thought
                .debate
                .as_ref()
                .unwrap_or_else(|| fail("bad_debate"));
            if unhex32(&debate.id).is_none() {
                fail("bad_debate_id");
            }
            if !(1..=4).contains(&debate.line_order) {
                fail("bad_debate_order");
            }
            if debate.other_token_id == token_id
                || !self.tokens.owner_by_id.contains_key(&debate.other_token_id)
            {
                fail("bad_debate_other_pet");
            }
            if thought.worker.is_some()
                || thought.hire.is_some()
                || thought.job_hash.is_some()
                || thought.completed_errand
            {
                fail("bad_debate_line");
            }
            let speaker_version = self
                .transfer_generation
                .get(&token_id)
                .copied()
                .unwrap_or(0);
            let other_version = self
                .transfer_generation
                .get(&debate.other_token_id)
                .copied()
                .unwrap_or(0);
            if speaker_version != debate.speaker_transfer_generation
                || other_version != debate.other_transfer_generation
            {
                fail("gift_version_changed");
            }
        }

        let today = day_of(env::block_timestamp());
        let next_debate_slot = thoughts[0].debate.as_ref().map(|debate| {
            next_slot(
                self.debate_slots.get(&token_id),
                debate,
                &token_id,
                thoughts[0].price.0,
                today,
            )
        });
        let new_debate_slot =
            next_debate_slot.is_some() && self.debate_slots.get(&token_id).is_none();
        let hirer_owner = self
            .tokens
            .owner_by_id
            .get(&token_id)
            .unwrap_or_else(|| fail("no_pet"));

        // The thoughts without a hire cost their price; a hire costs its fee, which holds the
        // worker's answer, so an answer's price is never counted twice.
        let mut plain: u128 = 0;
        let mut linked_price: u128 = 0;
        let mut claimed_hash: Option<[u8; 32]> = None;
        let mut hires: Vec<PlannedHire> = Vec::new();
        let mut experience_delta: HashMap<TokenId, (u64, u64)> = HashMap::new();
        // The workers touched, read once, and the jobs this batch already gives each.
        let mut workers: HashMap<TokenId, VersionedPet> = HashMap::new();
        let mut batch_jobs: HashMap<TokenId, u8> = HashMap::new();
        for (i, thought) in thoughts.iter().enumerate() {
            if thought.completed_errand {
                if thought.worker.is_some() || thought.hire.is_some() {
                    fail("errand_with_worker");
                }
                if thought.price.0 == 0 {
                    fail("errand_without_payment");
                }
                let delta = experience_delta.entry(token_id.clone()).or_default();
                delta.1 = delta.1.checked_add(1).unwrap_or_else(|| fail("overflow"));
            }
            if thought.calls.is_empty() || thought.calls.len() > MAX_CALLS_PER_THOUGHT {
                fail("bad_calls");
            }
            if thought.price.0 > MAX_THOUGHT_PRICE {
                fail("price_over_cap");
            }
            if let Some(hash) = &thought.job_hash {
                let parsed = unhex32(hash).unwrap_or_else(|| fail("bad_job_hash"));
                if claimed_hash.is_some_and(|previous| previous != parsed) {
                    fail("wrong_job_hash");
                }
                claimed_hash = Some(parsed);
                linked_price = linked_price
                    .checked_add(thought.price.0)
                    .unwrap_or_else(|| fail("overflow"));
                if thought.hire.is_some() {
                    fail("linked_hire");
                }
                continue;
            }
            let Some(hire) = &thought.hire else {
                plain = plain
                    .checked_add(thought.price.0)
                    .unwrap_or_else(|| fail("overflow"));
                continue;
            };
            // The checks of a hire, in the order of `Hire debit contract`.
            let worker = thought
                .worker
                .clone()
                .unwrap_or_else(|| fail_hire(i, "no_worker"));
            let worker_owner = self
                .tokens
                .owner_by_id
                .get(&worker)
                .unwrap_or_else(|| fail_hire(i, "no_worker"));
            if !workers.contains_key(&worker) {
                let stored = self
                    .pets
                    .get(&worker)
                    .cloned()
                    .unwrap_or_else(|| fail_hire(i, "no_worker"));
                workers.insert(worker.clone(), stored);
            }
            if !(HIRE_FEE_MIN..=HIRE_FEE_MAX).contains(&hire.fee.0) {
                fail_hire(i, "fee_band");
            }
            if thought.price.0 >= hire.fee.0 {
                fail_hire(i, "answer_over_fee");
            }
            if worker_owner == hirer_owner {
                fail_hire(i, "same_owner");
            }
            let given_jobs = workers[&worker].current().jobs_today_now(today);
            let batch = batch_jobs.entry(worker.clone()).or_insert(0);
            if u16::from(given_jobs) + u16::from(*batch) >= u16::from(MAX_JOBS_PER_DAY) {
                fail_hire(i, "jobs");
            }
            *batch += 1;
            if hire.kind == HireKind::Pet {
                let paired = pair_key(&token_id, &worker)
                    .is_some_and(|pair| self.work_pairs.contains(&pair));
                if !paired && !self.known.contains(&(token_id.clone(), worker_owner)) {
                    fail_hire(i, "not_known");
                }
            }
            hires.push(PlannedHire {
                thought: i,
                worker: worker.clone(),
                kind: hire.kind,
                skill: hire.skill,
                fee: hire.fee.0,
                price: thought.price.0,
            });
            let delta = experience_delta.entry(worker).or_default();
            delta.0 = delta.0.checked_add(1).unwrap_or_else(|| fail("overflow"));
        }

        // The money: a pet's own hire is paid from the food given to it only, the rest from the
        // project's food first, the cap of the day over all of it (`take_food_split`).
        let mut from_given: u128 = 0;
        let mut rest = plain;
        for hire in &hires {
            match hire.kind {
                HireKind::Pet => {
                    from_given = from_given
                        .checked_add(hire.fee)
                        .unwrap_or_else(|| fail("overflow"));
                    let reserved = self
                        .shared_jobs
                        .get(&token_id)
                        .map(|job| job.linked_near)
                        .unwrap_or(0);
                    if from_given > pet.given_food.saturating_sub(reserved) {
                        fail_hire(hire.thought, "given_short");
                    }
                }
                HireKind::Player => {
                    rest = rest
                        .checked_add(hire.fee)
                        .unwrap_or_else(|| fail("overflow"));
                }
            }
        }
        let mut job = self.shared_jobs.get(&token_id).cloned();
        if let Some(hash) = claimed_hash {
            let active = job.as_ref().unwrap_or_else(|| fail("no_shared_job"));
            if active.hash != hash {
                fail("wrong_job_hash");
            }
            if active.state != SharedJobState::Running
                && active.state != SharedJobState::Transferred
            {
                fail("job_not_running");
            }
            if thoughts.len() != 1 || thoughts[0].job_hash.is_none() {
                fail("shared_one_thought");
            }
            if linked_price > active.allowance {
                fail("shared_allowance");
            }
        }
        let mut receipt_funding: Vec<Vec<FundingSpend>> = vec![Vec::new(); thoughts.len()];
        let mut linked_spent: u128 = 0;
        if claimed_hash.is_some() {
            let active = job.as_mut().unwrap_or_else(|| fail("no_shared_job"));
            for (index, thought) in thoughts.iter().enumerate() {
                if thought.job_hash.is_none() {
                    continue;
                }
                let mut left = thought.price.0;
                for kind in [FundingKind::Near, FundingKind::Snack] {
                    for (funding_index, funding) in active
                        .funding
                        .iter_mut()
                        .enumerate()
                        .filter(|(_, entry)| entry.kind == kind)
                    {
                        let available = funding
                            .amount
                            .checked_sub(funding.spent)
                            .unwrap_or_else(|| fail("overflow"));
                        let spent = left.min(available);
                        if spent == 0 {
                            continue;
                        }
                        funding.spent = funding
                            .spent
                            .checked_add(spent)
                            .unwrap_or_else(|| fail("overflow"));
                        linked_spent = linked_spent
                            .checked_add(spent)
                            .unwrap_or_else(|| fail("overflow"));
                        match kind {
                            FundingKind::Near => {
                                active.linked_near = active
                                    .linked_near
                                    .checked_sub(spent)
                                    .unwrap_or_else(|| fail("overflow"));
                                pet.given_food = pet
                                    .given_food
                                    .checked_sub(spent)
                                    .unwrap_or_else(|| fail("over_food"));
                            }
                            FundingKind::Snack => {
                                active.linked_snack = active
                                    .linked_snack
                                    .checked_sub(spent)
                                    .unwrap_or_else(|| fail("overflow"));
                                pet.project_food = pet
                                    .project_food
                                    .checked_sub(spent)
                                    .unwrap_or_else(|| fail("over_food"));
                            }
                        }
                        receipt_funding[index].push(FundingSpend {
                            index: u8::try_from(funding_index).unwrap_or_else(|_| fail("overflow")),
                            kind,
                            amount: U128(spent),
                        });
                        left = left.checked_sub(spent).unwrap_or_else(|| fail("overflow"));
                        if left == 0 {
                            break;
                        }
                    }
                    if left == 0 {
                        break;
                    }
                }
                if active.state == SharedJobState::Transferred && left != 0 {
                    fail("linked_short_after_gift");
                }
                rest = rest.checked_add(left).unwrap_or_else(|| fail("overflow"));
            }
            active.state = SharedJobState::Settled;
        }
        let day = day_of(env::block_timestamp());
        let already = if pet.debit_day == day {
            pet.debited_today
        } else {
            0
        };
        pet.debited_today = already
            .checked_add(linked_spent)
            .filter(|amount| *amount <= DAILY_CAP)
            .unwrap_or_else(|| fail("daily_cap"));
        pet.debit_day = day;
        take_ordinary_food(pet, from_given, rest, job.as_ref());
        // Keep existing food and daily-cap refusals ahead of the new storage check. A
        // short pool still rolls the entire transaction back before any payout.
        let new_records = experience_delta
            .keys()
            .filter(|id| self.experience_counts.get(*id).is_none())
            .count();
        let experience_reserve = u128::try_from(new_records)
            .unwrap_or_else(|_| fail("overflow"))
            .checked_mul(u128::from(EXPERIENCE_COUNT_BYTES))
            .and_then(|bytes| bytes.checked_mul(env::storage_byte_cost().as_yoctonear()))
            .unwrap_or_else(|| fail("overflow"));
        let debate_reserve = if new_debate_slot {
            u128::from(DEBATE_SLOT_BYTES)
                .checked_mul(env::storage_byte_cost().as_yoctonear())
                .unwrap_or_else(|| fail("overflow"))
        } else {
            0
        };
        let reserve = experience_reserve
            .checked_add(debate_reserve)
            .unwrap_or_else(|| fail("overflow"));
        self.pool = self
            .pool
            .checked_sub(reserve)
            .unwrap_or_else(|| fail("pool_empty"));
        pet.last_debit_id = debit_id;
        self.put_pet(token_id.clone(), record);
        if let Some(active) = job {
            if claimed_hash.is_some() {
                self.shared_jobs.insert(token_id.clone(), active);
            }
        }

        // What the treasury gets: the thoughts without a hire and the worker answers' prices; the
        // rest of each fee stays in the contract as the worker's given food.
        let mut to_treasury = plain
            .checked_add(linked_price)
            .unwrap_or_else(|| fail("overflow"));
        for hire in &hires {
            let record = workers
                .get_mut(&hire.worker)
                .unwrap_or_else(|| fail("no_worker"));
            let worker = record.current_mut();
            let earned = hire
                .fee
                .checked_sub(hire.price)
                .unwrap_or_else(|| fail("overflow"));
            let after_food = worker
                .project_food
                .checked_add(worker.given_food)
                .and_then(|food| food.checked_add(earned))
                .unwrap_or_else(|| fail("overflow"));
            let (linked_near, linked_snack) = self
                .shared_jobs
                .get(&hire.worker)
                .map(|job| (job.linked_near, job.linked_snack))
                .unwrap_or((0, 0));
            let spendable_after_credit = after_food
                .checked_sub(linked_near)
                .and_then(|food| food.checked_sub(linked_snack))
                .unwrap_or_else(|| fail("over_food"));
            let saved = if worker.wish_active {
                (earned / 4)
                    .min(
                        OUTFIT_PRICE
                            .checked_sub(worker.wish_reserve)
                            .unwrap_or_else(|| fail("reserve_over_price")),
                    )
                    .min(spendable_after_credit.saturating_sub(WISH_FLOOR))
            } else {
                0
            };
            worker.wish_reserve = worker
                .wish_reserve
                .checked_add(saved)
                .unwrap_or_else(|| fail("overflow"));
            worker.given_food = worker
                .given_food
                .checked_add(earned - saved)
                .unwrap_or_else(|| fail("overflow"));
            worker.jobs_today = worker.jobs_today_now(today) + 1;
            worker.job_day = today;
            to_treasury = to_treasury
                .checked_add(hire.price)
                .unwrap_or_else(|| fail("overflow"));
        }
        for (worker, record) in workers {
            self.put_pet(worker, record);
        }
        // The pets' records first, so the measure of a pair below counts the pair alone.
        self.pets.flush();
        if let Some(slot) = next_debate_slot {
            let before_slot = env::storage_usage();
            self.debate_slots.insert(token_id.clone(), slot);
            self.debate_slots.flush();
            let written = env::storage_usage()
                .checked_sub(before_slot)
                .unwrap_or_else(|| fail("overflow"));
            let cost = u128::from(written)
                .checked_mul(env::storage_byte_cost().as_yoctonear())
                .unwrap_or_else(|| fail("overflow"));
            if cost > debate_reserve {
                fail("debate_storage_bound");
            }
            self.pool = self
                .pool
                .checked_add(debate_reserve - cost)
                .unwrap_or_else(|| fail("overflow"));
        }
        for hire in &hires {
            self.introduce_pair(&token_id, &hire.worker);
        }
        let before_counts = env::storage_usage();
        for (id, (hires, errands)) in experience_delta {
            let mut counts = self.experience_counts.get(&id).cloned().unwrap_or_default();
            counts.paid_hires = counts
                .paid_hires
                .checked_add(hires)
                .unwrap_or_else(|| fail("overflow"));
            counts.completed_errands = counts
                .completed_errands
                .checked_add(errands)
                .unwrap_or_else(|| fail("overflow"));
            self.experience_counts.insert(id, counts);
        }
        self.experience_counts.flush();
        let written = env::storage_usage()
            .checked_sub(before_counts)
            .unwrap_or_else(|| fail("overflow"));
        let cost = u128::from(written)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail("overflow"));
        if cost > experience_reserve {
            fail("experience_storage_bound");
        }
        self.pool = self
            .pool
            .checked_add(experience_reserve - cost)
            .unwrap_or_else(|| fail("overflow"));

        self.thoughts_paid = self
            .thoughts_paid
            .checked_add(u64::try_from(thoughts.len()).unwrap_or_else(|_| fail("overflow")))
            .unwrap_or_else(|| fail("overflow"));
        self.spent = self
            .spent
            .checked_add(to_treasury)
            .unwrap_or_else(|| fail("overflow"));
        self.hires_completed = self
            .hires_completed
            .checked_add(u64::try_from(hires.len()).unwrap_or_else(|_| fail("overflow")))
            .unwrap_or_else(|| fail("overflow"));

        // The events in receipt order, a hire right after its answer's receipt.
        let mut planned = hires.into_iter().peekable();
        for (i, thought) in thoughts.into_iter().enumerate() {
            NearlingEvent::Receipt {
                token_id: token_id.clone(),
                debit_id,
                model: thought.model,
                price: thought.price,
                calls: thought.calls,
                worker: thought.worker,
                job_hash: thought.job_hash,
                funding: std::mem::take(&mut receipt_funding[i]),
                completed_errand: thought.completed_errand,
                debate_id: thought.debate.as_ref().map(|debate| debate.id.clone()),
                line_order: thought.debate.as_ref().map(|debate| debate.line_order),
            }
            .emit();
            if let Some(hire) = planned.next_if(|h| h.thought == i) {
                NearlingEvent::Hire {
                    debit_id,
                    hirer: token_id.clone(),
                    worker: hire.worker,
                    kind: hire.kind,
                    skill: hire.skill,
                    fee: U128(hire.fee),
                    answer_cost: U128(hire.price),
                }
                .emit();
            }
        }
        Promise::new(self.treasury_id.clone())
            .transfer(NearToken::from_yoctonear(to_treasury))
            .detach();
    }

    /// Anyone, with at least `MIN_FEED` attached; the whole deposit becomes the pet's given food.
    /// Works for an asleep pet and at the daily cap. A feeder who is not the owner and is new to
    /// the pet becomes known when the pool covers the record. Returns whether a record was written.
    #[payable]
    pub fn pet_feed(&mut self, token_id: TokenId, job_hash: Option<String>) -> bool {
        let deposit = env::attached_deposit().as_yoctonear();
        if deposit < MIN_FEED {
            fail("feed_too_small");
        }
        let mut record = self
            .pets
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_pet"));
        let feeder = env::predecessor_account_id();
        let is_owner = self.tokens.owner_by_id.get(&token_id).as_ref() == Some(&feeder);
        let mut job = job_hash.as_ref().map(|hash| {
            let parsed = unhex32(hash).unwrap_or_else(|| fail("bad_job_hash"));
            let active = self
                .shared_jobs
                .get(&token_id)
                .cloned()
                .unwrap_or_else(|| fail("no_shared_job"));
            if active.hash != parsed {
                fail("wrong_job_hash");
            }
            if is_owner {
                fail("owner_tag");
            }
            if active.state != SharedJobState::Funding {
                fail("job_not_funding");
            }
            if active
                .linked_near
                .checked_add(active.linked_snack)
                .unwrap_or_else(|| fail("overflow"))
                >= active.allowance
            {
                fail("job_funded");
            }
            active
        });
        let pet = record.current_mut();
        pet.given_food = pet
            .given_food
            .checked_add(deposit)
            .unwrap_or_else(|| fail("overflow"));
        self.put_pet(token_id.clone(), record);

        let mut funding_index = None;
        if let Some(active) = job.as_mut() {
            active.linked_near = active
                .linked_near
                .checked_add(deposit)
                .unwrap_or_else(|| fail("overflow"));
            funding_index =
                Some(u8::try_from(active.funding.len()).unwrap_or_else(|_| fail("overflow")));
            active.funding.push(SharedFunding {
                feeder: feeder.clone(),
                kind: FundingKind::Near,
                amount: deposit,
                spent: 0,
            });
            self.shared_jobs.insert(token_id.clone(), active.clone());
        }
        let introduced = !is_owner && self.introduce(&token_id, &feeder, 0);

        NearlingEvent::Feed {
            token_id,
            feeder,
            amount: U128(deposit),
            job_hash,
            funding_index,
        }
        .emit();
        introduced
    }

    /// Server only, no deposit. A snack from the pool into the pet's project food: from a friend,
    /// at most `FRIEND_SNACKS_PER_DAY` a UTC day; to the owner, at most once in 72 hours, and only
    /// when `feeder` is the current owner. A friend new to the pet becomes known when the pool
    /// covers the record on top of the snack. Returns whether a record was written.
    pub fn pet_snack(
        &mut self,
        token_id: TokenId,
        feeder: AccountId,
        kind: SnackKind,
        job_hash: Option<String>,
    ) -> bool {
        self.assert_server();
        let mut job = job_hash.as_ref().map(|hash| {
            let parsed = unhex32(hash).unwrap_or_else(|| fail("bad_job_hash"));
            let active = self
                .shared_jobs
                .get(&token_id)
                .cloned()
                .unwrap_or_else(|| fail("no_shared_job"));
            if active.hash != parsed {
                fail("wrong_job_hash");
            }
            if self.tokens.owner_by_id.get(&token_id).as_ref() == Some(&feeder)
                || kind != SnackKind::Friend
            {
                fail("owner_tag");
            }
            if active.state != SharedJobState::Funding {
                fail("job_not_funding");
            }
            if active
                .linked_near
                .checked_add(active.linked_snack)
                .unwrap_or_else(|| fail("overflow"))
                >= active.allowance
            {
                fail("job_funded");
            }
            active
        });
        let mut record = self
            .pets
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_pet"));
        let pet = record.current_mut();
        let now = env::block_timestamp();
        let day = day_of(now);
        match kind {
            SnackKind::Friend => {
                let taken = if pet.friend_snack_day == day {
                    pet.friend_snacks
                } else {
                    0
                };
                if taken >= FRIEND_SNACKS_PER_DAY {
                    fail("snacks_today");
                }
                pet.friend_snack_day = day;
                pet.friend_snacks = taken + 1;
            }
            SnackKind::Owner => {
                if self.tokens.owner_by_id.get(&token_id).as_ref() != Some(&feeder) {
                    fail("feeder_not_owner");
                }
                let due = pet
                    .owner_snack_at
                    .checked_add(OWNER_SNACK_EVERY_NS)
                    .unwrap_or_else(|| fail("overflow"));
                if pet.owner_snack_at != 0 && now < due {
                    fail("snack_too_soon");
                }
                pet.owner_snack_at = now;
            }
        }
        if self.pool < SNACK_AMOUNT {
            fail("pool_empty");
        }
        pet.project_food = pet
            .project_food
            .checked_add(SNACK_AMOUNT)
            .unwrap_or_else(|| fail("overflow"));
        self.put_pet(token_id.clone(), record);

        let introduced =
            kind == SnackKind::Friend && self.introduce(&token_id, &feeder, SNACK_AMOUNT);
        self.pool -= SNACK_AMOUNT;
        let mut funding_index = None;
        if let Some(active) = job.as_mut() {
            active.linked_snack = active
                .linked_snack
                .checked_add(SNACK_AMOUNT)
                .unwrap_or_else(|| fail("overflow"));
            funding_index =
                Some(u8::try_from(active.funding.len()).unwrap_or_else(|_| fail("overflow")));
            active.funding.push(SharedFunding {
                feeder: feeder.clone(),
                kind: FundingKind::Snack,
                amount: SNACK_AMOUNT,
                spent: 0,
            });
            self.shared_jobs.insert(token_id.clone(), active.clone());
        }
        if kind == SnackKind::Friend {
            self.friend_snacks = self
                .friend_snacks
                .checked_add(1)
                .unwrap_or_else(|| fail("overflow"));
        }

        NearlingEvent::Snack {
            token_id,
            amount: U128(SNACK_AMOUNT),
            kind,
            friend: (kind == SnackKind::Friend).then_some(feeder),
            job_hash,
            funding_index,
        }
        .emit();
        introduced
    }

    /// Server only, no deposit. Moves the pet into the stage after its own, once in a UTC day (the
    /// birth counts), with a trait of the five. The trait is stored in the teen's or the adult's
    /// slot of the fixed-size record, so the call writes no new byte.
    pub fn pet_grow(&mut self, token_id: TokenId, stage: Stage, r#trait: Trait) {
        self.assert_server();
        let mut record = self
            .pets
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_pet"));
        let pet = record.current_mut();
        if pet.stage.next() != Some(stage) {
            fail("bad_stage");
        }
        let day = day_of(env::block_timestamp());
        if pet.stage_day >= day {
            fail("stage_today");
        }
        pet.stage = stage;
        pet.stage_day = day;
        match stage {
            Stage::Teen => pet.traits[0] = r#trait.code(),
            Stage::Adult => pet.traits[1] = r#trait.code(),
            Stage::Baby => unreachable!("Baby is nobody's next stage"),
        }
        self.put_pet(token_id.clone(), record);

        NearlingEvent::Grow {
            token_id,
            stage,
            trait_: r#trait,
        }
        .emit();
    }

    /// Server only, no deposit. Counts the UTC `day` of a completed ritual (ADR-010): the contract
    /// derives the break, the freezes it spends and the freeze a 7th day earns. `skipped` is the
    /// days between the last counted day and `day` that the server excuses; it is not read on a
    /// pet's first mark. A refused call changes nothing: the pet is written at the end.
    pub fn streak_mark(&mut self, token_id: TokenId, day: u64, skipped: u32) {
        self.assert_server();
        let mut record = self
            .pets
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_pet"));
        let pet = record.current_mut();
        let today = day_of(env::block_timestamp());
        if day > today || day.saturating_add(1) < today || day < day_of(pet.born_at) {
            fail("bad_day");
        }
        let last = pet.last_streak_day;
        if last != 0 && day <= last {
            fail("day_marked");
        }
        if last != 0 && u64::from(skipped) > day - last - 1 {
            fail("too_many_skipped");
        }
        let (streak, freezes, spent) = next_streak(pet.streak, pet.freezes, last, day, skipped);
        pet.streak = streak;
        pet.freezes = freezes;
        pet.last_streak_day = day;
        // The threshold's item (1 and 3 days), once: a restart that meets it again earns nothing.
        let earned = streak_item(streak).filter(|item| !pet.has(*item));
        if let Some(item) = earned {
            pet.give(item);
        }
        self.put_pet(token_id.clone(), record);

        NearlingEvent::Streak {
            token_id: token_id.clone(),
            day,
            streak,
            freezes,
            spent,
        }
        .emit();
        if let Some(item) = earned {
            NearlingEvent::Outfit {
                token_id,
                item,
                via: OutfitVia::Streak,
                price: None,
            }
            .emit();
        }
    }

    /// Server only, no deposit. Gives the pet the item of its first solved riddle (the Thinking
    /// cap), once, and not before the UTC day after the day it was born. It is the only item this
    /// method gives. The record has a byte for it since the birth, so the call writes no new byte.
    pub fn outfit_grant(&mut self, token_id: TokenId) {
        self.assert_server();
        let mut record = self
            .pets
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_pet"));
        let pet = record.current_mut();
        if day_of(env::block_timestamp()) <= day_of(pet.born_at) {
            fail("outfit_too_early");
        }
        if pet.has(THINKING_CAP) {
            fail("outfit_owned");
        }
        pet.give(THINKING_CAP);
        self.put_pet(token_id.clone(), record);

        NearlingEvent::Outfit {
            token_id,
            item: THINKING_CAP,
            via: OutfitVia::Riddle,
            price: None,
        }
        .emit();
    }

    /// Server only, no deposit. Ordinary purchases spend project food first; a wish purchase
    /// spends only an active reserve. Both share the pet's UTC daily debit cap.
    // spec: add-pet-will › Wish purchase contract › wish purchase accepted
    // spec: add-pet-will › Wish purchase contract › insufficient reserve
    // spec: add-pet-will › Wish purchase contract › daily cap reached
    // spec: add-pet-will › Wish purchase contract › paused after gift
    pub fn outfit_buy(&mut self, token_id: TokenId, item: u8, via_wish: Option<bool>) {
        self.assert_server();
        if !is_bought(item) {
            fail("not_for_sale");
        }
        let mut record = self
            .pets
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_pet"));
        let pet = record.current_mut();
        if pet.has(item) {
            fail("outfit_owned");
        }
        if via_wish.unwrap_or(false) {
            if !pet.wish_active {
                fail("wish_paused");
            }
            if pet.wish_reserve < OUTFIT_PRICE {
                fail("reserve_short");
            }
            let day = day_of(env::block_timestamp());
            let spent = if pet.debit_day == day {
                pet.debited_today
            } else {
                0
            };
            pet.debited_today = spent
                .checked_add(OUTFIT_PRICE)
                .filter(|total| *total <= DAILY_CAP)
                .unwrap_or_else(|| fail("daily_cap"));
            pet.debit_day = day;
            pet.wish_reserve -= OUTFIT_PRICE;
            pet.wish_active = false;
        } else {
            let job = self.shared_jobs.get(&token_id);
            take_ordinary_food(pet, 0, OUTFIT_PRICE, job);
        }
        pet.give(item);
        self.put_pet(token_id.clone(), record);

        NearlingEvent::Outfit {
            token_id,
            item,
            via: if via_wish.unwrap_or(false) {
                OutfitVia::PetWish
            } else {
                OutfitVia::Bought
            },
            price: Some(U128(OUTFIT_PRICE)),
        }
        .emit();
        let payout = Promise::new(self.treasury_id.clone())
            .transfer(NearToken::from_yoctonear(OUTFIT_PRICE));
        if via_wish.unwrap_or(false) {
            payout.detach();
        } else {
            payout
                .then(
                    Promise::new(env::current_account_id()).function_call(
                        "on_outfit_treasury_payout".to_string(),
                        near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
                            "amount": U128(OUTFIT_PRICE)
                        }))
                        .unwrap_or_else(|_| fail("overflow")),
                        NearToken::from_yoctonear(0),
                        Gas::from_tgas(2),
                    ),
                )
                .detach();
        }
    }

    /// A failed ordinary Wardrobe transfer remains payable to the treasury. The debt uses its own
    /// storage key so this fix can upgrade the deployed state without changing its Borsh layout.
    #[private]
    pub fn on_outfit_treasury_payout(&mut self, amount: U128) {
        if env::promise_result_checked(0, 0).is_err() {
            add_outfit_treasury_debt(amount.0);
        }
    }

    pub fn treasury_owed(&self) -> U128 {
        U128(outfit_treasury_owed())
    }

    /// Server-only retry of failed ordinary Wardrobe payouts. If this transfer fails too, its
    /// callback restores the debt; successful transfers clear it exactly once.
    pub fn retry_treasury_payout(&mut self) {
        self.assert_server();
        let amount = outfit_treasury_owed();
        if amount == 0 {
            return;
        }
        env::storage_remove(OUTFIT_TREASURY_DEBT_KEY);
        Promise::new(self.treasury_id.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_outfit_treasury_payout".to_string(),
                    near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
                        "amount": U128(amount)
                    }))
                    .unwrap_or_else(|_| fail("overflow")),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(2),
                ),
            )
            .detach();
    }

    /// Server only, no deposit. Seals the riddle of the current UTC day (`block_timestamp`, never
    /// an argument) with its `hash` (64 hex characters): one a day, and only while the reserve
    /// pays the record's storage.
    pub fn riddle_commit(&mut self, hash: String) {
        self.assert_server();
        let Some(bytes) = unhex32(&hash) else {
            fail("bad_hash");
        };
        let day = day_of(env::block_timestamp());
        if self.riddle_commits.contains_key(&day) {
            fail("commit_today");
        }
        let cost = Self::commit_cost();
        if self.riddle_reserve < cost {
            fail("reserve_empty");
        }
        self.riddle_reserve -= cost;
        self.riddle_commits.insert(day, bytes);

        NearlingEvent::RiddleCommit {
            day,
            hash: hex(&bytes),
        }
        .emit();
    }

    /// Server only, no deposit. Opens the commit of a past UTC day: `riddle`, `answers` and `salt`
    /// hash, with `day`, to the sealed value (sha256 of their borsh bytes, ADR-009). There is no
    /// deadline. The record goes and its storage returns to the reserve.
    pub fn riddle_reveal(&mut self, day: u64, riddle: String, answers: Vec<String>, salt: String) {
        self.assert_server();
        if day >= day_of(env::block_timestamp()) {
            fail("reveal_too_early");
        }
        let Some(sealed) = self.riddle_commits.get(&day).copied() else {
            fail("no_commit");
        };
        let bytes = near_sdk::borsh::to_vec(&(day, &riddle, &answers, &salt))
            .unwrap_or_else(|_| fail("bad_reveal"));
        if env::sha256(&bytes) != sealed {
            fail("bad_reveal");
        }
        self.riddle_reserve = self
            .riddle_reserve
            .checked_add(Self::commit_cost())
            .unwrap_or_else(|| fail("overflow"));
        self.riddle_commits.remove(&day);

        NearlingEvent::RiddleReveal {
            day,
            riddle,
            answers,
            salt,
        }
        .emit();
    }

    /// The commit of `day`, the reserve and the price of a commit's storage.
    pub fn riddle_view(&self, day: u64) -> RiddleView {
        RiddleView {
            hash: self.riddle_commits.get(&day).map(|h| hex(h)),
            reserve: U128(self.riddle_reserve),
            commit_cost: U128(Self::commit_cost()),
        }
    }

    pub fn hatch_view(&self, account_id: AccountId) -> HatchView {
        HatchView {
            owned_count: self.tokens.nft_supply_for_owner(account_id.clone()),
            token_id: self.hatched.get(&account_id).cloned(),
            day: day_of(env::block_timestamp()),
            born_today: self.births_today_now(),
            pool: U128(self.pool),
        }
    }

    /// The pet's record and its current owner; `None` when there is no such pet.
    pub fn pet_view(&self, token_id: TokenId) -> Option<PetView> {
        let record = self.pets.get(&token_id)?;
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        let work_known = token_id
            .parse::<u64>()
            .ok()
            .and_then(|id| self.work_index.get(&id))
            .map(|partners| partners.iter().map(u64::to_string).collect())
            .unwrap_or_default();
        let mut view = PetView::new(
            owner_id,
            &record.current(),
            day_of(env::block_timestamp()),
            work_known,
        );
        view.transfer_generation = self
            .transfer_generation
            .get(&token_id)
            .copied()
            .unwrap_or(0);
        view.paid_debate = self.debate_slots.get(&token_id).map(DebateSlotView::from);
        view.shared_job = self.shared_jobs.get(&token_id).map(|job| SharedJobView {
            hash: hex(&job.hash),
            state: job.state,
            allowance: U128(job.allowance),
            linked_near: U128(job.linked_near),
            linked_snack: U128(job.linked_snack),
        });
        Some(view)
    }

    /// Whether the pet knows the account: a record `pet_feed` or `pet_snack` wrote. False for a
    /// feeder the pool did not cover and for a token that does not exist.
    pub fn pet_knows(&self, token_id: TokenId, account_id: AccountId) -> bool {
        self.known.contains(&(token_id, account_id))
    }

    /// The standard's token; `metadata.extra` holds the pet's stage, traits and items as JSON, built here
    /// from the record on every read (NEP-177: `extra` is «anything extra»).
    pub fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        let mut token = self.tokens.nft_token(token_id.clone())?;
        if let Some(record) = self.pets.get(&token_id) {
            token.metadata = Some(TokenMetadata {
                extra: Some(token_extra(&record.current())),
                ..Default::default()
            });
        }
        Some(token)
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |ch: u8| match ch {
                b'0'..=b'9' => Some(ch - b'0'),
                b'a'..=b'f' => Some(ch - b'a' + 10),
                b'A'..=b'F' => Some(ch - b'A' + 10),
                _ => None,
            };
            Some((digit(pair[0])? << 4) | digit(pair[1])?)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts, get_logs};
    use near_sdk::testing_env;

    const NS_PER_DAY: u64 = DAY_NS;

    fn contract_id() -> AccountId {
        accounts(0)
    }
    fn owner() -> AccountId {
        accounts(1)
    }
    fn server() -> AccountId {
        accounts(2)
    }
    fn treasury() -> AccountId {
        accounts(3)
    }
    fn player(n: usize) -> AccountId {
        format!("player{n}.near").parse().unwrap()
    }

    fn context(predecessor: AccountId, timestamp: u64, deposit: u128) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(contract_id())
            .predecessor_account_id(predecessor)
            .block_timestamp(timestamp)
            .attached_deposit(NearToken::from_yoctonear(deposit));
        builder
    }

    fn funded_contract(pool: u128) -> Contract {
        testing_env!(context(contract_id(), 0, 0).build());
        let mut contract = Contract::new(owner(), server(), treasury(), "wrap.near".parse().unwrap());
        testing_env!(context(accounts(4), 0, pool).build());
        contract.pool_fund();
        contract
    }

    /// A contract with an empty pool: `pool_fund` takes no zero deposit.
    fn bare_contract() -> Contract {
        testing_env!(context(contract_id(), 0, 0).build());
        Contract::new(owner(), server(), treasury(), "wrap.near".parse().unwrap())
    }

    // spec: add-any-chain-feed › Held wNEAR release contract › duplicate release × in flight
    #[test]
    fn held_release_rejects_a_second_call_while_transfer_is_in_flight() {
        let mut contract = funded_contract(MIN_FEED);
        testing_env!(context(contract_id(), 0, 0).build());
        contract.held_total = MIN_FEED;
        contract.next_delivery_id = 1;
        contract.held_refund_release(0, U128(MIN_FEED), treasury()).detach();
        assert!(matches!(contract.held_release_ids.get(&0), Some(HeldRelease::InFlight(value)) if *value == MIN_FEED));
        assert_eq!(contract.held_total, 0);
        let error = panic_text(|| contract.held_refund_release(0, U128(MIN_FEED), treasury()));
        assert!(error.contains("delivery_already_released"));
        assert_eq!(contract.held_total, 0);
    }

    #[test]
    fn new_stores_the_accounts() {
        testing_env!(context(contract_id(), 0, 0).build());
        let contract = Contract::new(owner(), server(), treasury(), "wrap.near".parse().unwrap());
        assert_eq!(contract.owner_id(), owner());
        assert_eq!(contract.version(), "0.1.0");
        assert_eq!(contract.wnear_account_view().as_str(), "wrap.near");
        assert_eq!(contract.hatch_view(player(0)).pool.0, 0);
    }

    // spec: add-any-chain-feed › wNEAR receipt contract › accepted transfer
    #[test]
    fn migration_sets_testnet_wnear_once_without_changing_contract_state() {
        testing_env!(context(contract_id(), 0, 0).build());
        let mut old = Contract::new(owner(), server(), treasury(), "wrap.near".parse().unwrap());
        old.held_total = MIN_FEED;
        env::state_write(&old);
        env::storage_remove(WNEAR_SETTING_KEY);
        let migrated = Contract::migrate_wnear("wrap.testnet".parse().unwrap());
        assert_eq!(migrated.held_total, MIN_FEED);
        assert_eq!(migrated.wnear_account_view().as_str(), "wrap.testnet");
        let error = panic_text(|| Contract::migrate_wnear("wrap.near".parse().unwrap()));
        assert!(error.contains("wnear_already_configured"));
    }

    fn panic_text<T>(work: impl FnOnce() -> T) -> String {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work));
        match result {
            Ok(_) => panic!("the call must fail"),
            Err(error) => error
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| error.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default(),
        }
    }

    /// A state written in the layout before `add-daily-ritual`: a pool, a next id, a pet of
    /// version 1 and an acquaintance kept.
    // spec: add-daily-ritual › Streak contract › сутки засчитаны × the layout migrates
    #[test]
    fn migrate_takes_the_previous_layout_and_keeps_the_pool_the_pet_and_the_acquaintance() {
        let mut contract = funded_contract(7_000_000_000_000_000_000_000_000);
        testing_env!(context(server(), 1_000, 0).build());
        let token_id = contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        let Some(VersionedPet::V7(born)) = contract.pets.get(&token_id).cloned() else {
            panic!("a birth writes version 7");
        };
        contract.known.insert((token_id.clone(), player(7)));
        let old_record = VersionedPet::V1(crate::pet::PetV1 {
            name: born.name.clone(),
            character: born.character.clone(),
            born_at: born.born_at,
            project_food: born.project_food,
            given_food: 5,
            debit_day: born.debit_day,
            debited_today: born.debited_today,
            last_debit_id: born.last_debit_id,
            stage: born.stage,
            stage_day: born.stage_day,
            streak: born.streak,
            freezes: born.freezes,
        });
        contract.pets.insert(token_id.clone(), old_record);
        contract.pets.flush();
        let pool = contract.pool;

        // The layout before this change: the fields of Contract without the work ones. A commit
        // and a reserve are in it, and `migrate` must keep them.
        contract.riddle_reserve = 5_000;
        contract.riddle_commits.insert(20_001, [7u8; 32]);
        contract.riddle_commits.flush();
        let old = ContractV3 {
            owner_id: contract.owner_id,
            server_id: contract.server_id,
            treasury_id: contract.treasury_id,
            tokens: contract.tokens,
            pets: contract.pets,
            hatched: contract.hatched,
            births_day: contract.births_day,
            births_today: contract.births_today,
            next_token_id: contract.next_token_id,
            pool: contract.pool,
            known: contract.known,
            riddle_commits: contract.riddle_commits,
            riddle_reserve: contract.riddle_reserve,
        };
        env::state_write(&old);
        drop(old);

        let migrated = Contract::migrate();
        assert_eq!(migrated.owner_id(), owner());
        assert_eq!(migrated.server_id, server());
        assert_eq!(migrated.treasury_id, treasury());
        assert_eq!(migrated.hatch_view(player(0)).pool.0, pool);
        assert_eq!(migrated.hatch_view(player(0)).owned_count.0, 1);
        assert_eq!(migrated.next_token_id, 1);
        assert_eq!(
            migrated.hatch_view(player(0)).token_id.as_deref(),
            Some("0")
        );
        let view = migrated.pet_view("0".into()).expect("the pet is kept");
        assert_eq!(view.given_food.0, 5);
        assert_eq!(view.friend_snacks, 0);
        assert_eq!(view.friend_snack_day, 0);
        assert_eq!(view.owner_snack_at.0, 0);
        assert!(!migrated.pet_knows("0".into(), player(5)));
        assert!(migrated.pet_knows("0".into(), player(7)), "known is kept");
        assert_eq!(view.last_streak_day, None);
        let riddle = migrated.riddle_view(20_000);
        assert_eq!((riddle.hash, riddle.reserve.0), (None, 5_000));
        assert_eq!(
            migrated.riddle_view(20_001).hash,
            Some(hex(&[7u8; 32])),
            "the commits are kept"
        );
        assert!(migrated.pet_view("0".into()).unwrap().work_known.is_empty());
        assert!(
            !migrated
                .work_pairs
                .contains(&("0".to_string(), "1".to_string()))
        );

        // A second call reads the state migrate itself wrote: the bytes of the riddle fields trail
        // the old layout, so it fails and the pool is never reset.
        env::state_write(&migrated);
        let text = panic_text(Contract::migrate);
        assert!(
            text.contains("Cannot deserialize the contract state"),
            "{text}"
        );
    }

    #[test]
    fn migrate_without_a_state_fails() {
        testing_env!(context(contract_id(), 0, 0).build());
        let text = panic_text(Contract::migrate);
        assert!(text.contains("no_state"), "{text}");
    }

    // One acquaintance costs exactly KNOWN_RECORD_BYTES, whatever the ids' length: the hashed key
    // is 32 bytes, the value is empty, the record carries 40 bytes more.
    #[test]
    fn an_acquaintance_costs_exactly_the_record_bytes() {
        testing_env!(context(contract_id(), 0, 0).build());
        let mut contract = Contract::new(owner(), server(), treasury(), "wrap.near".parse().unwrap());
        let cases: [(String, String); 3] = [
            ("9".repeat(20), "a".repeat(64)),
            ("0".into(), "a.b".into()),
            ("123456".into(), "bob.near".into()),
        ];
        for (token_id, account) in cases {
            let account_id: AccountId = account.parse().unwrap();
            let before = env::storage_usage();
            assert!(
                contract
                    .known
                    .insert((token_id.clone(), account_id.clone()))
            );
            let spent = env::storage_usage() - before;
            assert_eq!(spent, KNOWN_RECORD_BYTES, "{token_id} / {account}");
            assert!(contract.pet_knows(token_id, account_id));
        }
    }

    fn contract_with_pet(pool: u128) -> Contract {
        let mut contract = funded_contract(pool);
        testing_env!(context(server(), 1_000, 0).build());
        contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        contract
    }

    const HUGE_POOL: u128 = 5_000_000_000_000_000_000_000_000;

    // spec: add-feeding › Pet snack contract › четвёртый перекус от друзей за сутки
    #[test]
    fn the_utc_day_resets_the_friends_snacks_at_the_block_timestamp_boundary() {
        let mut contract = contract_with_pet(HUGE_POOL);
        let last_ns = 5 * NS_PER_DAY - 1;
        testing_env!(context(server(), last_ns, 0).build());
        for n in 1..=3 {
            contract.pet_snack("0".into(), player(n), SnackKind::Friend, None);
        }
        let text =
            panic_text(|| contract.pet_snack("0".into(), player(4), SnackKind::Friend, None));
        assert!(text.contains("snacks_today"), "{text}");
        assert_eq!(contract.pet_view("0".into()).unwrap().friend_snacks, 3);

        testing_env!(context(server(), 5 * NS_PER_DAY, 0).build());
        contract.pet_snack("0".into(), player(4), SnackKind::Friend, None);
        let view = contract.pet_view("0".into()).unwrap();
        assert_eq!(
            view.friend_snacks, 1,
            "the counter belongs to the day before"
        );
        assert_eq!(view.friend_snack_day, 5);
    }

    // spec: add-feeding › Pet snack contract › перекус владельцу раньше 72 часов
    #[test]
    fn the_owner_snack_passes_at_exactly_72_hours_and_not_a_nanosecond_before() {
        let mut contract = contract_with_pet(HUGE_POOL);
        let first = 10 * NS_PER_DAY;
        testing_env!(context(server(), first, 0).build());
        contract.pet_snack("0".into(), player(0), SnackKind::Owner, None);
        assert_eq!(
            contract.pet_view("0".into()).unwrap().owner_snack_at.0,
            first
        );

        testing_env!(context(server(), first + OWNER_SNACK_EVERY_NS - 1, 0).build());
        let text = panic_text(|| contract.pet_snack("0".into(), player(0), SnackKind::Owner, None));
        assert!(text.contains("snack_too_soon"), "{text}");
        assert_eq!(
            contract.pet_view("0".into()).unwrap().owner_snack_at.0,
            first
        );

        let again = first + OWNER_SNACK_EVERY_NS;
        testing_env!(context(server(), again, 0).build());
        contract.pet_snack("0".into(), player(0), SnackKind::Owner, None);
        assert_eq!(
            contract.pet_view("0".into()).unwrap().owner_snack_at.0,
            again
        );
    }

    #[test]
    fn the_snack_and_feed_events_carry_the_spec_fields() {
        let mut contract = contract_with_pet(HUGE_POOL);
        testing_env!(context(server(), 2_000, 0).build());
        contract.pet_snack("0".into(), player(0), SnackKind::Owner, None);
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert!(logs[0].contains("\"standard\":\"nearling\""), "{}", logs[0]);
        assert!(logs[0].contains("\"event\":\"snack\""), "{}", logs[0]);
        assert!(logs[0].contains("\"kind\":\"owner\""), "{}", logs[0]);
        assert!(
            !logs[0].contains("friend"),
            "no friend in an owner snack: {}",
            logs[0]
        );

        testing_env!(context(server(), 3_000, 0).build());
        contract.pet_snack("0".into(), player(3), SnackKind::Friend, None);
        let logs = get_logs();
        assert!(logs[0].contains("\"kind\":\"friend\""), "{}", logs[0]);
        assert!(logs[0].contains("player3.near"), "{}", logs[0]);

        testing_env!(context(player(3), 4_000, MIN_FEED).build());
        contract.pet_feed("0".into(), None);
        let logs = get_logs();
        assert!(logs[0].contains("\"event\":\"feed\""), "{}", logs[0]);
        assert!(
            logs[0].contains("\"feeder\":\"player3.near\""),
            "{}",
            logs[0]
        );
        assert!(
            logs[0].contains(&format!("\"amount\":\"{MIN_FEED}\"")),
            "{}",
            logs[0]
        );
    }

    // The UTC day changes on the `block_timestamp` boundary (23:59:59.999999999 -> 00:00).
    #[test]
    fn the_utc_day_changes_at_the_block_timestamp_boundary() {
        let mut contract = funded_contract(1_000_000_000_000_000_000_000_000);
        let last_ns = 5 * NS_PER_DAY - 1;
        testing_env!(context(server(), last_ns, 0).build());
        contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        assert_eq!(contract.hatch_view(player(9)).day, 4);
        assert_eq!(contract.hatch_view(player(9)).born_today, 1);

        testing_env!(context(server(), 5 * NS_PER_DAY, 0).build());
        let view = contract.hatch_view(player(9));
        assert_eq!(view.day, 5);
        assert_eq!(view.born_today, 0, "the counter belongs to the earlier day");
    }

    // spec: add-hatch-again › Repeat pet mint contract › accepted repeat
    #[test]
    fn a_second_mint_passes_after_the_pet_was_given() {
        let mut contract = funded_contract(1_000_000_000_000_000_000_000_000);
        testing_env!(context(server(), 1_000, 0).build());
        let token_id = contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        // `nft_transfer` is not exposed; the standard's internal move is what a gift will do.
        contract
            .tokens
            .internal_transfer_unguarded(&token_id, &player(0), &player(1));
        assert_eq!(contract.tokens.owner_by_id.get(&token_id), Some(player(1)));

        let second = contract.pet_mint(player(0), "Second".into(), "I am calm.".into());
        assert_eq!(second, "1");
        assert_eq!(
            contract.hatch_view(player(0)).token_id.as_deref(),
            Some("1")
        );
        assert_eq!(contract.tokens.owner_by_id.get(&token_id), Some(player(1)));
    }

    // spec: add-hatch-again › Repeat pet mint contract › birth above pool ceiling
    #[test]
    fn birth_pool_ceiling_accepts_exactly_the_cap_and_rejects_one_yocto_more() {
        testing_env!(context(server(), 1_000, 0).build());
        assert_birth_cost(MAX_BIRTH_COST);
        assert!(panic_text(|| assert_birth_cost(MAX_BIRTH_COST + 1)).contains("birth_cost_limit"));
    }

    // spec: add-hatch-again › Repeat pet mint contract › birth above pool ceiling
    #[test]
    fn pet_mint_rejects_an_over_ceiling_birth_before_pool_counters_or_events() {
        let mut contract = funded_contract(1_000_000_000_000_000_000_000_000);
        testing_env!(context(server(), 1_000, 0).build());
        let pool = contract.pool;
        let births = contract.births_today;
        let showcase = contract.pets_hatched;
        let next_token = contract.next_token_id;
        TEST_BIRTH_EXTRA_BYTES.with(|extra| extra.set(3_000));
        let rejected = panic_text(|| contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into()));
        TEST_BIRTH_EXTRA_BYTES.with(|extra| extra.set(0));
        assert!(rejected.contains("birth_cost_limit"));
        assert_eq!(contract.pool, pool);
        assert_eq!(contract.births_today, births);
        assert_eq!(contract.pets_hatched, showcase);
        assert_eq!(contract.next_token_id, next_token);
        assert!(get_logs().iter().all(|log| !log.contains("pet_born") && !log.contains("nft_mint")));
    }

    // spec: add-pet › Hatch view contract › аккаунт рождал питомца (the pet is already given away)
    #[test]
    fn hatch_view_still_gives_the_token_of_a_given_pet() {
        let mut contract = funded_contract(1_000_000_000_000_000_000_000_000);
        testing_env!(context(server(), 1_000, 0).build());
        let token_id = contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        contract
            .tokens
            .internal_transfer_unguarded(&token_id, &player(0), &player(1));
        assert_eq!(
            contract.hatch_view(player(0)).token_id,
            Some(token_id.clone())
        );
        assert_eq!(contract.hatch_view(player(0)).owned_count.0, 0);
        assert_eq!(contract.pet_view(token_id).unwrap().owner_id, player(1));
        assert_eq!(contract.hatch_view(player(1)).token_id, None);
        assert_eq!(contract.hatch_view(player(1)).owned_count.0, 1);
    }

    // The standard's own byte count is what OWNER_LIST_ENTRY_BYTES must cover: the first token of
    // a new owner, a 64-byte account id and a 20-digit token id.
    #[test]
    fn owner_list_entry_bytes_covers_the_measurement() {
        testing_env!(context(contract_id(), 0, 0).build());
        let mut contract = Contract::new(owner(), server(), treasury(), "wrap.near".parse().unwrap());
        let long_owner: AccountId = "a".repeat(64).parse().unwrap();
        let token_id = "9".repeat(20);

        // Warm up the collections (their one-time bytes) with an unrelated pet, so the two
        // measurements below see the same state.
        contract
            .tokens
            .internal_mint_with_refund("0".into(), owner(), None, None);
        let before_row = env::storage_usage();
        contract.tokens.owner_by_id.insert(&token_id, &long_owner);
        let row = env::storage_usage() - before_row;
        contract.tokens.owner_by_id.remove(&token_id);

        let before = env::storage_usage();
        contract
            .tokens
            .internal_mint_with_refund(token_id, long_owner, None, None);
        let whole = env::storage_usage() - before;
        let list_entry = whole - row;
        eprintln!("owner list entry: {list_entry} bytes (row {row})");
        assert!(
            OWNER_LIST_ENTRY_BYTES >= list_entry,
            "OWNER_LIST_ENTRY_BYTES {OWNER_LIST_ENTRY_BYTES} < measured {list_entry}"
        );

        let before_generation = env::storage_usage();
        contract.transfer_generation.insert("9".repeat(20), 1);
        contract.transfer_generation.flush();
        let generation = env::storage_usage() - before_generation;
        assert!(
            TRANSFER_GENERATION_BYTES >= generation,
            "TRANSFER_GENERATION_BYTES {TRANSFER_GENERATION_BYTES} < measured {generation}"
        );
    }

    #[test]
    fn a_birth_emits_nft_mint_and_pet_born_with_the_character_hash() {
        let mut contract = funded_contract(1_000_000_000_000_000_000_000_000);
        testing_env!(context(server(), 1_000, 0).build());
        contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        let logs = get_logs();
        assert_eq!(logs.len(), 2, "{logs:?}");
        assert!(logs[0].contains("\"standard\":\"nep171\"") && logs[0].contains("nft_mint"));
        assert!(logs[1].contains("\"standard\":\"nearling\"") && logs[1].contains("pet_born"));
        let expected = hex(&env::sha256(b"I am curious."));
        assert!(logs[1].contains(&expected), "{}", logs[1]);
        assert!(
            !logs[1].contains("curious"),
            "the character text itself is not in the event"
        );
    }

    #[test]
    fn debit_splits_food_project_first_and_counts_the_day() {
        let mut contract = funded_contract(1_000_000_000_000_000_000_000_000);
        testing_env!(context(server(), 1_000, 0).build());
        let token_id = contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        let mut record = contract.pets.get(&token_id).unwrap().clone();
        record.current_mut().given_food = 3_000_000_000_000_000_000_000;
        contract.pets.insert(token_id.clone(), record);

        let call = crate::events::CallReceipt {
            req_sha256: "a".repeat(64),
            res_sha256: "b".repeat(64),
            signature: "0x".to_string() + &"c".repeat(130),
            sig_kind: crate::events::SigKind::ProviderTee,
            signer: "0x".to_string() + &"d".repeat(40),
            tokens_in: 2300,
            tokens_out: 30,
            tokens_reasoning: 0,
            cut: false,
        };
        let thought = |price: u128| ThoughtReceipt {
            model: "Qwen/Qwen3.8-27B".into(),
            price: U128(price),
            calls: vec![call.clone()],
            worker: None,
            hire: None,
            job_hash: None,
            completed_errand: false,
            debate: None,
        };
        testing_env!(context(server(), 2_000, 0).build());
        // 2.5e21 from the project's 2e21 and 0.5e21 of the given food
        contract.debit_session(
            token_id.clone(),
            1,
            vec![thought(2_500_000_000_000_000_000_000)],
        );
        let view = contract.pet_view(token_id).unwrap();
        assert_eq!(view.project_food.0, 0);
        assert_eq!(view.given_food.0, 2_500_000_000_000_000_000_000);
        assert_eq!(view.debited_today.0, 2_500_000_000_000_000_000_000);
        assert_eq!(view.last_debit_id, 1);
    }

    // spec: add-pet-life › Pet growth contract › второе изменение стадии за сутки × the block_timestamp boundary
    #[test]
    fn a_stage_changes_once_a_utc_day_at_the_block_timestamp_boundary() {
        let mut contract = funded_contract(HUGE_POOL);
        // Born in the last nanosecond of day 4.
        testing_env!(context(server(), 5 * NS_PER_DAY - 1, 0).build());
        contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        assert_eq!(contract.pet_view("0".into()).unwrap().stage_day, 4);

        // The same day, to the last nanosecond: the birth counts.
        testing_env!(context(server(), 5 * NS_PER_DAY - 1, 0).build());
        let text = panic_text(|| contract.pet_grow("0".into(), Stage::Teen, Trait::Clever));
        assert!(text.contains("stage_today"), "{text}");
        let view = contract.pet_view("0".into()).unwrap();
        assert_eq!((view.stage, view.stage_day), (Stage::Baby, 4));
        assert!(view.traits.is_empty());

        // The first nanosecond of day 5 passes.
        testing_env!(context(server(), 5 * NS_PER_DAY, 0).build());
        contract.pet_grow("0".into(), Stage::Teen, Trait::Clever);
        let view = contract.pet_view("0".into()).unwrap();
        assert_eq!((view.stage, view.stage_day), (Stage::Teen, 5));
        assert_eq!(view.traits, vec![Trait::Clever]);

        // The transition counts as the day's change: the adult step waits for day 6.
        testing_env!(context(server(), 6 * NS_PER_DAY - 1, 0).build());
        let text = panic_text(|| contract.pet_grow("0".into(), Stage::Adult, Trait::Clever));
        assert!(text.contains("stage_today"), "{text}");
        testing_env!(context(server(), 6 * NS_PER_DAY, 0).build());
        contract.pet_grow("0".into(), Stage::Adult, Trait::Clever);
        let view = contract.pet_view("0".into()).unwrap();
        assert_eq!(view.stage, Stage::Adult);
        assert_eq!(view.traits, vec![Trait::Clever, Trait::Clever]);
    }

    // The record is fixed-size, so a grown pet's value takes the bytes a newborn's did and the
    // call writes no new byte (the sandbox test `pet_grow.rs` checks the chain's own count).
    #[test]
    fn a_grown_pet_takes_the_same_bytes_as_a_newborn() {
        let mut contract = funded_contract(HUGE_POOL);
        testing_env!(context(server(), NS_PER_DAY, 0).build());
        contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        let size = |contract: &Contract| {
            near_sdk::borsh::to_vec(contract.pets.get("0").unwrap())
                .unwrap()
                .len()
        };
        let newborn = size(&contract);

        testing_env!(context(server(), 2 * NS_PER_DAY, 0).build());
        contract.pet_grow("0".into(), Stage::Teen, Trait::Cozy);
        assert_eq!(size(&contract), newborn, "the teen step");
        testing_env!(context(server(), 3 * NS_PER_DAY, 0).build());
        contract.pet_grow("0".into(), Stage::Adult, Trait::HardWorking);
        assert_eq!(size(&contract), newborn, "the adult step");
    }

    #[test]
    fn the_grow_event_carries_the_token_the_stage_and_the_trait() {
        let mut contract = funded_contract(HUGE_POOL);
        testing_env!(context(server(), NS_PER_DAY, 0).build());
        contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        testing_env!(context(server(), 2 * NS_PER_DAY, 0).build());
        contract.pet_grow("0".into(), Stage::Teen, Trait::HardWorking);
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        let json = logs[0].trim_start_matches("EVENT_JSON:");
        let event: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(json).unwrap();
        assert_eq!(event["standard"], "nearling");
        assert_eq!(event["version"], "1.0.0");
        assert_eq!(event["event"], "grow");
        assert_eq!(event["data"]["token_id"], "0");
        assert_eq!(event["data"]["stage"], "Teen");
        assert_eq!(event["data"]["trait"], "hard_working");
    }

    #[test]
    fn hashes_are_lowercase_hex() {
        assert_eq!(hex(&[0x00, 0xab, 0xff]), "00abff");
        assert_eq!(unhex32(&"00ab".repeat(16)).unwrap()[..2], [0x00, 0xab]);
        assert_eq!(unhex32(&"00AB".repeat(16)), unhex32(&"00ab".repeat(16)));
        assert_eq!(unhex32(&"a".repeat(63)), None);
        assert_eq!(unhex32(&"a".repeat(65)), None);
        assert_eq!(unhex32(&format!("{}g", "a".repeat(63))), None);
        assert_eq!(unhex32(&format!("{}é", "a".repeat(62))), None);
    }

    /// A pet born at `ts` to a new player; returns its token id.
    fn born_at(contract: &mut Contract, ts: u64, n: usize) -> TokenId {
        testing_env!(context(server(), ts, 0).build());
        contract.pet_mint(player(n), "Pixel".into(), "I am curious.".into())
    }

    fn streak_of(contract: &Contract, token_id: &str) -> (u32, u8, Option<u64>) {
        let view = contract.pet_view(token_id.into()).unwrap();
        (view.streak, view.freezes, view.last_streak_day)
    }

    // spec: add-daily-ritual › Streak contract › сутки засчитаны × a first mark and a birth-day mark
    #[test]
    fn the_first_mark_counts_the_birth_day_and_ignores_skipped() {
        let mut contract = funded_contract(HUGE_POOL);
        let born = born_at(&mut contract, 5 * NS_PER_DAY + 1_000, 0);
        assert_eq!(streak_of(&contract, &born), (0, 1, None));

        // The birth day itself counts, with a `skipped` that no gap could hold.
        testing_env!(context(server(), 5 * NS_PER_DAY + 2_000, 0).build());
        contract.streak_mark(born.clone(), 5, 9);
        assert_eq!(streak_of(&contract, &born), (1, 1, Some(5)));
        let logs = get_logs();
        // The streak, then the crown of day 1 (`Earned outfit contract` › «вещь за серию записана»).
        assert_eq!(logs.len(), 2, "{logs:?}");
        let json = logs[0].trim_start_matches("EVENT_JSON:");
        let event: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(json).unwrap();
        assert_eq!(event["standard"], "nearling");
        assert_eq!(event["event"], "streak");
        assert_eq!(
            event["data"],
            near_sdk::serde_json::json!({
                "token_id": "0", "day": 5, "streak": 1, "freezes": 1, "spent": 0
            })
        );

        // A first mark for the day before the birth is outside the window.
        let other = born_at(&mut contract, 5 * NS_PER_DAY + 3_000, 1);
        testing_env!(context(server(), 5 * NS_PER_DAY + 4_000, 0).build());
        let text = panic_text(|| contract.streak_mark(other.clone(), 4, 0));
        assert!(text.contains("bad_day"), "{text}");
        assert_eq!(streak_of(&contract, &other), (0, 1, None));
    }

    // spec: add-daily-ritual › Streak contract › сутки засчитаны × every 7th day
    #[test]
    fn the_seventh_counted_day_earns_a_freeze_and_a_restart_never_does() {
        let mut contract = funded_contract(HUGE_POOL);
        let token = born_at(&mut contract, 10 * NS_PER_DAY, 0);
        for (n, day) in (10..=16u64).enumerate() {
            testing_env!(context(server(), day * NS_PER_DAY + 5, 0).build());
            contract.streak_mark(token.clone(), day, 0);
            let expected_freezes = if n == 6 { 2 } else { 1 };
            assert_eq!(
                streak_of(&contract, &token),
                (n as u32 + 1, expected_freezes, Some(day)),
                "day {day}"
            );
        }
        let data = &get_logs()[0];
        assert!(
            data.contains("\"streak\":7") && data.contains("\"freezes\":2"),
            "{data}"
        );

        // Days 17 and 18 missed; two freezes cover them, the streak goes on to 8, freezes 0.
        testing_env!(context(server(), 19 * NS_PER_DAY, 0).build());
        contract.streak_mark(token.clone(), 19, 0);
        assert_eq!(streak_of(&contract, &token), (8, 0, Some(19)));
        assert!(get_logs()[0].contains("\"spent\":2"));

        // Day 20 done; days 21 and 22 missed with no freeze left: a restart, which is no 7th.
        testing_env!(context(server(), 20 * NS_PER_DAY, 0).build());
        contract.streak_mark(token.clone(), 20, 0);
        testing_env!(context(server(), 23 * NS_PER_DAY, 0).build());
        contract.streak_mark(token.clone(), 23, 0);
        assert_eq!(streak_of(&contract, &token), (1, 0, Some(23)));
    }

    // spec: add-daily-ritual › Streak contract › сутки вне окна × the UTC day boundary
    #[test]
    fn the_window_is_today_and_yesterday_by_the_block_timestamp() {
        let mut contract = funded_contract(HUGE_POOL);
        let a = born_at(&mut contract, 5 * NS_PER_DAY, 0);
        let b = born_at(&mut contract, 5 * NS_PER_DAY, 1);

        // The last nanosecond of day 7: day 6 is yesterday, 5 is too old, 8 is tomorrow.
        testing_env!(context(server(), 8 * NS_PER_DAY - 1, 0).build());
        for day in [5u64, 8] {
            let text = panic_text(|| contract.streak_mark(a.clone(), day, 0));
            assert!(text.contains("bad_day"), "day {day}: {text}");
        }
        assert_eq!(streak_of(&contract, &a), (0, 1, None));
        contract.streak_mark(a.clone(), 6, 0);
        assert_eq!(streak_of(&contract, &a), (1, 1, Some(6)));

        // The first nanosecond of day 8: day 6 is now too old for another pet, 7 is yesterday.
        testing_env!(context(server(), 8 * NS_PER_DAY, 0).build());
        let text = panic_text(|| contract.streak_mark(b.clone(), 6, 0));
        assert!(text.contains("bad_day"), "{text}");
        contract.streak_mark(b.clone(), 7, 0);
        // Day 7 was missed by pet `a`: its freeze covers it.
        contract.streak_mark(a.clone(), 8, 0);
        assert_eq!(streak_of(&contract, &a), (2, 0, Some(8)));
    }

    // spec: add-daily-ritual › Streak contract › второй раз за сутки
    #[test]
    fn a_day_not_after_the_last_counted_one_fails_and_changes_nothing() {
        let mut contract = funded_contract(HUGE_POOL);
        let token = born_at(&mut contract, 5 * NS_PER_DAY, 0);
        testing_env!(context(server(), 6 * NS_PER_DAY, 0).build());
        contract.streak_mark(token.clone(), 6, 0);
        let before = streak_of(&contract, &token);
        // The same day, and the day before it (yesterday, and the birth day).
        for day in [6u64, 5] {
            let text = panic_text(|| contract.streak_mark(token.clone(), day, 0));
            assert!(text.contains("day_marked"), "day {day}: {text}");
        }
        assert_eq!(streak_of(&contract, &token), before);
    }

    // spec: add-daily-ritual › Streak contract › лишние сутки без ритуала × the cap passes, the cap plus one fails
    #[test]
    fn skipped_may_equal_the_gap_and_not_exceed_it() {
        let mut contract = funded_contract(HUGE_POOL);
        let a = born_at(&mut contract, 5 * NS_PER_DAY, 0);
        let b = born_at(&mut contract, 5 * NS_PER_DAY, 1);
        testing_env!(context(server(), 5 * NS_PER_DAY + 9, 0).build());
        contract.streak_mark(a.clone(), 5, 0);
        contract.streak_mark(b.clone(), 5, 0);

        // Last counted 5, day 9: the gap holds days 6, 7, 8 = 3.
        testing_env!(context(server(), 9 * NS_PER_DAY, 0).build());
        let before = streak_of(&contract, &b);
        let text = panic_text(|| contract.streak_mark(b.clone(), 9, 4));
        assert!(text.contains("too_many_skipped"), "{text}");
        assert_eq!(
            streak_of(&contract, &b),
            before,
            "the cap plus one writes nothing"
        );
        contract.streak_mark(a.clone(), 9, 3);
        assert_eq!(streak_of(&contract, &a), (2, 1, Some(9)));
        assert!(get_logs()[0].contains("\"spent\":0"));
    }

    #[test]
    fn a_pet_that_does_not_exist_cannot_be_marked() {
        let mut contract = funded_contract(HUGE_POOL);
        testing_env!(context(server(), 6 * NS_PER_DAY, 0).build());
        let text = panic_text(|| contract.streak_mark("7".into(), 6, 0));
        assert!(text.contains("no_pet"), "{text}");
    }

    // One commit costs exactly RIDDLE_COMMIT_BYTES, whatever the day or the hash.
    // spec: add-daily-ritual › Riddle commit contract › коммит записан × the record's bytes
    #[test]
    fn a_commit_costs_exactly_the_record_bytes() {
        testing_env!(context(contract_id(), 0, 0).build());
        let mut contract = Contract::new(owner(), server(), treasury(), "wrap.near".parse().unwrap());
        for day in [0u64, 20_757, u64::MAX] {
            let before = env::storage_usage();
            contract.riddle_commits.insert(day, [0xff; 32]);
            contract.riddle_commits.flush();
            let spent = env::storage_usage() - before;
            assert_eq!(spent, RIDDLE_COMMIT_BYTES, "day {day}");
        }
        let before = env::storage_usage();
        contract.riddle_commits.remove(&20_757);
        contract.riddle_commits.flush();
        assert_eq!(before - env::storage_usage(), RIDDLE_COMMIT_BYTES);
        assert_eq!(
            Contract::commit_cost(),
            u128::from(RIDDLE_COMMIT_BYTES) * env::storage_byte_cost().as_yoctonear()
        );
    }

    fn fund_riddles(contract: &mut Contract, yocto: u128) {
        testing_env!(context(accounts(4), 0, yocto).build());
        contract.riddle_storage_fund();
    }

    /// sha256 of the borsh bytes of the four, as the Worker writes them.
    fn seal(day: u64, riddle: &str, answers: &[&str], salt: &str) -> String {
        let answers: Vec<String> = answers.iter().map(|a| a.to_string()).collect();
        let bytes =
            near_sdk::borsh::to_vec(&(day, riddle.to_string(), answers, salt.to_string())).unwrap();
        hex(&env::sha256(&bytes))
    }

    #[derive(near_sdk::serde::Deserialize)]
    #[serde(crate = "near_sdk::serde")]
    struct HashFixture {
        day: u64,
        riddle: String,
        answers: Vec<String>,
        salt: String,
        bytes_hex: String,
        hash: String,
    }

    fn hash_fixture() -> HashFixture {
        near_sdk::serde_json::from_str(include_str!("../tests/fixtures/riddle-hash.json")).unwrap()
    }

    // spec: add-daily-ritual › Riddle commit contract › коммит записан × the bytes of the hash
    // The same vector is read by `server/test/riddle-cron.test.ts`.
    #[test]
    fn the_hash_is_sha256_of_the_borsh_bytes_of_the_four() {
        let fixture = hash_fixture();
        let answers: Vec<String> = fixture.answers.clone();
        let bytes =
            near_sdk::borsh::to_vec(&(fixture.day, &fixture.riddle, &answers, &fixture.salt))
                .unwrap();
        assert_eq!(hex(&bytes), fixture.bytes_hex);
        assert_eq!(hex(&env::sha256(&bytes)), fixture.hash);

        // The pieces are the fields of the tuple and nothing joins them: "ab" + "c" is not
        // "a" + "bc".
        assert_ne!(
            seal(1, "ab", &["c"], "s"),
            seal(1, "a", &["bc"], "s"),
            "a joined string would not tell these apart"
        );
        assert_ne!(seal(1, "r", &["a", "b"], "s"), seal(1, "r", &["ab"], "s"));
    }

    // spec: add-daily-ritual › Riddle commit contract › второй коммит за сутки × the UTC day boundary
    #[test]
    fn one_commit_a_utc_day_at_the_block_timestamp_boundary() {
        let mut contract = bare_contract();
        fund_riddles(&mut contract, 5 * Contract::commit_cost());
        let first = "a".repeat(64);
        let second = "b".repeat(64);

        testing_env!(context(server(), 5 * NS_PER_DAY - 1, 0).build());
        contract.riddle_commit(first.clone());
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        let json = logs[0].trim_start_matches("EVENT_JSON:");
        let event: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(json).unwrap();
        assert_eq!(event["standard"], "nearling");
        assert_eq!(event["event"], "riddle_commit");
        assert_eq!(
            event["data"],
            near_sdk::serde_json::json!({ "day": 4, "hash": first })
        );
        let reserve = contract.riddle_view(4).reserve.0;
        assert_eq!(reserve, 4 * Contract::commit_cost());

        let text = panic_text(|| contract.riddle_commit(second.clone()));
        assert!(text.contains("commit_today"), "{text}");
        let view = contract.riddle_view(4);
        assert_eq!(
            view.hash.as_deref(),
            Some(first.as_str()),
            "the first stays"
        );
        assert_eq!(view.reserve.0, reserve, "nothing was taken");

        // The first nanosecond of day 5 is a new day.
        testing_env!(context(server(), 5 * NS_PER_DAY, 0).build());
        contract.riddle_commit(second.clone());
        assert_eq!(
            contract.riddle_view(5).hash.as_deref(),
            Some(second.as_str())
        );
        assert_eq!(
            contract.riddle_view(4).hash.as_deref(),
            Some(first.as_str())
        );
        assert_eq!(
            contract.riddle_view(5).reserve.0,
            3 * Contract::commit_cost()
        );
    }

    // spec: add-daily-ritual › Riddle commit contract › коммит записан × a bad hash
    #[test]
    fn a_hash_of_the_wrong_shape_fails_before_anything_is_written() {
        let mut contract = bare_contract();
        fund_riddles(&mut contract, 5 * Contract::commit_cost());
        testing_env!(context(server(), 5 * NS_PER_DAY, 0).build());
        for bad in [
            String::new(),
            "a".repeat(63),
            "a".repeat(65),
            format!("{}g", "a".repeat(63)),
            format!("0x{}", "a".repeat(62)),
            format!("{}é", "a".repeat(62)),
        ] {
            let text = panic_text(|| contract.riddle_commit(bad.clone()));
            assert!(text.contains("bad_hash"), "{bad:?}: {text}");
        }
        assert_eq!(contract.riddle_view(5).hash, None);
        assert_eq!(
            contract.riddle_view(5).reserve.0,
            5 * Contract::commit_cost()
        );
        // Capitals are hex too; the record keeps the bytes and the view shows lowercase.
        contract.riddle_commit("AB".repeat(32));
        assert_eq!(
            contract.riddle_view(5).hash.as_deref(),
            Some("ab".repeat(32).as_str())
        );
    }

    // spec: add-daily-ritual › Riddle commit contract › запас хранилища пуст
    #[test]
    fn a_reserve_below_the_cost_refuses_the_commit_and_leaves_the_pool_alone() {
        let mut contract = funded_contract(HUGE_POOL);
        let cost = Contract::commit_cost();
        fund_riddles(&mut contract, cost - 1);
        testing_env!(context(server(), 5 * NS_PER_DAY, 0).build());
        let text = panic_text(|| contract.riddle_commit("a".repeat(64)));
        assert!(text.contains("reserve_empty"), "{text}");
        assert_eq!(contract.riddle_view(5).hash, None);
        assert_eq!(contract.riddle_view(5).reserve.0, cost - 1);
        assert_eq!(contract.hatch_view(player(9)).pool.0, HUGE_POOL);

        // Exactly the cost passes and empties the reserve.
        fund_riddles(&mut contract, 1);
        testing_env!(context(server(), 5 * NS_PER_DAY, 0).build());
        contract.riddle_commit("a".repeat(64));
        assert_eq!(contract.riddle_view(5).reserve.0, 0);
    }

    // spec: add-daily-ritual › Riddle reveal contract › раскрытие в сутки загадки × the UTC day boundary
    #[test]
    fn a_reveal_waits_for_the_day_to_end_at_the_block_timestamp_boundary() {
        let mut contract = bare_contract();
        fund_riddles(&mut contract, 2 * Contract::commit_cost());
        let answers = ["a clock", "clock"];
        let hash = seal(4, "What has hands but can't clap?", &answers, "salt-4");
        testing_env!(context(server(), 4 * NS_PER_DAY + 10, 0).build());
        contract.riddle_commit(hash.clone());
        let reserve = contract.riddle_view(4).reserve.0;
        let reveal = |contract: &mut Contract| {
            contract.riddle_reveal(
                4,
                "What has hands but can't clap?".into(),
                answers.iter().map(|a| a.to_string()).collect(),
                "salt-4".into(),
            )
        };

        testing_env!(context(server(), 5 * NS_PER_DAY - 1, 0).build());
        let text = panic_text(|| reveal(&mut contract));
        assert!(text.contains("reveal_too_early"), "{text}");
        assert_eq!(contract.riddle_view(4).hash.as_deref(), Some(hash.as_str()));
        assert_eq!(contract.riddle_view(4).reserve.0, reserve);
        // A day in the future is early too.
        let text = panic_text(|| {
            contract.riddle_reveal(9, "r".into(), vec![], "s".into());
        });
        assert!(text.contains("reveal_too_early"), "{text}");

        testing_env!(context(server(), 5 * NS_PER_DAY, 0).build());
        reveal(&mut contract);
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        let json = logs[0].trim_start_matches("EVENT_JSON:");
        let event: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(json).unwrap();
        assert_eq!(event["event"], "riddle_reveal");
        assert_eq!(
            event["data"],
            near_sdk::serde_json::json!({
                "day": 4,
                "riddle": "What has hands but can't clap?",
                "answers": ["a clock", "clock"],
                "salt": "salt-4",
            })
        );
        let view = contract.riddle_view(4);
        assert_eq!(view.hash, None, "the record is gone");
        assert_eq!(view.reserve.0, reserve + Contract::commit_cost());

        // A second reveal finds no unrevealed commit.
        let text = panic_text(|| reveal(&mut contract));
        assert!(text.contains("no_commit"), "{text}");
        assert_eq!(
            contract.riddle_view(4).reserve.0,
            reserve + Contract::commit_cost()
        );
    }

    // spec: add-daily-ritual › Riddle reveal contract › не сходится с коммитом
    #[test]
    fn a_reveal_that_does_not_hash_to_the_commit_changes_nothing() {
        let mut contract = bare_contract();
        fund_riddles(&mut contract, Contract::commit_cost());
        let fixture = hash_fixture();
        testing_env!(context(server(), fixture.day * NS_PER_DAY, 0).build());
        contract.riddle_commit(fixture.hash.clone());
        let reserve = contract.riddle_view(fixture.day).reserve.0;

        testing_env!(context(server(), (fixture.day + 1) * NS_PER_DAY, 0).build());
        let wrong: [(&str, Vec<String>, &str); 4] = [
            ("Another riddle", fixture.answers.clone(), &fixture.salt),
            (&fixture.riddle, vec!["a clock".into()], &fixture.salt),
            (&fixture.riddle, fixture.answers.clone(), "other salt"),
            (
                &fixture.riddle,
                vec!["clock".into(), "a clock".into(), "une horloge".into()],
                &fixture.salt,
            ),
        ];
        for (riddle, answers, salt) in wrong {
            let text = panic_text(|| {
                contract.riddle_reveal(
                    fixture.day,
                    riddle.to_string(),
                    answers.clone(),
                    salt.to_string(),
                )
            });
            assert!(text.contains("bad_reveal"), "{text}");
        }
        // The right words under another day's name fail too: the day is in the hash.
        let text = panic_text(|| {
            contract.riddle_reveal(
                fixture.day + 1,
                fixture.riddle.clone(),
                fixture.answers.clone(),
                fixture.salt.clone(),
            )
        });
        assert!(
            text.contains("reveal_too_early") || text.contains("no_commit"),
            "{text}"
        );
        assert_eq!(
            contract.riddle_view(fixture.day).hash.as_deref(),
            Some(fixture.hash.as_str()),
            "the commit stays unrevealed"
        );
        assert_eq!(contract.riddle_view(fixture.day).reserve.0, reserve);

        // The real words pass, a day late or years late alike: there is no deadline.
        testing_env!(context(server(), (fixture.day + 700) * NS_PER_DAY, 0).build());
        contract.riddle_reveal(
            fixture.day,
            fixture.riddle.clone(),
            fixture.answers.clone(),
            fixture.salt.clone(),
        );
        assert_eq!(contract.riddle_view(fixture.day).hash, None);
    }

    // spec: add-daily-ritual › Riddle reveal contract › нет нераскрытого коммита
    #[test]
    fn a_day_with_no_commit_cannot_be_revealed() {
        let mut contract = bare_contract();
        testing_env!(context(server(), 9 * NS_PER_DAY, 0).build());
        let text = panic_text(|| contract.riddle_reveal(3, "r".into(), vec![], "s".into()));
        assert!(text.contains("no_commit"), "{text}");
    }

    fn edit_pet(contract: &mut Contract, token_id: &str, edit: impl FnOnce(&mut Pet)) {
        let mut record = contract.pets.get(&token_id.to_string()).unwrap().clone();
        edit(record.current_mut());
        contract.pets.insert(token_id.to_string(), record);
    }

    fn items_of(contract: &Contract, token_id: &str) -> Vec<u8> {
        contract.pet_view(token_id.into()).unwrap().outfits
    }

    // spec: add-wardrobe › Earned outfit contract › раньше срока
    // spec: add-wardrobe › Earned outfit contract › вещь за загадку записана
    #[test]
    fn a_grant_waits_for_the_first_00_utc_after_the_birth_day_by_the_block_timestamp() {
        let mut contract = funded_contract(HUGE_POOL);
        // Born in the last nanosecond of day 4: the next nanosecond is already day 5.
        testing_env!(context(server(), 5 * NS_PER_DAY - 1, 0).build());
        contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());

        // The birth's own nanosecond, and the first one of the birth day.
        for ts in [5 * NS_PER_DAY - 1, 4 * NS_PER_DAY] {
            testing_env!(context(server(), ts, 0).build());
            let text = panic_text(|| contract.outfit_grant("0".into()));
            assert!(text.contains("outfit_too_early"), "{ts}: {text}");
            assert!(items_of(&contract, "0").is_empty());
        }

        // The first nanosecond of the next UTC day passes.
        testing_env!(context(server(), 5 * NS_PER_DAY, 0).build());
        contract.outfit_grant("0".into());
        assert_eq!(items_of(&contract, "0"), vec![THINKING_CAP]);
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert!(logs[0].contains("\"standard\":\"nearling\"") && logs[0].contains("\"outfit\""));
        assert!(logs[0].contains("\"via\":\"riddle\"") && logs[0].contains("\"item\":2"));
        assert!(!logs[0].contains("price"), "{}", logs[0]);

        // The same item is never given twice.
        testing_env!(context(server(), 9 * NS_PER_DAY, 0).build());
        let text = panic_text(|| contract.outfit_grant("0".into()));
        assert!(text.contains("outfit_owned"), "{text}");
    }

    // spec: add-wardrobe › Outfit purchase contract › выше суточного лимита × the cap passes, the next day resets
    #[test]
    fn a_purchase_passes_at_the_daily_cap_and_not_a_yocto_over_and_resets_at_00_utc() {
        let mut contract = funded_contract(HUGE_POOL);
        testing_env!(context(server(), 1_000, 0).build());
        contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        let day = 3;
        edit_pet(&mut contract, "0", |pet| {
            pet.given_food = 1_000_000_000_000_000_000_000_000;
            pet.debit_day = day;
            // The room left in the day is the price minus one yocto.
            pet.debited_today = DAILY_CAP - OUTFIT_PRICE + 1;
        });

        // The last nanosecond of day 3: the cap plus one yocto is refused whole.
        testing_env!(context(server(), 4 * NS_PER_DAY - 1, 0).build());
        let before = contract.pet_view("0".into()).unwrap();
        let text = panic_text(|| contract.outfit_buy("0".into(), 3, None));
        assert!(text.contains("daily_cap"), "{text}");
        let after = contract.pet_view("0".into()).unwrap();
        assert_eq!(after.debited_today.0, before.debited_today.0);
        assert_eq!(after.project_food.0, before.project_food.0);
        assert!(after.outfits.is_empty());

        // With the room equal to the price, the day's total lands exactly on the cap and passes.
        edit_pet(&mut contract, "0", |pet| {
            pet.debited_today = DAILY_CAP - OUTFIT_PRICE;
        });
        testing_env!(context(server(), 4 * NS_PER_DAY - 1, 0).build());
        contract.outfit_buy("0".into(), 3, None);
        let view = contract.pet_view("0".into()).unwrap();
        assert_eq!(view.debited_today.0, DAILY_CAP);
        assert_eq!(view.outfits, vec![3]);
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert!(logs[0].contains("\"via\":\"bought\"") && logs[0].contains("\"item\":3"));
        assert!(
            logs[0].contains("\"price\":\"1660000000000000000000\""),
            "{}",
            logs[0]
        );

        // The same day another item is over the cap; the first nanosecond of day 4 resets it.
        let text = panic_text(|| contract.outfit_buy("0".into(), 4, None));
        assert!(text.contains("daily_cap"), "{text}");
        testing_env!(context(server(), 4 * NS_PER_DAY, 0).build());
        contract.outfit_buy("0".into(), 4, None);
        let view = contract.pet_view("0".into()).unwrap();
        assert_eq!((view.debit_day, view.debited_today.0), (4, OUTFIT_PRICE));
        assert_eq!(view.outfits, vec![3, 4]);
    }

    fn pair_known(contract: &Contract, a: &str, b: &str) -> bool {
        contract.work_pairs.contains(&pair_key(a, b).unwrap())
    }

    // The three prices of a new pair: both pets with no index entry, one with, both with. The
    // first is the bound the pool must hold before a pair is written.
    // spec: add-pet-work › Known pets contract › пул не покрывает знакомство × the pair's bytes
    #[test]
    fn a_pair_costs_the_measured_bytes_and_the_bound_covers_the_worst() {
        let mut contract = funded_contract(HUGE_POOL);
        let byte = env::storage_byte_cost().as_yoctonear();
        let measure = |contract: &mut Contract, a: &str, b: &str| -> u64 {
            let (usage, pool) = (env::storage_usage(), contract.pool);
            assert!(contract.introduce_pair(a, b), "{a}-{b} is a new pair");
            let bytes = env::storage_usage() - usage;
            assert_eq!(
                pool - contract.pool,
                u128::from(bytes) * byte,
                "the pool paid the bytes"
            );
            bytes
        };
        let both_new = measure(&mut contract, "5", "2");
        let one_new = measure(&mut contract, "2", "9");
        let none_new = measure(&mut contract, "5", "9");
        eprintln!("pair bytes: both new {both_new}, one new {one_new}, none new {none_new}");
        assert_eq!((both_new, one_new, none_new), (194, 141, 88));
        assert_eq!(both_new, PAIR_MAX_BYTES, "the bound is the worst pair");
        assert!(pair_known(&contract, "2", "5") && pair_known(&contract, "9", "5"));

        // The ids' length changes no byte: the key is hashed, the index key a `u64`.
        let big = u64::MAX.to_string();
        let widest = measure(&mut contract, &big, "18446744073709551614");
        assert!(widest <= PAIR_MAX_BYTES, "{widest}");

        // The partners come back ascending, whatever the order they were met in.
        assert_eq!(contract.work_index.get(&5).cloned().unwrap(), vec![2, 9]);
        assert_eq!(contract.work_index.get(&2).cloned().unwrap(), vec![5, 9]);
    }

    // spec: add-pet-work › Known pets contract › пул не покрывает знакомство × the pool at the bound
    #[test]
    fn a_pool_below_the_bound_writes_nothing_and_at_the_bound_writes_the_pair() {
        let bound = u128::from(PAIR_MAX_BYTES) * env::storage_byte_cost().as_yoctonear();
        let mut contract = funded_contract(bound - 1);
        let usage = env::storage_usage();
        assert!(!contract.introduce_pair("1", "2"));
        assert_eq!(env::storage_usage(), usage, "no byte written");
        assert_eq!(contract.pool, bound - 1, "the pool is as it was");
        assert!(!pair_known(&contract, "1", "2"));
        assert!(contract.work_index.get(&1).is_none() && contract.work_index.get(&2).is_none());

        // `testing_env!` preserves mock storage; the next fixture is a fresh deployment.
        env::storage_remove(WNEAR_SETTING_KEY);
        let mut contract = funded_contract(bound);
        assert!(contract.introduce_pair("1", "2"));
        assert_eq!(
            contract.pool, 0,
            "a new pair of unindexed pets takes the whole bound"
        );
        // A known pair writes nothing and takes nothing, with the pool empty.
        assert!(!contract.introduce_pair("2", "1"));
        assert_eq!(contract.pool, 0);
    }

    fn receipt(
        price: u128,
        worker: Option<&str>,
        hire: Option<(HireKind, u128)>,
    ) -> ThoughtReceipt {
        ThoughtReceipt {
            model: "Qwen/Qwen3.8-27B".into(),
            price: U128(price),
            calls: vec![crate::events::CallReceipt {
                req_sha256: "a".repeat(64),
                res_sha256: "b".repeat(64),
                signature: "0x00".into(),
                sig_kind: crate::events::SigKind::ProviderTee,
                signer: "0x00".into(),
                tokens_in: 100,
                tokens_out: 10,
                tokens_reasoning: 0,
                cut: false,
            }],
            worker: worker.map(String::from),
            hire: hire.map(|(kind, fee)| crate::events::HireEntry {
                kind,
                skill: false,
                fee: U128(fee),
            }),
            job_hash: None,
            completed_errand: false,
            debate: None,
        }
    }

    /// Pets "0" (the hirer, rich in given food) and "1" (the worker), two owners.
    fn hirer_and_worker() -> Contract {
        let mut contract = funded_contract(HUGE_POOL);
        testing_env!(context(server(), 1_000, 0).build());
        contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        contract.pet_mint(player(1), "Nori".into(), "I am calm.".into());
        edit_pet(&mut contract, "0", |pet| {
            pet.given_food = 1_000_000_000_000_000_000_000_000;
            pet.last_debit_id = 0;
        });
        contract
    }

    const PRICE: u128 = 200_000_000_000_000_000_000;

    // spec: add-pet-work › Hire debit contract › питомец того же владельца × two pets of one owner
    #[test]
    fn two_pets_of_one_owner_never_hire_each_other_and_a_pet_never_hires_itself() {
        let mut contract = hirer_and_worker();
        // The giver's pet now belongs to the hirer's owner.
        contract
            .tokens
            .internal_transfer_unguarded(&"1".to_string(), &player(1), &player(0));
        testing_env!(context(server(), 2_000, 0).build());
        for worker in ["1", "0"] {
            let batch = vec![receipt(
                PRICE,
                Some(worker),
                Some((HireKind::Player, HIRE_FEE_MIN)),
            )];
            let text = panic_text(|| contract.debit_session("0".into(), 1, batch));
            assert!(text.contains("hire:0:same_owner"), "{worker}: {text}");
        }
        let (hirer, worker) = (
            contract.pet_view("0".into()).unwrap(),
            contract.pet_view("1".into()).unwrap(),
        );
        assert_eq!((hirer.last_debit_id, hirer.debited_today.0), (0, 0));
        assert_eq!((worker.given_food.0, worker.jobs_today), (0, 0));
    }

    // spec: add-pet-work › Hire debit contract › одиннадцатая работа за сутки × the block_timestamp boundary
    #[test]
    fn the_eleventh_job_fails_at_the_last_nanosecond_of_the_day_and_the_next_day_passes() {
        let mut contract = hirer_and_worker();
        edit_pet(&mut contract, "1", |pet| {
            pet.job_day = 3;
            pet.jobs_today = MAX_JOBS_PER_DAY;
        });
        let hire = || receipt(PRICE, Some("1"), Some((HireKind::Player, HIRE_FEE_MIN)));

        testing_env!(context(server(), 4 * NS_PER_DAY - 1, 0).build());
        let text = panic_text(|| contract.debit_session("0".into(), 1, vec![hire()]));
        assert!(text.contains("hire:0:jobs"), "{text}");
        let worker = contract.pet_view("1".into()).unwrap();
        assert_eq!(worker.jobs_today, 10, "the day's ten stand");
        assert_eq!(worker.given_food.0, 0, "nothing was paid");

        testing_env!(context(server(), 4 * NS_PER_DAY, 0).build());
        contract.debit_session("0".into(), 1, vec![hire()]);
        let worker = contract.pet_view("1".into()).unwrap();
        assert_eq!(worker.jobs_today, 1, "the counter starts the new day");
        assert_eq!(worker.given_food.0, HIRE_FEE_MIN - PRICE);
    }

    // spec: add-pet-work › Hire debit contract › одиннадцатая работа за сутки × a batch counts its own hires
    #[test]
    fn a_batch_counts_the_hires_it_has_already_made() {
        let mut contract = hirer_and_worker();
        testing_env!(context(server(), 2_000, 0).build());
        let hire = || receipt(PRICE, Some("1"), Some((HireKind::Player, HIRE_FEE_MIN)));
        let eleven = (0..11).map(|_| hire()).collect::<Vec<_>>();
        let text = panic_text(|| contract.debit_session("0".into(), 1, eleven));
        assert!(
            text.contains("hire:10:jobs"),
            "the 11th of one batch: {text}"
        );

        let ten = (0..10).map(|_| hire()).collect::<Vec<_>>();
        contract.debit_session("0".into(), 1, ten);
        let worker = contract.pet_view("1".into()).unwrap();
        assert_eq!(worker.jobs_today, 10);
        assert_eq!(worker.given_food.0, 10 * (HIRE_FEE_MIN - PRICE));
        let text = panic_text(|| contract.debit_session("0".into(), 2, vec![hire()]));
        assert!(text.contains("hire:0:jobs"), "{text}");
    }

    // spec: add-pet-work › Hire debit contract › плата вне коридора × the band's edges
    #[test]
    fn the_fee_passes_at_both_edges_of_the_band_and_not_a_yocto_outside() {
        let mut contract = hirer_and_worker();
        testing_env!(context(server(), 2_000, 0).build());
        for (id, fee, code) in [
            (1, HIRE_FEE_MIN - 1, Some("hire:0:fee_band")),
            (1, HIRE_FEE_MAX + 1, Some("hire:0:fee_band")),
            (1, HIRE_FEE_MIN, None),
            (2, HIRE_FEE_MAX, None),
        ] {
            let batch = vec![receipt(PRICE, Some("1"), Some((HireKind::Player, fee)))];
            match code {
                Some(code) => {
                    let text = panic_text(|| contract.debit_session("0".into(), id, batch));
                    assert!(text.contains(code), "{fee}: {text}");
                }
                None => contract.debit_session("0".into(), id, batch),
            }
        }
        assert_eq!(contract.pet_view("0".into()).unwrap().last_debit_id, 2);
    }

    // spec: add-pet-work › Hire debit contract › ответ дороже платы × the price equal to the fee
    #[test]
    fn an_answer_priced_at_the_fee_is_refused_and_one_yocto_under_passes() {
        let mut contract = hirer_and_worker();
        testing_env!(context(server(), 2_000, 0).build());
        let at = |price| receipt(price, Some("1"), Some((HireKind::Player, HIRE_FEE_MIN)));
        let text = panic_text(|| contract.debit_session("0".into(), 1, vec![at(HIRE_FEE_MIN)]));
        assert!(text.contains("hire:0:answer_over_fee"), "{text}");
        contract.debit_session("0".into(), 1, vec![at(HIRE_FEE_MIN - 1)]);
        assert_eq!(contract.pet_view("1".into()).unwrap().given_food.0, 1);
    }
}
