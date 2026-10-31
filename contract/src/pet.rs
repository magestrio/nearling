use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, near};

/// The pet's life stage. Later changes add the variants (`add-pet-life`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Baby,
}

/// The pet's record, version 1: what `add-pet` wrote. Kept so a pet born on the dev account
/// before `add-feeding` still reads; `VersionedPet::current_mut` turns it into `Pet`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PetV1 {
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

/// The pet's record, version 2 (`add-feeding`): version 1 and the snack counters. Later changes add
/// a variant of `VersionedPet` and migrate the record on read.
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
    /// The UTC day `friend_snacks` belongs to.
    pub friend_snack_day: u64,
    /// Snacks from friends in `friend_snack_day`.
    pub friend_snacks: u8,
    /// When the owner last took a snack, nanoseconds; 0 = never.
    pub owner_snack_at: u64,
}

impl From<PetV1> for Pet {
    fn from(old: PetV1) -> Self {
        Self {
            name: old.name,
            character: old.character,
            born_at: old.born_at,
            project_food: old.project_food,
            given_food: old.given_food,
            debit_day: old.debit_day,
            debited_today: old.debited_today,
            last_debit_id: old.last_debit_id,
            stage: old.stage,
            stage_day: old.stage_day,
            streak: old.streak,
            freezes: old.freezes,
            friend_snack_day: 0,
            friend_snacks: 0,
            owner_snack_at: 0,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VersionedPet {
    V1(PetV1),
    V2(Pet),
}

impl VersionedPet {
    /// The current record, by value; an older version is read with zero counters.
    pub fn current(&self) -> Pet {
        match self {
            VersionedPet::V1(old) => Pet::from(old.clone()),
            VersionedPet::V2(pet) => pet.clone(),
        }
    }

    /// The current record to change; an older version becomes the current one in place, and
    /// the next write stores it as such.
    pub fn current_mut(&mut self) -> &mut Pet {
        if let VersionedPet::V1(old) = self {
            *self = VersionedPet::V2(Pet::from(old.clone()));
        }
        match self {
            VersionedPet::V2(pet) => pet,
            VersionedPet::V1(_) => unreachable!("upgraded above"),
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
    pub friend_snack_day: u64,
    pub friend_snacks: u8,
    pub owner_snack_at: U64,
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
            friend_snack_day: pet.friend_snack_day,
            friend_snacks: pet.friend_snacks,
            owner_snack_at: U64(pet.owner_snack_at),
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

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::borsh;

    fn old_pet() -> PetV1 {
        PetV1 {
            name: "Pixel".into(),
            character: "I am curious.".into(),
            born_at: 7,
            project_food: 2_000,
            given_food: 3_000,
            debit_day: 4,
            debited_today: 5,
            last_debit_id: 6,
            stage: Stage::Baby,
            stage_day: 4,
            streak: 2,
            freezes: 1,
        }
    }

    #[test]
    fn a_v1_record_reads_with_zero_counters() {
        let record = VersionedPet::V1(old_pet());
        let pet = record.current();
        assert_eq!(pet.friend_snack_day, 0);
        assert_eq!(pet.friend_snacks, 0);
        assert_eq!(pet.owner_snack_at, 0);
        assert_eq!(pet.given_food, 3_000);
        assert_eq!(pet.name, "Pixel");
    }

    #[test]
    fn a_write_leaves_v2_with_its_food_intact() {
        let mut record = VersionedPet::V1(old_pet());
        record.current_mut().given_food += 10_000_000;
        record.current_mut().friend_snacks = 2;
        let VersionedPet::V2(pet) = &record else {
            panic!("the record must be V2 after a write");
        };
        assert_eq!(pet.given_food, 10_003_000);
        assert_eq!(pet.project_food, 2_000);
        assert_eq!(pet.friend_snacks, 2);

        // The bytes on chain: V1 is variant 0, V2 variant 1, so a stored V1 record still decodes.
        let stored_v1 = borsh::to_vec(&VersionedPet::V1(old_pet())).unwrap();
        assert_eq!(stored_v1[0], 0);
        let decoded: VersionedPet = borsh::from_slice(&stored_v1).unwrap();
        assert_eq!(decoded, VersionedPet::V1(old_pet()));
        let stored_v2 = borsh::to_vec(&record).unwrap();
        assert_eq!(stored_v2[0], 1);
        assert_eq!(stored_v2.len() - stored_v1.len(), 17);
    }
}
