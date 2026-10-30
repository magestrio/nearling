pub mod events;
pub mod limits;
pub mod pet;

use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, NearToken, PanicOnDefault, Promise, env, near};

use crate::events::{NearlingEvent, ThoughtReceipt, hex};
use crate::limits::*;
use crate::pet::{HatchView, Pet, PetView, Stage, VersionedPet};

/// The state of the Init contract (`{ owner_id }`), which `migrate` reads on the dev account.
#[near(serializers = [borsh])]
pub struct InitContract {
    pub owner_id: AccountId,
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
    /// The project's pool: pays the storage and the starter food of every birth.
    pool: u128,
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
        }
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

    /// Takes the Init state `{ owner_id }` into the game's layout; the dev account upgrades
    /// with it (`cargo near deploy … with-init-call migrate`). A second call reads a state
    /// that is no longer Init's and fails, so the pool and the pets are never reset.
    #[init(ignore_state)]
    #[private]
    pub fn migrate(server_id: AccountId, treasury_id: AccountId) -> Self {
        let old: InitContract = env::state_read().unwrap_or_else(|| fail("no_state"));
        Self::fresh(old.owner_id, server_id, treasury_id)
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
            VersionedPet::V1(Pet {
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
        Some(PetView::new(owner_id, record.current()))
    }

    pub fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
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

    #[test]
    fn migrate_takes_the_init_state() {
        testing_env!(context(contract_id(), 0, 0).build());
        env::state_write(&InitContract { owner_id: owner() });
        let contract = Contract::migrate(server(), treasury());
        assert_eq!(contract.owner_id(), owner());
        assert_eq!(contract.hatch_view(player(0)).pool.0, 0);
        assert_eq!(contract.hatch_view(player(0)).born_today, 0);
        assert_eq!(contract.next_token_id, 0);
    }

    #[test]
    #[should_panic(expected = "no_state")]
    fn migrate_without_a_state_fails() {
        testing_env!(context(contract_id(), 0, 0).build());
        let _ = Contract::migrate(server(), treasury());
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

    #[test]
    fn hashes_are_lowercase_hex() {
        assert_eq!(hex(&[0x00, 0xab, 0xff]), "00abff");
    }
}
