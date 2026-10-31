use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, near};

/// The pet's life stage. `Teen` and `Adult` are appended, so `Baby` keeps its borsh byte (0).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Baby,
    Teen,
    Adult,
}

impl Stage {
    /// The only stage a pet may grow into; `None` after `Adult`.
    pub fn next(self) -> Option<Stage> {
        match self {
            Stage::Baby => Some(Stage::Teen),
            Stage::Teen => Some(Stage::Adult),
            Stage::Adult => None,
        }
    }
}

/// The five traits (`Trait rule`). JSON only: the record keeps a code, `0` for none, so a grown
/// pet takes the bytes of a newborn (ADR-008).
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Trait {
    Clever,
    Sociable,
    HardWorking,
    Thoughtful,
    Cozy,
}

impl Trait {
    /// The byte the record stores: 1…5.
    pub fn code(self) -> u8 {
        match self {
            Trait::Clever => 1,
            Trait::Sociable => 2,
            Trait::HardWorking => 3,
            Trait::Thoughtful => 4,
            Trait::Cozy => 5,
        }
    }

    /// The trait of a stored byte; `None` for 0 and for a byte nobody writes.
    pub fn from_code(code: u8) -> Option<Trait> {
        match code {
            1 => Some(Trait::Clever),
            2 => Some(Trait::Sociable),
            3 => Some(Trait::HardWorking),
            4 => Some(Trait::Thoughtful),
            5 => Some(Trait::Cozy),
            _ => None,
        }
    }
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

/// The pet's record, version 2 (`add-feeding`): version 1 and the snack counters.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PetV2 {
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

/// The pet's record, version 3 (`add-pet-life`): version 2 and the traits. Later changes add a
/// variant of `VersionedPet` and migrate the record on write.
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
    /// The UTC day of the last stage change, the birth included.
    pub stage_day: u64,
    pub streak: u32,
    pub freezes: u8,
    /// The UTC day `friend_snacks` belongs to.
    pub friend_snack_day: u64,
    /// Snacks from friends in `friend_snack_day`.
    pub friend_snacks: u8,
    /// When the owner last took a snack, nanoseconds; 0 = never.
    pub owner_snack_at: u64,
    /// `Trait::code`s: the teen's trait, then the adult's; 0 = not yet. Fixed size, paid at birth.
    pub traits: [u8; 2],
}

impl From<PetV2> for Pet {
    fn from(old: PetV2) -> Self {
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
            friend_snack_day: old.friend_snack_day,
            friend_snacks: old.friend_snacks,
            owner_snack_at: old.owner_snack_at,
            traits: [0, 0],
        }
    }
}

impl From<PetV1> for PetV2 {
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
    V2(PetV2),
    V3(Pet),
}

impl VersionedPet {
    /// The current record, by value; an older version is read with zero counters and no traits.
    pub fn current(&self) -> Pet {
        match self {
            VersionedPet::V1(old) => Pet::from(PetV2::from(old.clone())),
            VersionedPet::V2(old) => Pet::from(old.clone()),
            VersionedPet::V3(pet) => pet.clone(),
        }
    }

    /// The current record to change; an older version becomes the current one in place, and
    /// the next write stores it as such.
    pub fn current_mut(&mut self) -> &mut Pet {
        if !matches!(self, VersionedPet::V3(_)) {
            *self = VersionedPet::V3(self.current());
        }
        match self {
            VersionedPet::V3(pet) => pet,
            VersionedPet::V1(_) | VersionedPet::V2(_) => unreachable!("upgraded above"),
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
    /// In the order they were gained; a repeat is listed twice.
    pub traits: Vec<Trait>,
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
            traits: pet
                .traits
                .iter()
                .filter_map(|c| Trait::from_code(*c))
                .collect(),
        }
    }
}

/// `metadata.extra` of `nft_token`: the stage and the traits, built on read from the record.
pub fn token_extra(pet: &Pet) -> String {
    let view = near_sdk::serde_json::json!({
        "stage": pet.stage,
        "traits": pet.traits.iter().filter_map(|c| Trait::from_code(*c)).collect::<Vec<_>>(),
    });
    view.to_string()
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

    fn v2_pet() -> PetV2 {
        PetV2::from(old_pet())
    }

    // spec: add-pet-life › Pet growth contract › чужой вызов × a pet of version 2
    #[test]
    fn a_v1_and_a_v2_record_read_with_no_traits_and_zero_counters() {
        let pet = VersionedPet::V1(old_pet()).current();
        assert_eq!(pet.friend_snack_day, 0);
        assert_eq!(pet.friend_snacks, 0);
        assert_eq!(pet.owner_snack_at, 0);
        assert_eq!(pet.traits, [0, 0]);
        assert_eq!(pet.given_food, 3_000);
        assert_eq!(pet.name, "Pixel");

        let mut v2 = v2_pet();
        v2.friend_snacks = 2;
        let pet = VersionedPet::V2(v2).current();
        assert_eq!(pet.traits, [0, 0]);
        assert_eq!(pet.friend_snacks, 2);
        assert_eq!(PetView::new("a.near".parse().unwrap(), &pet).traits, vec![]);
    }

    #[test]
    fn a_write_leaves_v3_with_its_food_intact_and_the_stored_variants_still_decode() {
        let mut record = VersionedPet::V1(old_pet());
        record.current_mut().given_food += 10_000_000;
        record.current_mut().friend_snacks = 2;
        let VersionedPet::V3(pet) = &record else {
            panic!("the record must be V3 after a write");
        };
        assert_eq!(pet.given_food, 10_003_000);
        assert_eq!(pet.project_food, 2_000);
        assert_eq!(pet.friend_snacks, 2);
        assert_eq!(pet.traits, [0, 0]);

        // The bytes on chain: V1 is variant 0, V2 variant 1, V3 variant 2, so a stored V1 or V2
        // record still decodes.
        let stored_v1 = borsh::to_vec(&VersionedPet::V1(old_pet())).unwrap();
        assert_eq!(stored_v1[0], 0);
        let decoded: VersionedPet = borsh::from_slice(&stored_v1).unwrap();
        assert_eq!(decoded, VersionedPet::V1(old_pet()));
        let stored_v2 = borsh::to_vec(&VersionedPet::V2(v2_pet())).unwrap();
        assert_eq!(stored_v2[0], 1);
        assert_eq!(stored_v2.len() - stored_v1.len(), 17);
        let decoded: VersionedPet = borsh::from_slice(&stored_v2).unwrap();
        assert_eq!(decoded, VersionedPet::V2(v2_pet()));
        let stored_v3 = borsh::to_vec(&record).unwrap();
        assert_eq!(stored_v3[0], 2);
        assert_eq!(stored_v3.len() - stored_v2.len(), 2);
    }

    #[test]
    fn a_record_with_its_traits_filled_takes_the_bytes_of_an_empty_one() {
        let mut record = VersionedPet::V2(v2_pet());
        let empty = borsh::to_vec(&record).unwrap().len();
        record.current_mut().traits = [Trait::Cozy.code(), Trait::HardWorking.code()];
        assert_eq!(borsh::to_vec(&record).unwrap().len(), empty + 2);
        let again = borsh::to_vec(&record).unwrap().len();
        record.current_mut().traits = [0, 0];
        assert_eq!(borsh::to_vec(&record).unwrap().len(), again);
    }

    #[test]
    fn stage_and_trait_codes_round_trip_and_baby_keeps_its_byte() {
        assert_eq!(borsh::to_vec(&Stage::Baby).unwrap(), [0]);
        assert_eq!(borsh::to_vec(&Stage::Teen).unwrap(), [1]);
        assert_eq!(borsh::to_vec(&Stage::Adult).unwrap(), [2]);
        assert_eq!(Stage::Baby.next(), Some(Stage::Teen));
        assert_eq!(Stage::Teen.next(), Some(Stage::Adult));
        assert_eq!(Stage::Adult.next(), None);

        let all = [
            Trait::Clever,
            Trait::Sociable,
            Trait::HardWorking,
            Trait::Thoughtful,
            Trait::Cozy,
        ];
        for (n, t) in all.iter().enumerate() {
            assert_eq!(t.code() as usize, n + 1);
            assert_eq!(Trait::from_code(t.code()), Some(*t));
        }
        assert_eq!(Trait::from_code(0), None);
        assert_eq!(Trait::from_code(6), None);
    }

    #[test]
    fn a_trait_is_json_in_snake_case_and_a_stranger_does_not_parse() {
        let words = ["clever", "sociable", "hard_working", "thoughtful", "cozy"];
        for word in words {
            let parsed: Trait = near_sdk::serde_json::from_str(&format!("\"{word}\"")).unwrap();
            assert_eq!(
                near_sdk::serde_json::to_string(&parsed).unwrap(),
                format!("\"{word}\"")
            );
        }
        assert!(near_sdk::serde_json::from_str::<Trait>("\"brave\"").is_err());
        assert!(near_sdk::serde_json::from_str::<Trait>("\"Clever\"").is_err());
    }

    #[test]
    fn the_token_extra_lists_the_stage_and_the_traits_in_order() {
        let mut pet = VersionedPet::V2(v2_pet()).current();
        assert_eq!(token_extra(&pet), r#"{"stage":"Baby","traits":[]}"#);
        pet.stage = Stage::Adult;
        pet.traits = [Trait::Clever.code(), Trait::Clever.code()];
        assert_eq!(
            token_extra(&pet),
            r#"{"stage":"Adult","traits":["clever","clever"]}"#
        );
    }
}
