//! The numbers of the spec (`Pet mint contract`, `Session debit contract`, PRODUCT.md §4).
//!
//! `server/vitest.config.ts` reads `MAX_CHARACTER_BYTES` and `STARTER_FOOD` from this file by
//! name (and, with `add-feeding`, `MIN_FEED` and `SNACK_AMOUNT`), so each stays a plain integer
//! literal on one line.

/// A single thought costs at most 0.005 NEAR.
pub const MAX_THOUGHT_PRICE: u128 = 5_000_000_000_000_000_000_000;

/// A pet is debited at most 0.05 NEAR per UTC day.
pub const DAILY_CAP: u128 = 50_000_000_000_000_000_000_000;

/// The contract gives birth to at most this many pets per UTC day.
pub const BIRTHS_PER_DAY: u32 = 50;

/// A pet's name, in UTF-8 bytes.
pub const MAX_NAME_BYTES: usize = 32;

/// The longest assembly of the character presets: the first number of
/// `openspec/changes/add-pet/presets.md` › Size.
pub const MAX_CHARACTER_BYTES: usize = 568;

/// The starting food of a newborn pet: 12 typical thoughts, 0.0020 NEAR.
pub const STARTER_FOOD: u128 = 2_000_000_000_000_000_000_000;

/// One debit carries 1–12 thoughts (ADR-004 › Batches of at most 12).
pub const MAX_THOUGHTS_PER_DEBIT: usize = 12;

/// A thought has one call, two when the first was re-asked, and up to four for an errand: its search
/// (`gateway`), a data call, the report and the re-ask (`Errand debit contract`).
pub const MAX_CALLS_PER_THOUGHT: usize = 4;

/// Bytes of the owner-list entry a future owner of the pet will need, paid by the pool at birth
/// (ADR-014): the first token of a new owner with a 64-byte account id and a 20-digit token id.
/// The unit test `owner_list_entry_bytes_covers_the_measurement` measures it.
pub const OWNER_LIST_ENTRY_BYTES: u64 = 430;

/// One first-transfer generation entry for a supported 20-digit token id: the `g` prefix,
/// Borsh string length and bytes, u64 value and storage-record overhead.
pub const TRANSFER_GENERATION_BYTES: u64 = 73;

/// An upper bound of a birth's cost in yoctoNEAR for the server's pre-check: the longest
/// character, a 32-byte name, a 64-byte receiver and a 20-digit token id, plus the owner-list
/// entry, first-transfer generation entry and the starter food. `storage_of_a_birth` proves
/// the measured cost stays under it.
pub const MAX_BIRTH_COST: u128 = 23_000_000_000_000_000_000_000;

/// Nanoseconds in a UTC day.
pub const DAY_NS: u64 = 86_400_000_000_000;

/// The smallest feeding deposit: 0.01 NEAR (`Pet feed contract`). No upper bound.
pub const MIN_FEED: u128 = 10_000_000_000_000_000_000_000;

/// What one snack puts into a pet's project food, from the pool: 0.0017 NEAR (PRODUCT.md §8 ›
/// Настройки контракта).
pub const SNACK_AMOUNT: u128 = 1_700_000_000_000_000_000_000;

/// The price of one bought item, the same for the four: 0.00166 NEAR, about 10 typical thoughts
/// (`Outfit purchase contract`). `server/vitest.config.ts` reads it by name, so it stays a plain
/// integer literal on one line.
pub const OUTFIT_PRICE: u128 = 1_660_000_000_000_000_000_000;

/// Snacks from friends one pet takes in a UTC day.
pub const FRIEND_SNACKS_PER_DAY: u8 = 3;

/// The owner's snack comes at most once in 72 hours, in nanoseconds.
pub const OWNER_SNACK_EVERY_NS: u64 = 259_200_000_000_000;

/// Bytes of one acquaintance record: a 32-byte hashed key, no value, plus the 40 bytes every record
/// carries. The unit test `an_acquaintance_costs_exactly_the_record_bytes` measures it.
pub const KNOWN_RECORD_BYTES: u64 = 72;

/// Bytes of one riddle commit: a 1-byte prefix and the 8-byte UTC day as the key, the 32-byte hash
/// as the value, plus the 40 bytes every record carries. Paid from the riddle reserve and given
/// back at the reveal. The unit test `a_commit_costs_exactly_the_record_bytes` measures it.
pub const RIDDLE_COMMIT_BYTES: u64 = 81;

/// The lowest fee of a hire: 0.00083 NEAR, about 5 typical thoughts (`Hire debit contract`, ADR-011
/// › «A band»). `server/vitest.config.ts` reads it by name, so it stays a plain integer literal on
/// one line.
pub const HIRE_FEE_MIN: u128 = 830_000_000_000_000_000_000;

/// The highest fee of a hire: 0.00443 NEAR, the price of a skilled worker's tenth hire of a day
/// (floor + 9 x 0.0004). Read by `server/vitest.config.ts` by name, a plain integer literal.
pub const HIRE_FEE_MAX: u128 = 4_430_000_000_000_000_000_000;

/// The jobs a pet does for others in a UTC day. Read by `server/vitest.config.ts` by name.
pub const MAX_JOBS_PER_DAY: u8 = 10;

/// The most bytes one new pair of pets can write: its record (a 32-byte hashed key plus 40) and the
/// first index entry of each of the two pets (9 key bytes, 12 value bytes, 40). The pool must hold
/// it before the pair is written. The unit test `a_pair_costs_the_measured_bytes` measures it.
pub const PAIR_MAX_BYTES: u64 = 194;

/// Maximum shared-job trie record: 25-byte key (prefix + Borsh 20-digit token id),
/// 388-byte value (three 64-byte account ids), and 40 bytes of trie overhead.
pub const SHARED_JOB_MAX_BYTES: u64 = 453;

/// Hashed map key (32), two u64 counters (16), and trie record overhead (40).
/// The experience sandbox test measures this first-write bound.
pub const EXPERIENCE_COUNT_BYTES: u64 = 88;
