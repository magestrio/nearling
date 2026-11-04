import { Transaction } from 'near-api-js';
import { config } from '../config';
import { fromBase64, toBase64, type TxCheck } from '../feeding/feedTx';
import { publicKeyFromImplicitAccount } from '../near/privySigner';

/** Check the exact gift the player approved before asking Privy to sign its hash. */
export function checkGiftTx(tx: string, expected: { account: string; tokenId: string; receiver: string; contractId?: string }): TxCheck {
  const bytes = fromBase64(tx);
  if (bytes === null || bytes.length === 0) return { ok: false, why: 'bytes' };
  let decoded: Transaction;
  try { decoded = Transaction.decode(bytes); } catch { return { ok: false, why: 'bytes' }; }
  if (toBase64(decoded.encode()) !== tx) return { ok: false, why: 'trailing' };
  if (decoded.signerId !== expected.account) return { ok: false, why: 'signer' };
  let key: string;
  try { key = publicKeyFromImplicitAccount(expected.account).toString(); } catch { return { ok: false, why: 'key' }; }
  if (decoded.publicKey.toString() !== key) return { ok: false, why: 'key' };
  if (decoded.receiverId !== (expected.contractId ?? config.contractId)) return { ok: false, why: 'receiver' };
  if ((decoded as { nonceIndex?: unknown }).nonceIndex !== undefined || (decoded as { nonceMode?: unknown }).nonceMode !== undefined) return { ok: false, why: 'nonce_index' };
  if (decoded.actions.length !== 1) return { ok: false, why: 'actions' };
  const call = decoded.actions[0]?.functionCall;
  if (!call) return { ok: false, why: 'actions' };
  if (call.methodName !== 'nft_transfer') return { ok: false, why: 'method' };
  let args: unknown;
  try { args = JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args as ArrayLike<number>))); } catch { return { ok: false, why: 'args' }; }
  if (typeof args !== 'object' || args === null || Object.keys(args).sort().join(',') !== 'approval_id,memo,receiver_id,token_id') return { ok: false, why: 'args' };
  const fields = args as Record<string, unknown>;
  if (fields.receiver_id !== expected.receiver || fields.token_id !== expected.tokenId || fields.approval_id !== null || fields.memo !== null) return { ok: false, why: 'args' };
  if (call.deposit !== 1n) return { ok: false, why: 'deposit' };
  if (call.gas !== 5n * 10n ** 12n) return { ok: false, why: 'gas' };
  return { ok: true, bytes };
}
