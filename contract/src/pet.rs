use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

/// The pet's life stage. Later changes add the variants (`add-pet-life`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Baby,
}

/// The pet's record, version 1: what `pet_mint` writes and `debit_session` changes
/// (design.md › Решения › «Поля записи `Pet`»). Later changes add a variant of `VersionedPet`
/// and migrate the record on read.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pet {
    pub name: String,
    pub character: String,
    /// Birth time, nanoseconds.
    pub born_at: u64,
    pub project_food: u128,
    pub given_food: u128,
    /// The UTC day `debited_today` belongs to.
    pub debit_day: u64,
    pub debited_today: u128,
    /// The last accepted `debit_id`; 0 at birth.
    pub last_debit_id: u64,
    pub stage: Stage,
    pub stage_day: u64,
    pub streak: u32,
    pub freezes: u8,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VersionedPet {
    V1(Pet),
}

impl VersionedPet {
    /// The current record; an older version is migrated here when one exists.
    pub fn current(&self) -> &Pet {
        match self {
            VersionedPet::V1(pet) => pet,
        }
    }

    pub fn current_mut(&mut self) -> &mut Pet {
        match self {
            VersionedPet::V1(pet) => pet,
        }
    }
}

/// What `pet_view` returns: the record and the owner, amounts as decimal strings.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PetView {
    pub owner_id: AccountId,
    pub name: String,
    pub character: String,
    pub born_at: u64,
    pub project_food: U128,
    pub given_food: U128,
    pub debit_day: u64,
    pub debited_today: U128,
    pub last_debit_id: u64,
    pub stage: Stage,
    pub stage_day: u64,
    pub streak: u32,
    pub freezes: u8,
}

impl PetView {
    pub fn new(owner_id: AccountId, pet: &Pet) -> Self {
        Self {
            owner_id,
            name: pet.name.clone(),
            character: pet.character.clone(),
            born_at: pet.born_at,
            project_food: U128(pet.project_food),
            given_food: U128(pet.given_food),
            debit_day: pet.debit_day,
            debited_today: U128(pet.debited_today),
            last_debit_id: pet.last_debit_id,
            stage: pet.stage,
            stage_day: pet.stage_day,
            streak: pet.streak,
            freezes: pet.freezes,
        }
    }
}

/// What `hatch_view` returns.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct HatchView {
    /// The pet born to this account, also after it was given away.
    pub token_id: Option<String>,
    /// The current UTC day (`block_timestamp` / 86,400 s).
    pub day: u64,
    /// Births in the current UTC day; 0 when the counter belongs to an earlier day.
    pub born_today: u32,
    pub pool: U128,
}
