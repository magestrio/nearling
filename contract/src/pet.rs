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

/// The pet's record, version 3 (`add-pet-life`): version 2 and the traits.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PetV3 {
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

/// The pet's record, version 4 (`add-daily-ritual`): version 3 and the last counted day of the
/// streak.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PetV4 {
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
    /// The UTC day of the last `streak_mark`; 0 = no mark yet. A real day is ~20,700, so 0 is
    /// nobody's day, and the fixed size keeps the first mark from growing the record.
    pub last_streak_day: u64,
}

/// The wardrobe (`Outfit catalogue rule`, PRODUCT.md §8 › Каталог вещей): item ids are the
/// catalogue's order, and the record keeps them as bits of one byte.
pub const DAISY_CROWN: u8 = 0;
pub const COZY_SCARF: u8 = 1;
pub const THINKING_CAP: u8 = 2;
/// The first bought item (Smart glasses); the ids from here to `OUTFITS - 1` are for sale.
pub const FIRST_BOUGHT: u8 = 3;
/// The items of the catalogue.
pub const OUTFITS: u8 = 7;

/// The item a streak of `streak` days earns: 1 → the crown, 3 → the scarf.
pub fn streak_item(streak: u32) -> Option<u8> {
    match streak {
        1 => Some(DAISY_CROWN),
        3 => Some(COZY_SCARF),
        _ => None,
    }
}

/// Whether `item` is one the shop sells (`outfit_buy`).
pub fn is_bought(item: u8) -> bool {
    (FIRST_BOUGHT..OUTFITS).contains(&item)
}

/// The pet's record, version 5 (`add-wardrobe`): version 4 and the items. Later changes add a
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
    /// The UTC day of the last `streak_mark`; 0 = no mark yet. A real day is ~20,700, so 0 is
    /// nobody's day, and the fixed size keeps the first mark from growing the record.
    pub last_streak_day: u64,
    /// The items the pet has: bit `i` is item id `i`. A byte of fixed size, paid at birth, so a
    /// grant or a purchase writes no new byte; no method clears a bit.
    pub outfits: u8,
}

impl Pet {
    /// Whether the pet has the item; false for an id outside the catalogue.
    pub fn has(&self, item: u8) -> bool {
        item < OUTFITS && self.outfits & (1 << item) != 0
    }

    /// Gives the pet the item. The caller has checked the id is in the catalogue.
    pub fn give(&mut self, item: u8) {
        debug_assert!(item < OUTFITS);
        self.outfits |= 1 << item;
    }

    /// The ids of the items the pet has, ascending.
    pub fn item_ids(&self) -> Vec<u8> {
        (0..OUTFITS).filter(|item| self.has(*item)).collect()
    }
}

impl From<PetV4> for Pet {
    fn from(old: PetV4) -> Self {
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
            traits: old.traits,
            last_streak_day: old.last_streak_day,
            outfits: 0,
        }
    }
}

impl From<PetV3> for PetV4 {
    fn from(old: PetV3) -> Self {
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
            traits: old.traits,
            last_streak_day: 0,
        }
    }
}

impl From<PetV2> for PetV3 {
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
    V3(PetV3),
    V4(PetV4),
    V5(Pet),
}

impl VersionedPet {
    /// The current record, by value; an older version is read with zero counters, no traits, no
    /// counted day and no items.
    pub fn current(&self) -> Pet {
        match self {
            VersionedPet::V1(old) => Pet::from(PetV4::from(PetV3::from(PetV2::from(old.clone())))),
            VersionedPet::V2(old) => Pet::from(PetV4::from(PetV3::from(old.clone()))),
            VersionedPet::V3(old) => Pet::from(PetV4::from(old.clone())),
            VersionedPet::V4(old) => Pet::from(old.clone()),
            VersionedPet::V5(pet) => pet.clone(),
        }
    }

    /// The current record to change; an older version becomes the current one in place, and
    /// the next write stores it as such.
    pub fn current_mut(&mut self) -> &mut Pet {
        if !matches!(self, VersionedPet::V5(_)) {
            *self = VersionedPet::V5(self.current());
        }
        match self {
            VersionedPet::V5(pet) => pet,
            VersionedPet::V1(_)
            | VersionedPet::V2(_)
            | VersionedPet::V3(_)
            | VersionedPet::V4(_) => {
                unreachable!("upgraded above")
            }
        }
    }
}

/// What one `streak_mark` does to the streak (ADR-010): `(streak, freezes, spent)` for a mark of
/// `day`, with the pet at `(streak, freezes)` and its last counted day `last` (0 = none).
/// `skipped` is the days between that the server excused. The caller has checked the window and
/// that `skipped` fits the gap.
pub fn next_streak(streak: u32, freezes: u8, last: u64, day: u64, skipped: u32) -> (u32, u8, u8) {
    let (streak, mut freezes, spent) = if last == 0 {
        // The first mark: the days before it are not misses.
        (1, freezes, 0)
    } else {
        let gap = day.saturating_sub(last).saturating_sub(1);
        let missed = gap.saturating_sub(u64::from(skipped));
        if missed <= u64::from(freezes) {
            // `missed` is at most `freezes`, a byte.
            let spent = missed as u8;
            (streak.saturating_add(1), freezes - spent, spent)
        } else {
            (1, 0, freezes)
        }
    };
    if streak % 7 == 0 {
        freezes = freezes.saturating_add(1);
    }
    (streak, freezes, spent)
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
    /// The UTC day of the last counted streak day; `None` before the first mark.
    pub last_streak_day: Option<u64>,
    /// The ids of the items the pet has (`Outfit catalogue rule`), ascending.
    pub outfits: Vec<u8>,
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
            last_streak_day: (pet.last_streak_day != 0).then_some(pet.last_streak_day),
            outfits: pet.item_ids(),
        }
    }
}

/// `metadata.extra` of `nft_token`: the stage, the traits and the items (ids, ascending), built
/// on read from the record.
pub fn token_extra(pet: &Pet) -> String {
    let view = near_sdk::serde_json::json!({
        "stage": pet.stage,
        "traits": pet.traits.iter().filter_map(|c| Trait::from_code(*c)).collect::<Vec<_>>(),
        "outfits": pet.item_ids(),
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

/// What `riddle_view` returns: only what the state already shows.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RiddleView {
    /// The commit of the asked day, 64 lowercase hex characters; `None` when there is none or it
    /// was revealed.
    pub hash: Option<String>,
    /// The storage reserve of the commits, yoctoNEAR.
    pub reserve: U128,
    /// What one commit's storage costs, yoctoNEAR.
    pub commit_cost: U128,
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

    fn v3_pet() -> PetV3 {
        PetV3::from(v2_pet())
    }

    #[test]
    fn a_write_leaves_v5_with_its_food_intact_and_the_stored_variants_still_decode() {
        let mut record = VersionedPet::V1(old_pet());
        record.current_mut().given_food += 10_000_000;
        record.current_mut().friend_snacks = 2;
        let VersionedPet::V5(pet) = &record else {
            panic!("the record must be V5 after a write");
        };
        assert_eq!(pet.given_food, 10_003_000);
        assert_eq!(pet.project_food, 2_000);
        assert_eq!(pet.friend_snacks, 2);
        assert_eq!(pet.traits, [0, 0]);
        assert_eq!(pet.last_streak_day, 0);
        assert_eq!(pet.outfits, 0);

        // The bytes on chain: V1 is variant 0, V2 variant 1, V3 variant 2, V4 variant 3, V5
        // variant 4, so a stored older record still decodes.
        let stored_v1 = borsh::to_vec(&VersionedPet::V1(old_pet())).unwrap();
        assert_eq!(stored_v1[0], 0);
        let decoded: VersionedPet = borsh::from_slice(&stored_v1).unwrap();
        assert_eq!(decoded, VersionedPet::V1(old_pet()));
        let stored_v2 = borsh::to_vec(&VersionedPet::V2(v2_pet())).unwrap();
        assert_eq!(stored_v2[0], 1);
        assert_eq!(stored_v2.len() - stored_v1.len(), 17);
        let decoded: VersionedPet = borsh::from_slice(&stored_v2).unwrap();
        assert_eq!(decoded, VersionedPet::V2(v2_pet()));
        let stored_v3 = borsh::to_vec(&VersionedPet::V3(v3_pet())).unwrap();
        assert_eq!(stored_v3[0], 2);
        assert_eq!(stored_v3.len() - stored_v2.len(), 2);
        let decoded: VersionedPet = borsh::from_slice(&stored_v3).unwrap();
        assert_eq!(decoded, VersionedPet::V3(v3_pet()));
        let v4 = PetV4::from(v3_pet());
        let stored_v4 = borsh::to_vec(&VersionedPet::V4(v4.clone())).unwrap();
        assert_eq!(stored_v4[0], 3);
        assert_eq!(stored_v4.len() - stored_v3.len(), 8);
        let decoded: VersionedPet = borsh::from_slice(&stored_v4).unwrap();
        assert_eq!(decoded, VersionedPet::V4(v4));
        let stored_v5 = borsh::to_vec(&record).unwrap();
        assert_eq!(stored_v5[0], 4);
        assert_eq!(stored_v5.len() - stored_v4.len(), 1);
        let decoded: VersionedPet = borsh::from_slice(&stored_v5).unwrap();
        assert_eq!(decoded, record);
    }

    // spec: add-wardrobe › Earned outfit contract › вещь за серию записана × a V4 record
    #[test]
    fn a_v4_record_reads_with_no_items_and_grows_one_byte_on_its_first_write() {
        let mut v4 = PetV4::from(v3_pet());
        v4.last_streak_day = 20_700;
        v4.streak = 2;
        let record = VersionedPet::V4(v4.clone());
        let pet = record.current();
        assert_eq!(pet.outfits, 0);
        assert!(pet.item_ids().is_empty());
        assert_eq!((pet.streak, pet.last_streak_day), (2, 20_700));
        let view = PetView::new("a.near".parse().unwrap(), &pet);
        assert_eq!(view.outfits, Vec::<u8>::new());

        let before = borsh::to_vec(&record).unwrap().len();
        let mut written = record.clone();
        written.current_mut().give(DAISY_CROWN);
        assert!(matches!(written, VersionedPet::V5(_)));
        assert_eq!(borsh::to_vec(&written).unwrap().len(), before + 1);
        let pet = written.current();
        assert_eq!(pet.name, v4.name);
        assert_eq!(pet.last_streak_day, 20_700);
        assert_eq!(pet.item_ids(), vec![DAISY_CROWN]);
    }

    // The field is a byte of fixed size: a grant or a purchase writes no new byte.
    // spec: add-wardrobe › Earned outfit contract › вещь за загадку записана × no new byte
    #[test]
    fn the_items_take_the_bytes_of_none() {
        let mut record = VersionedPet::V4(PetV4::from(v3_pet()));
        record.current_mut();
        let none = borsh::to_vec(&record).unwrap().len();
        for item in 0..OUTFITS {
            record.current_mut().give(item);
        }
        assert_eq!(record.current().outfits, 0b0111_1111);
        assert_eq!(borsh::to_vec(&record).unwrap().len(), none);
    }

    #[test]
    fn the_catalogue_ids_kinds_and_the_streak_thresholds() {
        assert_eq!(
            [DAISY_CROWN, COZY_SCARF, THINKING_CAP, FIRST_BOUGHT, OUTFITS],
            [0, 1, 2, 3, 7]
        );
        assert_eq!(streak_item(1), Some(DAISY_CROWN));
        assert_eq!(streak_item(3), Some(COZY_SCARF));
        for streak in [0, 2, 4, 7, u32::MAX] {
            assert_eq!(streak_item(streak), None);
        }
        let sold: Vec<u8> = (0..=u8::MAX).filter(|i| is_bought(*i)).collect();
        assert_eq!(
            sold,
            vec![3, 4, 5, 6],
            "ids 0-2 and anything over 6 are not for sale"
        );

        let mut record = VersionedPet::V4(PetV4::from(v3_pet()));
        let pet = record.current_mut();
        assert!(!pet.has(THINKING_CAP) && !pet.has(7) && !pet.has(255));
        pet.give(6);
        pet.give(2);
        pet.give(2);
        assert!(pet.has(2) && pet.has(6) && !pet.has(3));
        assert_eq!(pet.outfits, 0b0100_0100);
        assert_eq!(pet.item_ids(), vec![2, 6], "ascending");
    }

    // spec: add-daily-ritual › Streak contract › сутки засчитаны × a pet of version 3
    #[test]
    fn a_v3_record_reads_with_no_counted_day_and_grows_by_nine_bytes_on_its_first_write() {
        let mut v3 = v3_pet();
        v3.traits = [Trait::Cozy.code(), 0];
        v3.streak = 4;
        v3.freezes = 2;
        let record = VersionedPet::V3(v3.clone());
        let pet = record.current();
        assert_eq!(pet.last_streak_day, 0);
        assert_eq!(pet.traits, [Trait::Cozy.code(), 0]);
        assert_eq!((pet.streak, pet.freezes), (4, 2));
        let view = PetView::new("a.near".parse().unwrap(), &pet);
        assert_eq!(view.last_streak_day, None, "no mark yet reads as none");
        assert_eq!(view.traits, vec![Trait::Cozy]);

        let before = borsh::to_vec(&record).unwrap().len();
        let mut written = record.clone();
        written.current_mut().last_streak_day = 20_700;
        assert!(matches!(written, VersionedPet::V5(_)));
        // The counted day (8) and the items (1).
        assert_eq!(borsh::to_vec(&written).unwrap().len(), before + 9);
        let pet = written.current();
        assert_eq!(pet.name, v3.name);
        assert_eq!(pet.traits, v3.traits);
        let view = PetView::new("a.near".parse().unwrap(), &pet);
        assert_eq!(view.last_streak_day, Some(20_700));
    }

    // The mark is a field of fixed size: the first one writes no new byte.
    #[test]
    fn a_counted_day_takes_the_bytes_of_none() {
        let mut record = VersionedPet::V3(v3_pet());
        record.current_mut();
        let none = borsh::to_vec(&record).unwrap().len();
        record.current_mut().last_streak_day = 20_757;
        assert_eq!(borsh::to_vec(&record).unwrap().len(), none);
    }

    #[derive(near_sdk::serde::Deserialize)]
    #[serde(crate = "near_sdk::serde")]
    struct StreakCase {
        name: String,
        streak: u32,
        freezes: u8,
        last: u64,
        day: u64,
        skipped: u32,
        streak_after: u32,
        freezes_after: u8,
        spent: u8,
    }

    #[derive(near_sdk::serde::Deserialize)]
    #[serde(crate = "near_sdk::serde")]
    struct StreakCases {
        cases: Vec<StreakCase>,
    }

    // spec: add-daily-ritual › Streak contract › сутки засчитаны × next_streak, every branch
    // The same table is read by `server/test/ritual-rules.test.ts`.
    #[test]
    fn next_streak_follows_the_shared_table_of_cases() {
        let table: StreakCases =
            near_sdk::serde_json::from_str(include_str!("../tests/fixtures/streak-cases.json"))
                .unwrap();
        assert!(table.cases.len() >= 12);
        for case in table.cases {
            let got = next_streak(case.streak, case.freezes, case.last, case.day, case.skipped);
            assert_eq!(
                got,
                (case.streak_after, case.freezes_after, case.spent),
                "{}",
                case.name
            );
        }
    }

    // spec: add-daily-ritual › Streak contract › streak restarts × spent is the freezes the pet had
    #[test]
    fn a_break_spends_every_freeze_and_before_minus_spent_is_after() {
        for freezes in 0..=6u8 {
            // Seven missed days with none excused: more than any of these pets can cover.
            let (streak, after, spent) = next_streak(5, freezes, 100, 108, 0);
            assert_eq!(streak, 1);
            assert_eq!(after, 0);
            assert_eq!(spent, freezes);
            assert_eq!(freezes - spent, after);
        }
        // A covered gap: before - spent = after too.
        let (streak, after, spent) = next_streak(5, 4, 100, 103, 0);
        assert_eq!((streak, after, spent), (6, 2, 2));
        // A reset to 1 never lands on a multiple of 7, so it earns no freeze.
        let (streak, after, _) = next_streak(6, 0, 100, 150, 0);
        assert_eq!((streak, after), (1, 0));
    }

    #[test]
    fn a_record_with_its_traits_filled_takes_the_bytes_of_an_empty_one() {
        let mut record = VersionedPet::V2(v2_pet());
        let v2 = borsh::to_vec(&record).unwrap().len();
        // The upgrade to the current record: the traits (2), the counted day (8), the items (1).
        let empty = borsh::to_vec(&{
            record.current_mut();
            record.clone()
        })
        .unwrap()
        .len();
        assert_eq!(empty, v2 + 11);
        record.current_mut().traits = [Trait::Cozy.code(), Trait::HardWorking.code()];
        assert_eq!(borsh::to_vec(&record).unwrap().len(), empty);
        record.current_mut().traits = [0, 0];
        assert_eq!(borsh::to_vec(&record).unwrap().len(), empty);
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
        assert_eq!(
            token_extra(&pet),
            r#"{"stage":"Baby","traits":[],"outfits":[]}"#
        );
        pet.stage = Stage::Adult;
        pet.traits = [Trait::Clever.code(), Trait::Clever.code()];
        pet.give(THINKING_CAP);
        pet.give(DAISY_CROWN);
        assert_eq!(
            token_extra(&pet),
            r#"{"stage":"Adult","traits":["clever","clever"],"outfits":[0,2]}"#
        );
    }
}
