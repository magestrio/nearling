use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

use crate::pet::{Stage, Trait};

fn is_false(value: &bool) -> bool {
    !*value
}

/// How the signature of a call was produced (`near-ai` › signatures).
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SigKind {
    ProviderTee,
    Gateway,
}

/// One NEAR AI call of a thought, as the receipt records it. Hashes, the signature and the
/// signer only: never the text of the player's line or the pet's answer.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CallReceipt {
    pub req_sha256: String,
    pub res_sha256: String,
    pub signature: String,
    pub sig_kind: SigKind,
    pub signer: String,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub tokens_reasoning: u32,
    /// The call stopped at its `max_tokens` ceiling, or an errand search call was cut when
    /// it asked for a search past its allowance (unsigned, with no tokens).
    pub cut: bool,
}

/// Who asked: a player's advice, or the pet's own decision (`Hire debit contract`).
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HireKind {
    Player,
    Pet,
}

/// The hire a thought's answer was made for: it travels with the answer's receipt, so the
/// contract writes `hire` right after that receipt (ADR-011 › «How a hire finds its receipt»).
/// `skill` is the server's word: the contract does not compare it with the fee (OD-1780).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct HireEntry {
    pub kind: HireKind,
    pub skill: bool,
    pub fee: U128,
}

/// One thought of a debit batch: one receipt, one to four calls, one price. A worker's answer
/// carries the worker's token id, and, when the hire is recorded, its `hire` entry.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ThoughtReceipt {
    pub model: String,
    pub price: U128,
    pub calls: Vec<CallReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hire: Option<HireEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_hash: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub completed_errand: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debate: Option<DebateReceipt>,
}

/// Public settlement context for one debate line. The words and share code stay off chain.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DebateReceipt {
    pub id: String,
    pub line_order: u8,
    pub other_token_id: String,
    pub speaker_transfer_generation: u64,
    pub other_transfer_generation: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct FundingSpend {
    pub index: u8,
    pub kind: crate::shared_job::FundingKind,
    pub amount: U128,
}

/// Whose snack it is (`Pet snack contract`): the owner's own, or a friend's.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SnackKind {
    Owner,
    Friend,
}

/// How an item came to the pet (`Earned outfit contract`, `Outfit purchase contract`).
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutfitVia {
    Streak,
    Riddle,
    Bought,
    PetWish,
}

/// NEP-297 events of the game's own standard.
#[near(event_json(standard = "nearling"))]
pub enum NearlingEvent {
    #[event_version("1.0.0")]
    SharedJobOpen {
        token_id: String,
        job_hash: String,
        allowance: U128,
        state: crate::shared_job::SharedJobState,
    },
    #[event_version("1.0.0")]
    SharedJobStart {
        token_id: String,
        job_hash: String,
        state: crate::shared_job::SharedJobState,
    },
    #[event_version("1.0.0")]
    SharedJobClose {
        token_id: String,
        job_hash: String,
        linked_near_released: U128,
        linked_snack_released: U128,
    },
    #[event_version("1.0.0")]
    SharedJobTransferred {
        token_id: String,
        job_hash: String,
        state: crate::shared_job::SharedJobState,
    },
    #[event_version("1.0.0")]
    PetBorn {
        token_id: String,
        owner_id: AccountId,
        character_sha256: String,
    },

    #[event_version("1.0.0")]
    Receipt {
        token_id: String,
        debit_id: u64,
        model: String,
        price: U128,
        calls: Vec<CallReceipt>,
        /// The token id of the pet whose answer this receipt is; `token_id` stays the payer's.
        #[serde(skip_serializing_if = "Option::is_none")]
        worker: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        job_hash: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        funding: Vec<FundingSpend>,
        #[serde(default, skip_serializing_if = "is_false")]
        completed_errand: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        debate_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        line_order: Option<u8>,
    },

    /// A hire was recorded, right after the receipt of the worker's answer (`Hire debit
    /// contract`): the fee left the hirer's food, `fee − answer_cost` went to the worker's.
    #[event_version("1.0.0")]
    Hire {
        debit_id: u64,
        hirer: String,
        worker: String,
        kind: HireKind,
        skill: bool,
        fee: U128,
        answer_cost: U128,
    },

    /// A meal: the whole deposit went into the pet's given food.
    #[event_version("1.0.0")]
    Feed {
        token_id: String,
        feeder: AccountId,
        amount: U128,
        #[serde(skip_serializing_if = "Option::is_none")]
        job_hash: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        funding_index: Option<u8>,
    },

    /// A snack from the pool into the pet's project food. `friend` only for a friend's snack.
    #[event_version("1.0.0")]
    Snack {
        token_id: String,
        amount: U128,
        kind: SnackKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        friend: Option<AccountId>,
        #[serde(skip_serializing_if = "Option::is_none")]
        job_hash: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        funding_index: Option<u8>,
    },

    /// A pet grew into `stage` and got `trait` (`Pet growth contract`). The Rust field is
    /// `trait_`, the JSON key the spec's `trait`.
    #[event_version("1.0.0")]
    Grow {
        token_id: String,
        stage: Stage,
        #[serde(rename = "trait")]
        trait_: Trait,
    },

    /// One UTC day of a completed ritual was counted (`Streak contract`). `spent` is the freezes
    /// the mark used; on a restart it is the freezes the pet had.
    #[event_version("1.0.0")]
    Streak {
        token_id: String,
        day: u64,
        streak: u32,
        freezes: u8,
        spent: u8,
    },

    /// An item was written into the pet's record (ADR-012). `item` is the catalogue's id; `price`
    /// only for a purchase.
    #[event_version("1.0.0")]
    Outfit {
        token_id: String,
        item: u8,
        via: OutfitVia,
        #[serde(skip_serializing_if = "Option::is_none")]
        price: Option<U128>,
    },

    /// The server sealed the day's riddle (`Riddle commit contract`): the hash only.
    #[event_version("1.0.0")]
    RiddleCommit { day: u64, hash: String },

    /// The riddle of a past day opened with its proof (`Riddle reveal contract`).
    #[event_version("1.0.0")]
    RiddleReveal {
        day: u64,
        riddle: String,
        answers: Vec<String>,
        salt: String,
    },
}

/// The 32 bytes of 64 hex characters, either case; `None` for any other text.
pub fn unhex32(text: &str) -> Option<[u8; 32]> {
    let bytes = text.as_bytes();
    if bytes.len() != 64 {
        return None;
    }
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = (digit(bytes[2 * i])? << 4) | digit(bytes[2 * i + 1])?;
    }
    Some(out)
}

/// Lowercase hex of `bytes`.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}
