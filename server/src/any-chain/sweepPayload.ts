import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { baseDecode, baseEncode } from 'near-api-js';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const text = new TextEncoder();

export function bytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}

function key(address: string): Uint8Array {
  const decoded = baseDecode(address);
  if (decoded.length !== 32) throw new Error('invalid_solana_key');
  return decoded;
}

/** Solana's associated-token-account PDA for a wallet and a mint. */
export function associatedTokenAccount(wallet: string, mint = SOLANA_USDC): string {
  const program = key(ASSOCIATED_TOKEN_PROGRAM);
  const seeds = concat(key(wallet), key(TOKEN_PROGRAM), key(mint));
  for (let bump = 255; bump >= 0; bump -= 1) {
    const address = sha256(concat(seeds, Uint8Array.of(bump), program, text.encode('ProgramDerivedAddress')));
    try { ed25519.Point.fromBytes(address); } catch { return baseEncode(address); }
  }
  throw new Error('solana_pda_unavailable');
}

/** The exact five-key legacy message that `checked_solana_payload` accepts. */
export function solanaSweepMessage(wallet: string, destinationTokenAccount: string, recentBlockhash: string,
  amount: bigint): Uint8Array {
  if (amount <= 0n || amount > 1_000_000n) throw new Error('sweep_amount_limit');
  const units = new Uint8Array(8);
  new DataView(units.buffer).setBigUint64(0, amount, true);
  return concat(Uint8Array.of(1, 0, 2, 5), key(wallet), key(associatedTokenAccount(wallet)),
    key(destinationTokenAccount), key(SOLANA_USDC), key(TOKEN_PROGRAM), key(recentBlockhash),
    Uint8Array.of(1, 4, 4, 1, 3, 2, 0, 10, 12), units, Uint8Array.of(6));
}

function hexBytes(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error('invalid_hex');
  return Uint8Array.from(value.slice(2).match(/../g)!, (pair) => parseInt(pair, 16));
}

function unsigned(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('negative_integer');
  if (value === 0n) return new Uint8Array();
  let digits = value.toString(16);
  if (digits.length % 2) digits = `0${digits}`;
  return hexBytes(`0x${digits}`);
}

function rlpBytes(value: Uint8Array): Uint8Array {
  if (value.length === 1 && value[0]! < 0x80) return value;
  if (value.length < 56) return concat(Uint8Array.of(0x80 + value.length), value);
  const length = unsigned(BigInt(value.length));
  return concat(Uint8Array.of(0xb7 + length.length), length, value);
}

function rlpList(items: Uint8Array[]): Uint8Array {
  const payload = concat(...items);
  if (payload.length < 56) return concat(Uint8Array.of(0xc0 + payload.length), payload);
  const length = unsigned(BigInt(payload.length));
  return concat(Uint8Array.of(0xf7 + length.length), length, payload);
}

/** Canonical unsigned EIP-1559 transfer preimage accepted by the contract. */
export function baseSweepPayload(destination: string, amount: bigint, nonce: bigint,
  priorityFee: bigint, maxFee: bigint, gasLimit: bigint): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(destination) || amount <= 0n || amount > 1_000_000n ||
    priorityFee <= 0n || maxFee < priorityFee || gasLimit <= 0n) throw new Error('bad_sweep_payload');
  const call = concat(hexBytes('0xa9059cbb'), new Uint8Array(12), hexBytes(destination),
    new Uint8Array(24), unsigned(amount).length === 0 ? new Uint8Array(8) : (() => {
      const units = new Uint8Array(8); units.set(unsigned(amount), 8 - unsigned(amount).length); return units;
    })());
  return concat(Uint8Array.of(2), rlpList([
    rlpBytes(unsigned(8453n)), rlpBytes(unsigned(nonce)), rlpBytes(unsigned(priorityFee)),
    rlpBytes(unsigned(maxFee)), rlpBytes(unsigned(gasLimit)), rlpBytes(hexBytes(BASE_USDC)),
    rlpBytes(new Uint8Array()), rlpBytes(call), rlpList([]),
  ]));
}

export interface BaseTransactionFields {
  nonce: bigint; priorityFee: bigint; maxFee: bigint; gasLimit: bigint;
  to: string; value: bigint; data: Uint8Array;
}

export function baseUnsignedTransaction(fields: BaseTransactionFields): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(fields.to) || fields.priorityFee <= 0n ||
    fields.maxFee < fields.priorityFee || fields.gasLimit <= 0n) throw new Error('bad_base_transaction');
  return concat(Uint8Array.of(2), rlpList([
    rlpBytes(unsigned(8453n)), rlpBytes(unsigned(fields.nonce)),
    rlpBytes(unsigned(fields.priorityFee)), rlpBytes(unsigned(fields.maxFee)),
    rlpBytes(unsigned(fields.gasLimit)), rlpBytes(hexBytes(fields.to)),
    rlpBytes(unsigned(fields.value)), rlpBytes(fields.data), rlpList([]),
  ]));
}

/** EIP-1559 signed wire bytes; `recovery` is the parity byte 0 or 1. */
export function baseSignedTransaction(fields: BaseTransactionFields, recovery: number,
  r: Uint8Array, s: Uint8Array): Uint8Array {
  if ((recovery !== 0 && recovery !== 1) || r.length !== 32 || s.length !== 32)
    throw new Error('bad_base_signature');
  const compact = (bytes: Uint8Array) => {
    const index = bytes.findIndex((byte) => byte !== 0);
    return index < 0 ? new Uint8Array() : bytes.slice(index);
  };
  return concat(Uint8Array.of(2), rlpList([
    rlpBytes(unsigned(8453n)), rlpBytes(unsigned(fields.nonce)),
    rlpBytes(unsigned(fields.priorityFee)), rlpBytes(unsigned(fields.maxFee)),
    rlpBytes(unsigned(fields.gasLimit)), rlpBytes(hexBytes(fields.to)),
    rlpBytes(unsigned(fields.value)), rlpBytes(fields.data), rlpList([]),
    rlpBytes(unsigned(BigInt(recovery))), rlpBytes(compact(r)), rlpBytes(compact(s)),
  ]));
}
