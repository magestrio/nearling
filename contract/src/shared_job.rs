use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

/// One contribution is kept until the linked debit attributes its actual spend.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct SharedFunding {
    pub feeder: AccountId,
    pub kind: FundingKind,
    pub amount: u128,
    pub spent: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FundingKind {
    Near,
    Snack,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SharedJobState {
    Funding,
    Running,
    Transferred,
    Settled,
}

/// At most one record per pet and at most three entries, because the 0.005 NEAR allowance
/// accepts at most three 0.0017 NEAR snacks (and a meal is at least 0.01 NEAR).
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct SharedJob {
    pub hash: [u8; 32],
    pub allowance: u128,
    pub state: SharedJobState,
    pub linked_near: u128,
    pub linked_snack: u128,
    pub funding: Vec<SharedFunding>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SharedJobView {
    pub hash: String,
    pub state: SharedJobState,
    pub allowance: U128,
    pub linked_near: U128,
    pub linked_snack: U128,
}

/// The implicit owner's raw Ed25519 key and signature, both lowercase hex.
/// The signed bytes are the SHA-256 of `close_intent_message`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OwnerCloseApproval {
    pub public_key: String,
    pub signature: String,
}

pub fn close_intent_message(contract: &str, token_id: &str, hash: &[u8; 32]) -> String {
    format!(
        "nearling:shared-job-close:v1:{contract}:{token_id}:{}:close",
        crate::events::hex(hash)
    )
}
