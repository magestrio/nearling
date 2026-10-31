pub mod events;
pub mod limits;
pub mod pet;

use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::TokenMetadata;
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::store::key::Sha256;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{AccountId, NearToken, PanicOnDefault, Promise, env, near};

use crate::events::{NearlingEvent, SnackKind, ThoughtReceipt, hex};
use crate::limits::*;
use crate::pet::{HatchView, Pet, PetView, Stage, Trait, VersionedPet, token_extra};

/// The state layout of `add-pet`, which `migrate` reads on the dev account: the same prefixes as
/// `Contract`, without `known`.
#[near(serializers = [borsh])]
pub struct ContractV1 {
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
    /// Account → the token it gave birth to, also after the pet was given away.
    hatched: LookupMap<AccountId, TokenId>,
    births_day: u64,
    births_today: u32,
    next_token_id: u64,
    /// The project's pool: pays the storage and the starter food of every birth, and the snacks.
    pool: u128,
    /// The feeders a pet knows. The hashed key makes every record `KNOWN_RECORD_BYTES`, whatever
    /// the ids' length, so the pool can check its price before it writes.
    known: LookupSet<(TokenId, AccountId), Sha256>,
}

fn fail(code: &str) -> ! {
    env::panic_str(code)
}

fn day_of(timestamp_ns: u64) -> u64 {
    timestamp_ns / DAY_NS
}

impl Contract {
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
            treasury_id,
            tokens,
            pets: LookupMap::new(b"p".to_vec()),
            hatched: LookupMap::new(b"h".to_vec()),
            births_day: 0,
            births_today: 0,
            next_token_id: 0,
            pool: 0,
            known: LookupSet::with_hasher(b"k".to_vec()),
        }
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

    fn assert_server(&self) {
        if env::predecessor_account_id() != self.server_id {
            fail("not_server");
        }
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
    /// For a fresh account (prod at R1; a new dev account).
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, server_id: AccountId, treasury_id: AccountId) -> Self {
        Self::fresh(owner_id, server_id, treasury_id)
    }

    /// Takes the layout of `add-pet` into this one: adds `known`; the pool, the pets and the
    /// counters stay as they were. The dev account upgrades with it
    /// (`cargo near deploy … with-init-call migrate`). A second call meets a state with the bytes
    /// of `known` after the old layout and fails, so the pool is never reset.
    #[init(ignore_state)]
    #[private]
    pub fn migrate() -> Self {
        let old: ContractV1 = env::state_read().unwrap_or_else(|| fail("no_state"));
        Self {
            owner_id: old.owner_id,
            server_id: old.server_id,
            treasury_id: old.treasury_id,
            tokens: old.tokens,
            pets: old.pets,
            hatched: old.hatched,
            births_day: old.births_day,
            births_today: old.births_today,
            next_token_id: old.next_token_id,
            pool: old.pool,
            known: LookupSet::with_hasher(b"k".to_vec()),
        }
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
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

    /// Server only, no deposit. The pool pays the storage and the starter food.
    pub fn pet_mint(&mut self, receiver: AccountId, name: String, character: String) -> TokenId {
        self.assert_server();
        if self.hatched.contains_key(&receiver) {
            fail("already_hatched");
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
            VersionedPet::V3(Pet {
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
            }),
        );
        self.hatched.insert(receiver.clone(), token_id.clone());
        self.pets.flush();
        self.hatched.flush();

        // The storage the birth wrote, plus the owner-list entry the pet's next owner will need
        // (ADR-014), at the byte price, plus the starter food. All of it comes out of the pool.
        let bytes = env::storage_usage().saturating_sub(storage_before) + OWNER_LIST_ENTRY_BYTES;
        let cost = u128::from(bytes)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .and_then(|storage| storage.checked_add(STARTER_FOOD))
            .unwrap_or_else(|| fail("overflow"));
        if self.pool < cost {
            fail("pool_empty");
        }
        self.pool -= cost;
        self.births_day = day;
        self.births_today = born_today + 1;
        self.next_token_id += 1;

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

        let mut sum: u128 = 0;
        for thought in &thoughts {
            if thought.calls.is_empty() || thought.calls.len() > MAX_CALLS_PER_THOUGHT {
                fail("bad_calls");
            }
            if thought.price.0 > MAX_THOUGHT_PRICE {
                fail("price_over_cap");
            }
            sum = sum
                .checked_add(thought.price.0)
                .unwrap_or_else(|| fail("overflow"));
        }

        let day = day_of(env::block_timestamp());
        let debited_today = if pet.debit_day == day {
            pet.debited_today
        } else {
            0
        };
        let debited_today = debited_today
            .checked_add(sum)
            .filter(|d| *d <= DAILY_CAP)
            .unwrap_or_else(|| fail("daily_cap"));
        let food = pet
            .project_food
            .checked_add(pet.given_food)
            .unwrap_or_else(|| fail("overflow"));
        if sum > food {
            fail("over_food");
        }

        // The project's food first, then the given one.
        let from_project = sum.min(pet.project_food);
        pet.project_food -= from_project;
        pet.given_food -= sum - from_project;
        pet.debit_day = day;
        pet.debited_today = debited_today;
        pet.last_debit_id = debit_id;
        self.pets.insert(token_id.clone(), record);

        for thought in thoughts {
            NearlingEvent::Receipt {
                token_id: token_id.clone(),
                debit_id,
                model: thought.model,
                price: thought.price,
                calls: thought.calls,
            }
            .emit();
        }
        Promise::new(self.treasury_id.clone())
            .transfer(NearToken::from_yoctonear(sum))
            .detach();
    }

    /// Anyone, with at least `MIN_FEED` attached; the whole deposit becomes the pet's given food.
    /// Works for an asleep pet and at the daily cap. A feeder who is not the owner and is new to
    /// the pet becomes known when the pool covers the record. Returns whether a record was written.
    #[payable]
    pub fn pet_feed(&mut self, token_id: TokenId) -> bool {
        let deposit = env::attached_deposit().as_yoctonear();
        if deposit < MIN_FEED {
            fail("feed_too_small");
        }
        let mut record = self
            .pets
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| fail("no_pet"));
        let pet = record.current_mut();
        pet.given_food = pet
            .given_food
            .checked_add(deposit)
            .unwrap_or_else(|| fail("overflow"));
        self.pets.insert(token_id.clone(), record);

        let feeder = env::predecessor_account_id();
        let is_owner = self.tokens.owner_by_id.get(&token_id).as_ref() == Some(&feeder);
        let introduced = !is_owner && self.introduce(&token_id, &feeder, 0);

        NearlingEvent::Feed {
            token_id,
            feeder,
            amount: U128(deposit),
        }
        .emit();
        introduced
    }

    /// Server only, no deposit. A snack from the pool into the pet's project food: from a friend,
    /// at most `FRIEND_SNACKS_PER_DAY` a UTC day; to the owner, at most once in 72 hours, and only
    /// when `feeder` is the current owner. A friend new to the pet becomes known when the pool
    /// covers the record on top of the snack. Returns whether a record was written.
    pub fn pet_snack(&mut self, token_id: TokenId, feeder: AccountId, kind: SnackKind) -> bool {
        self.assert_server();
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
        self.pets.insert(token_id.clone(), record);

        let introduced =
            kind == SnackKind::Friend && self.introduce(&token_id, &feeder, SNACK_AMOUNT);
        self.pool -= SNACK_AMOUNT;

        NearlingEvent::Snack {
            token_id,
            amount: U128(SNACK_AMOUNT),
            kind,
            friend: (kind == SnackKind::Friend).then_some(feeder),
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
        self.pets.insert(token_id.clone(), record);

        NearlingEvent::Grow {
            token_id,
            stage,
            trait_: r#trait,
        }
        .emit();
    }

    pub fn hatch_view(&self, account_id: AccountId) -> HatchView {
        HatchView {
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
        Some(PetView::new(owner_id, &record.current()))
    }

    /// Whether the pet knows the account: a record `pet_feed` or `pet_snack` wrote. False for a
    /// feeder the pool did not cover and for a token that does not exist.
    pub fn pet_knows(&self, token_id: TokenId, account_id: AccountId) -> bool {
        self.known.contains(&(token_id, account_id))
    }

    /// The standard's token; `metadata.extra` holds the pet's stage and traits as JSON, built here
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
        let mut contract = Contract::new(owner(), server(), treasury());
        testing_env!(context(accounts(4), 0, pool).build());
        contract.pool_fund();
        contract
    }

    #[test]
    fn new_stores_the_accounts() {
        testing_env!(context(contract_id(), 0, 0).build());
        let contract = Contract::new(owner(), server(), treasury());
        assert_eq!(contract.owner_id(), owner());
        assert_eq!(contract.version(), "0.1.0");
        assert_eq!(contract.hatch_view(player(0)).pool.0, 0);
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

    /// A state written in the layout of `add-pet`: a pool, a next id and a pet of version 1 kept.
    #[test]
    fn migrate_takes_the_add_pet_layout_and_keeps_the_pool_and_the_pet() {
        let mut contract = funded_contract(7_000_000_000_000_000_000_000_000);
        testing_env!(context(server(), 1_000, 0).build());
        let token_id = contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        let Some(VersionedPet::V3(born)) = contract.pets.get(&token_id).cloned() else {
            panic!("a birth writes version 3");
        };
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

        // The layout `add-pet` wrote: the fields of Contract without `known`.
        let old = ContractV1 {
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
        };
        env::state_write(&old);
        drop(old);

        let migrated = Contract::migrate();
        assert_eq!(migrated.owner_id(), owner());
        assert_eq!(migrated.server_id, server());
        assert_eq!(migrated.treasury_id, treasury());
        assert_eq!(migrated.hatch_view(player(0)).pool.0, pool);
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

        // A second call reads the state migrate itself wrote: the bytes of `known` trail the old
        // layout, so it fails and the pool is never reset.
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
        let mut contract = Contract::new(owner(), server(), treasury());
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
            contract.pet_snack("0".into(), player(n), SnackKind::Friend);
        }
        let text = panic_text(|| contract.pet_snack("0".into(), player(4), SnackKind::Friend));
        assert!(text.contains("snacks_today"), "{text}");
        assert_eq!(contract.pet_view("0".into()).unwrap().friend_snacks, 3);

        testing_env!(context(server(), 5 * NS_PER_DAY, 0).build());
        contract.pet_snack("0".into(), player(4), SnackKind::Friend);
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
        contract.pet_snack("0".into(), player(0), SnackKind::Owner);
        assert_eq!(
            contract.pet_view("0".into()).unwrap().owner_snack_at.0,
            first
        );

        testing_env!(context(server(), first + OWNER_SNACK_EVERY_NS - 1, 0).build());
        let text = panic_text(|| contract.pet_snack("0".into(), player(0), SnackKind::Owner));
        assert!(text.contains("snack_too_soon"), "{text}");
        assert_eq!(
            contract.pet_view("0".into()).unwrap().owner_snack_at.0,
            first
        );

        let again = first + OWNER_SNACK_EVERY_NS;
        testing_env!(context(server(), again, 0).build());
        contract.pet_snack("0".into(), player(0), SnackKind::Owner);
        assert_eq!(
            contract.pet_view("0".into()).unwrap().owner_snack_at.0,
            again
        );
    }

    #[test]
    fn the_snack_and_feed_events_carry_the_spec_fields() {
        let mut contract = contract_with_pet(HUGE_POOL);
        testing_env!(context(server(), 2_000, 0).build());
        contract.pet_snack("0".into(), player(0), SnackKind::Owner);
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
        contract.pet_snack("0".into(), player(3), SnackKind::Friend);
        let logs = get_logs();
        assert!(logs[0].contains("\"kind\":\"friend\""), "{}", logs[0]);
        assert!(logs[0].contains("player3.near"), "{}", logs[0]);

        testing_env!(context(player(3), 4_000, MIN_FEED).build());
        contract.pet_feed("0".into());
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

    // spec: add-pet › Pet mint contract › второй рождённый питомец
    #[test]
    fn a_second_mint_fails_even_after_the_pet_was_given() {
        let mut contract = funded_contract(1_000_000_000_000_000_000_000_000);
        testing_env!(context(server(), 1_000, 0).build());
        let token_id = contract.pet_mint(player(0), "Pixel".into(), "I am curious.".into());
        // `nft_transfer` is not exposed; the standard's internal move is what a gift will do.
        contract
            .tokens
            .internal_transfer_unguarded(&token_id, &player(0), &player(1));
        assert_eq!(contract.tokens.owner_by_id.get(&token_id), Some(player(1)));

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.pet_mint(player(0), "Second".into(), "I am calm.".into())
        }));
        let error = result.expect_err("the second mint must fail");
        let text = error.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(text.contains("already_hatched"), "{text}");
        assert_eq!(
            contract.hatch_view(player(0)).token_id.as_deref(),
            Some("0")
        );
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
        assert_eq!(contract.pet_view(token_id).unwrap().owner_id, player(1));
        assert_eq!(contract.hatch_view(player(1)).token_id, None);
    }

    // The standard's own byte count is what OWNER_LIST_ENTRY_BYTES must cover: the first token of
    // a new owner, a 64-byte account id and a 20-digit token id.
    #[test]
    fn owner_list_entry_bytes_covers_the_measurement() {
        testing_env!(context(contract_id(), 0, 0).build());
        let mut contract = Contract::new(owner(), server(), treasury());
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
    }
}
