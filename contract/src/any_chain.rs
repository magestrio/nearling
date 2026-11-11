use near_sdk::{near, AccountId};
use near_sdk::borsh;

/// One eligible delivery awaiting confirmation of its wNEAR withdrawal.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct PendingCredit {
    pub token_id: String,
    pub route_id: String,
    pub kind: RouteKind,
    pub amount: u128,
    pub state: CreditState,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum RouteKind {
    Quote,
    PetAddress,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
pub enum CreditState {
    InFlight,
    Failed,
}

/// A release marker remains after success so an event-only delivery cannot be released twice.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub enum HeldRelease {
    InFlight(u128),
    Resolved(u128),
}

/// Hashed u64 key, 17-byte value and NEAR's record overhead; the sandbox test checks the bound.
pub const HELD_RELEASE_RECORD_BYTES: u64 = 96;

/// A fixed upper bound, checked against actual sandbox storage usage before deployment.
pub const PENDING_RECORD_BYTES: u64 = 128;
pub const MAX_PENDING_CREDITS: u32 = 100;

/// Sandbox-measured record sizes with hashed keys and a fixed 32-hex route id.
pub const SWEEP_ACTIVE_RECORD_BYTES: u64 = 125;
pub const SWEEP_SEQUENCE_RECORD_BYTES: u64 = 80;
pub const SWEEP_WINDOW_MS: u64 = 3_600_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SweepChain {
    Base,
    Solana,
}

impl SweepChain {
    pub fn path(self, token_id: &str) -> String {
        let chain = match self {
            Self::Base => "base",
            Self::Solana => "solana",
        };
        format!("{chain}:{token_id}")
    }

    pub fn domain_id(self) -> u64 {
        match self {
            Self::Base => 0,
            Self::Solana => 1,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct ActiveSweep {
    pub route_id: String,
    pub sequence: u64,
    pub expires_at_ms: u64,
    pub signing: bool,
}

#[near(serializers = [json])]
pub struct SweepSignerView {
    pub signer_id: Option<AccountId>,
    pub base_domain_id: u64,
    pub solana_domain_id: u64,
    pub path_format: String,
}

#[near(serializers = [json])]
pub struct SweepOwnerApproval {
    pub public_key: String,
    pub signature: String,
}

/// Borsh field order is the wire format shared with the Worker and browser.
#[near(serializers = [borsh, json])]
pub struct SweepApprovalEnvelope {
    pub contract_id: AccountId,
    pub signer_id: AccountId,
    pub token_id: String,
    pub chain: SweepChain,
    pub path: String,
    pub usdc_contract: String,
    pub amount_base_units: u64,
    pub destination: String,
    pub refund_recipient: String,
    pub route_id: String,
    pub sequence: u64,
    pub expiry_ms: u64,
    pub signing_payload_sha256: [u8; 32],
}

pub fn sweep_approval_hash(envelope: &SweepApprovalEnvelope) -> [u8; 32] {
    let mut bytes = b"nearling:sweep:v1\0".to_vec();
    bytes.extend_from_slice(&borsh::to_vec(envelope).expect("sweep envelope serializes"));
    near_sdk::env::sha256(&bytes).try_into().expect("sha256 is 32 bytes")
}

pub fn route_id_valid(route: &str) -> bool {
    route.len() == 32 && route.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Validate the complete unsigned source message. The Base signer receives its EIP-1559
/// signing hash; the Solana signer receives the exact legacy message bytes.
pub fn checked_sweep_payload(
    chain: SweepChain, payload: &[u8], usdc: &str, amount: u64, destination: &str,
) -> Option<Vec<u8>> {
    match chain {
        SweepChain::Base => checked_base_payload(payload, usdc, amount, destination),
        SweepChain::Solana => checked_solana_payload(payload, usdc, amount, destination),
    }
}

fn hex_bytes(text: &str) -> Option<Vec<u8>> {
    let text = text.strip_prefix("0x").unwrap_or(text);
    if text.len() % 2 != 0 { return None; }
    text.as_bytes().chunks_exact(2).map(|pair| {
        let s = std::str::from_utf8(pair).ok()?;
        u8::from_str_radix(s, 16).ok()
    }).collect()
}

/// Decode one canonical RLP item; the boolean denotes a list.
fn rlp_item(input: &[u8]) -> Option<(bool, &[u8], &[u8])> {
    let first = *input.first()?;
    if first < 0x80 { return Some((false, &input[..1], &input[1..])); }
    let (list, base, short) = if first <= 0xb7 { (false, 0x80, true) }
        else if first <= 0xbf { (false, 0xb7, false) }
        else if first <= 0xf7 { (true, 0xc0, true) }
        else { (true, 0xf7, false) };
    let (header, len) = if short {
        (1usize, usize::from(first - base))
    } else {
        let len_len = usize::from(first - base);
        if len_len == 0 || len_len > 4 || input.len() < 1 + len_len || input[1] == 0 { return None; }
        let mut len = 0usize;
        for byte in &input[1..1 + len_len] { len = len.checked_mul(256)?.checked_add(usize::from(*byte))?; }
        if len < 56 { return None; }
        (1 + len_len, len)
    };
    let end = header.checked_add(len)?;
    if input.len() < end || (!list && short && len == 1 && input[header] < 0x80) { return None; }
    Some((list, &input[header..end], &input[end..]))
}

fn rlp_uint(bytes: &[u8]) -> Option<u64> {
    if bytes.len() > 8 || bytes.first() == Some(&0) { return None; }
    let mut n = 0u64;
    for byte in bytes { n = n.checked_mul(256)?.checked_add(u64::from(*byte))?; }
    Some(n)
}

fn checked_base_payload(payload: &[u8], usdc: &str, amount: u64, destination: &str) -> Option<Vec<u8>> {
    if payload.first() != Some(&2) || payload.len() > 512 { return None; }
    let (list, mut fields, rest) = rlp_item(&payload[1..])?;
    if !list || !rest.is_empty() { return None; }
    let mut items = Vec::with_capacity(9);
    while !fields.is_empty() {
        let (nested, bytes, tail) = rlp_item(fields)?;
        items.push((nested, bytes));
        if items.len() > 9 { return None; }
        fields = tail;
    }
    if items.len() != 9 || items[..8].iter().any(|(list, _)| *list) || !items[8].0 || !items[8].1.is_empty() { return None; }
    if rlp_uint(items[0].1)? != 8453 { return None; }
    // Nonce and gas fields must be canonical unsigned values, with nonzero fee and gas.
    for (index, (_, value)) in items.iter().enumerate().take(5).skip(1) {
        let n = rlp_uint(value)?;
        if index >= 2 && n == 0 { return None; }
    }
    if rlp_uint(items[2].1)? > rlp_uint(items[3].1)? || rlp_uint(items[6].1)? != 0 { return None; }
    if items[5].1 != hex_bytes(usdc)?.as_slice() { return None; }
    let destination = hex_bytes(destination)?;
    if destination.len() != 20 { return None; }
    let data = items[7].1;
    if data.len() != 68 || data[..4] != [0xa9, 0x05, 0x9c, 0xbb]
        || data[4..16] != [0; 12] || data[16..36] != destination
        || data[36..60] != [0; 24] || data[60..68] != amount.to_be_bytes() { return None; }
    Some(near_sdk::env::keccak256(payload))
}

fn base58_key(text: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    for byte in text.bytes() {
        let digit = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
            .iter().position(|value| *value == byte)? as u32;
        let mut carry = digit;
        for item in out.iter_mut().rev() {
            carry += u32::from(*item) * 58;
            *item = carry as u8;
            carry >>= 8;
        }
        if carry != 0 { return None; }
    }
    // Reject aliases with extra leading ones and short encodings of the same key.
    let zeroes = out.iter().take_while(|byte| **byte == 0).count();
    if text.bytes().take_while(|byte| *byte == b'1').count() != zeroes { return None; }
    Some(out)
}

fn shortvec(input: &mut &[u8]) -> Option<usize> {
    let mut value = 0usize;
    for i in 0..3 {
        let byte = *input.first()?;
        *input = &input[1..];
        value |= usize::from(byte & 0x7f) << (7 * i);
        if byte & 0x80 == 0 {
            if i > 0 && byte == 0 { return None; }
            return Some(value);
        }
    }
    None
}

fn take<'a>(input: &mut &'a [u8], len: usize) -> Option<&'a [u8]> {
    if input.len() < len { return None; }
    let (head, tail) = input.split_at(len);
    *input = tail;
    Some(head)
}

fn checked_solana_payload(payload: &[u8], usdc: &str, amount: u64, destination: &str) -> Option<Vec<u8>> {
    if payload.len() > 1232 { return None; }
    let mut bytes = payload;
    let header = take(&mut bytes, 3)?;
    // One fee payer/signing authority, source and destination writable, mint and
    // Token Program read-only. No address lookup or extra signatures.
    if header != [1, 0, 2] { return None; }
    let count = shortvec(&mut bytes)?;
    if count != 5 { return None; }
    let keys = take(&mut bytes, count.checked_mul(32)?)?;
    take(&mut bytes, 32)?; // recent blockhash
    if shortvec(&mut bytes)? != 1 { return None; }
    let program = usize::from(*take(&mut bytes, 1)?.first()?);
    let account_count = shortvec(&mut bytes)?;
    if account_count != 4 { return None; }
    let accounts = take(&mut bytes, 4)?;
    let data_len = shortvec(&mut bytes)?;
    let data = take(&mut bytes, data_len)?;
    if !bytes.is_empty() || data.len() != 10 || data[0] != 12 || data[9] != 6
        || data[1..9] != amount.to_le_bytes() { return None; }
    let key = |index: usize| -> Option<&[u8]> { keys.get(index.checked_mul(32)?..index.checked_add(1)?.checked_mul(32)?) };
    if program != 4 || key(program)? != base58_key("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?
        || accounts[1] != 3 || key(3)? != base58_key(usdc)?
        || ![1, 2].contains(&accounts[0]) || ![1, 2].contains(&accounts[2])
        || accounts[0] == accounts[2] || key(usize::from(accounts[2]))? != base58_key(destination)?
        || accounts[3] != 0 { return None; }
    Some(payload.to_vec())
}
