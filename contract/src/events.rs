use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

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
    /// The call stopped at its `max_tokens` ceiling.
    pub cut: bool,
}

/// One thought of a debit batch: one receipt, one or two calls, one price.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ThoughtReceipt {
    pub model: String,
    pub price: U128,
    pub calls: Vec<CallReceipt>,
}

/// Whose snack it is (`Pet snack contract`): the owner's own, or a friend's.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SnackKind {
    Owner,
    Friend,
}

/// NEP-297 events of the game's own standard.
#[near(event_json(standard = "nearling"))]
pub enum NearlingEvent {
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
    },

    /// A meal: the whole deposit went into the pet's given food.
    #[event_version("1.0.0")]
    Feed {
        token_id: String,
        feeder: AccountId,
        amount: U128,
    },

    /// A snack from the pool into the pet's project food. `friend` only for a friend's snack.
    #[event_version("1.0.0")]
    Snack {
        token_id: String,
        amount: U128,
        kind: SnackKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        friend: Option<AccountId>,
    },
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
