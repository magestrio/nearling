use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::near;

use crate::events::{DebateReceipt, unhex32};
use crate::limits::MAX_THOUGHT_PRICE;

/// A hashed 32-byte key, 66-byte value and 40-byte trie record overhead.
/// `debate_slot` measures this against sandbox storage usage.
pub const DEBATE_SLOT_BYTES: u64 = 138;
pub const DEBATE_DAILY_CAP: u128 = 10_000_000_000_000_000_000_000;

/// One fixed record per pet, allocated at its first accepted paid debate line.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct DebateSlot {
    pub id: [u8; 32],
    pub occupied_day: u64,
    pub accepted_lines: u8,
    pub used_orders: u8,
    pub debited_today: u128,
    pub last_sequence: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DebateSlotView {
    pub id: String,
    pub occupied_day: u64,
    pub accepted_lines: u8,
    pub used_orders: u8,
}

impl From<&DebateSlot> for DebateSlotView {
    fn from(slot: &DebateSlot) -> Self {
        Self {
            id: slot.id.iter().map(|byte| format!("{byte:02x}")).collect(),
            occupied_day: slot.occupied_day,
            accepted_lines: slot.accepted_lines,
            used_orders: slot.used_orders,
        }
    }
}

/// A debate id holds two u64 sequences, the XOR of the two numeric token ids, and a random u64.
/// The pair tag binds the id to both pets without using another storage record. The whole id is public.
fn sequence_for(id: &[u8; 32], speaker: &TokenId, other: &TokenId) -> u64 {
    let a = speaker
        .parse::<u64>()
        .unwrap_or_else(|_| crate::fail("bad_debate_pet"));
    let b = other
        .parse::<u64>()
        .unwrap_or_else(|_| crate::fail("bad_debate_pet"));
    let pair_tag = u64::from_be_bytes(id[16..24].try_into().unwrap());
    if pair_tag != a ^ b {
        crate::fail("bad_debate_pair");
    }
    let offset = if a < b { 0 } else { 8 };
    u64::from_be_bytes(id[offset..offset + 8].try_into().unwrap())
}

pub fn next_slot(
    old: Option<&DebateSlot>,
    receipt: &DebateReceipt,
    speaker: &TokenId,
    price: u128,
    today: u64,
) -> DebateSlot {
    let id = unhex32(&receipt.id).unwrap_or_else(|| crate::fail("bad_debate_id"));
    let sequence = sequence_for(&id, speaker, &receipt.other_token_id);
    if sequence == 0 {
        crate::fail("bad_debate_sequence");
    }
    let bit = 1u8 << (receipt.line_order - 1);
    let mut slot = match old {
        Some(previous) if previous.id == id => {
            if sequence != previous.last_sequence {
                crate::fail("bad_debate_sequence");
            }
            previous.clone()
        }
        Some(previous) => {
            if previous.occupied_day == today {
                crate::fail("debate_day_occupied");
            }
            if previous.last_sequence.checked_add(1) != Some(sequence) {
                crate::fail("bad_debate_sequence");
            }
            DebateSlot {
                id,
                occupied_day: today,
                accepted_lines: 0,
                used_orders: 0,
                debited_today: 0,
                last_sequence: sequence,
            }
        }
        None => {
            if sequence != 1 {
                crate::fail("bad_debate_sequence");
            }
            DebateSlot {
                id,
                occupied_day: today,
                accepted_lines: 0,
                used_orders: 0,
                debited_today: 0,
                last_sequence: sequence,
            }
        }
    };
    if slot.accepted_lines >= 2 {
        crate::fail("debate_lines_cap");
    }
    if slot.used_orders & bit != 0 {
        crate::fail("debate_order_used");
    }
    if slot.occupied_day != today {
        slot.occupied_day = today;
        slot.debited_today = 0;
    }
    if price > MAX_THOUGHT_PRICE {
        crate::fail("price_over_cap");
    }
    slot.debited_today = slot
        .debited_today
        .checked_add(price)
        .filter(|amount| *amount <= DEBATE_DAILY_CAP)
        .unwrap_or_else(|| crate::fail("debate_daily_cap"));
    slot.accepted_lines += 1;
    slot.used_orders |= bit;
    slot
}
