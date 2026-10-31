import { Transaction } from 'near-api-js';
import { config } from '../config';
import { publicKeyFromImplicitAccount } from '../near/privySigner';
import type { PortionNear } from '../seams/worker-types';

// The check before anything is signed (`Feeding transaction data` › «прислана не та порция», `Feeding outcome rule`): the
// Worker builds the transaction, the browser decodes it and signs it only when it is exactly the one portion that was tapped.
// Anything else is nothing signed and nothing sent: the player sees «не прошло».

/** The deposit of each portion, from the client's own list: never read from the server's answer. */
export const PORTION_YOCTO: Record<PortionNear, bigint> = {
  '0.01': 10n ** 22n,
  '0.05': 5n * 10n ** 22n,
  '0.2': 2n * 10n ** 23n,
};

/** The most gas a portion may prepay (30 Tgas): a larger prepaid buy needs more balance than the sheet promised. */
export const MAX_FEED_GAS = 30n * 10n ** 12n;

export type TxRefusal =
  | 'bytes'
  | 'trailing'
  | 'signer'
  | 'key'
  | 'receiver'
  | 'nonce_index'
  | 'actions'
  | 'method'
  | 'args'
  | 'deposit'
  | 'gas';

export type TxCheck = { ok: true; bytes: Uint8Array } | { ok: false; why: TxRefusal };

export interface Expected {
  /** the player's own game wallet, the 64-hex implicit account */
  account: string;
  tokenId: string;
  portion: PortionNear;
  /** the pets contract; defaults to this build's */
  contractId?: string;
}

export function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

/** sha256 of the encoded transaction as hex without `0x`: what Privy signs and the network hashes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether the server's answer is the transaction the player tapped: one `pet_feed` of this pet from this account on the pets
 *  contract with the tapped portion's deposit, nothing trailing, nothing else in it. */
export function checkFeedTx(tx: string, expected: Expected): TxCheck {
  const bytes = fromBase64(tx);
  if (bytes === null || bytes.length === 0) return { ok: false, why: 'bytes' };
  let decoded: Transaction;
  try {
    decoded = Transaction.decode(bytes);
  } catch {
    return { ok: false, why: 'bytes' };
  }
  // nothing may trail the transaction: it is the same bytes once decoded and encoded again
  if (toBase64(decoded.encode()) !== tx) return { ok: false, why: 'trailing' };
  if (decoded.signerId !== expected.account) return { ok: false, why: 'signer' };
  let key: string;
  try {
    key = publicKeyFromImplicitAccount(expected.account).toString();
  } catch {
    return { ok: false, why: 'key' };
  }
  if (decoded.publicKey.toString() !== key) return { ok: false, why: 'key' };
  if (decoded.receiverId !== (expected.contractId ?? config.contractId)) return { ok: false, why: 'receiver' };
  if ((decoded as { nonceIndex?: unknown }).nonceIndex !== undefined || (decoded as { nonceMode?: unknown }).nonceMode !== undefined) {
    return { ok: false, why: 'nonce_index' };
  }
  if (decoded.actions.length !== 1) return { ok: false, why: 'actions' };
  const call = decoded.actions[0]!.functionCall;
  if (call === undefined) return { ok: false, why: 'actions' };
  if (call.methodName !== 'pet_feed') return { ok: false, why: 'method' };
  let args: unknown;
  try {
    args = JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args as ArrayLike<number>)));
  } catch {
    return { ok: false, why: 'args' };
  }
  const keys = typeof args === 'object' && args !== null ? Object.keys(args) : [];
  if (keys.length !== 1 || keys[0] !== 'token_id' || (args as { token_id: unknown }).token_id !== expected.tokenId) return { ok: false, why: 'args' };
  if (call.deposit !== PORTION_YOCTO[expected.portion]) return { ok: false, why: 'deposit' };
  if (call.gas > MAX_FEED_GAS) return { ok: false, why: 'gas' };
  return { ok: true, bytes };
}
