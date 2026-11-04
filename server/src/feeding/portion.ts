// A portion of NEAR, from the tap to the network (`Feeding transaction data`, `Feeding gas data`).
//
// `buildPortion` is `POST …/feed`: it checks the sheet again, tops the wallet's gas up once when it
// needs it, and answers the unsigned `pet_feed` transaction for the player's browser to check and
// sign. `sendPortion` is `POST …/feed/send`: the server's check of what the browser signed, the
// in-flight row, the send, and the settlement of what came back. Neither one holds the player's key.
import { KeyType, PublicKey, Signature, SignedTransaction, Transaction, actions, baseEncode, createTransaction } from 'near-api-js';
import type { Session } from '../auth';
import {
  accessKeyNonce,
  ChainUnreachable,
  hatchView,
  PET_FEED_TGAS,
  petView,
  recentBlockHash,
  sendSigned,
  txStatus,
} from '../chain';
import { FEED_GAS_YOCTO, FEED_PORTIONS, GAS_TOPUP_YOCTO, MAX_FEED_GAS_TGAS, type PortionNear } from '../pricing';
import { settleFeeding } from '../pet/settle';
import { outcomeAnswer, rowOfPlayer, askNetwork } from './inflight';
import { readSheet } from './read';
import { claimGasTopUp, readWallet, releaseGasTopUp } from './wallet';

/** A route's answer: the body and the HTTP status. */
export interface Reply {
  status: 200 | 400 | 403 | 404 | 409 | 500 | 502 | 503;
  body: Record<string, unknown>;
}

export const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

export function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The public key of an implicit account: the 64 hex characters are the ed25519 key itself. */
export function implicitKey(accountId: string): PublicKey | null {
  if (!/^[0-9a-f]{64}$/.test(accountId)) return null;
  const data = Uint8Array.from(accountId.match(/../g)!.map((pair) => parseInt(pair, 16)));
  return new PublicKey({ keyType: KeyType.ED25519, data });
}

const unreachable: Reply = { status: 503, body: { code: 'chain_unreachable' } };
const GAS_PER_TGAS = 1_000_000_000_000n;

export async function buildPortion(env: Env, session: Session, tokenId: string, portion: PortionNear, rate: number): Promise<Reply> {
  try {
    const pet = await petView(env, tokenId);
    if (pet === null) return { status: 404, body: { code: 'no_pet' } };
    if ((await rowOfPlayer(env.DB, session.accountId)) !== null) return { status: 409, body: { code: 'pending' } };
    const chosen = FEED_PORTIONS.find((p) => p.near === portion)!;

    // The sheet again, as it stands now: a portion the wallet cannot cover is refused with the sheet.
    let read = await readSheet(env, session, tokenId, pet, rate);
    if (read.sheet.portions.find((p) => p.near === portion)!.missing !== null) {
      return { status: 409, body: { code: 'short', sheet: { chain: true, ...read.sheet } } };
    }

    // The project's one top-up of gas, only for a wallet that holds the portion but not its gas, and
    // before anything is signed (`Feeding gas data` › «запас газа доложен»).
    if (!read.wallet.topUpGiven && read.wallet.balance < chosen.yocto + FEED_GAS_YOCTO) {
      const at = Date.now();
      if (await claimGasTopUp(env.DB, session.sub, GAS_TOPUP_YOCTO, at)) {
        const sent = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('gas')).transfer(session.accountId, GAS_TOPUP_YOCTO.toString());
        if (sent.status === 'unreachable') {
          // Nothing was sent, so the player is owed the top-up again.
          await releaseGasTopUp(env.DB, session.sub, GAS_TOPUP_YOCTO, at);
          return unreachable;
        }
        if (sent.status === 'failed') {
          await releaseGasTopUp(env.DB, session.sub, GAS_TOPUP_YOCTO, at);
          console.log(`topup_failed:${sent.code}`);
          return { status: 502, body: { code: 'feed_not_built' } };
        }
        if (sent.status === 'unknown') {
          // The claim stays: a second transfer could be a second top-up (ADR-006). Nothing was signed.
          console.log('topup_failed:unknown');
          return { status: 502, body: { code: 'feed_not_built' } };
        }
      } else {
        // Another tab claimed it while this one read: if its transfer already landed this wallet holds
        // the gas, otherwise that tab is building the same portion right now.
        const again = await readWallet(env, session);
        if (again.balance < chosen.yocto + FEED_GAS_YOCTO) return { status: 409, body: { code: 'pending' } };
      }
    }

    const publicKey = implicitKey(session.accountId);
    if (publicKey === null) return { status: 502, body: { code: 'feed_not_built' } };
    const nonce = await accessKeyNonce(env, session.accountId, publicKey);
    if (nonce === null) return unreachable;
    const blockHash = await recentBlockHash(env);
    const tx = createTransaction(
      session.accountId,
      publicKey,
      env.CONTRACT_ID,
      nonce + 1n,
      [actions.functionCall('pet_feed', { token_id: tokenId }, PET_FEED_TGAS * GAS_PER_TGAS, chosen.yocto)],
      blockHash,
    );
    return { status: 200, body: { tx: toBase64(tx.encode()) } };
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable;
    throw e;
  }
}

/** What the server accepts to send for the player: one `pet_feed` of this pet from the session's
 * account, with one of the three portions, signed by that account's key. Anything else is `null`. */
function checkedPortion(env: Env, session: Session, tokenId: string, tx: Transaction, bytes: Uint8Array, signature: Uint8Array): bigint | null {
  if (tx.signerId !== session.accountId || tx.receiverId !== env.CONTRACT_ID) return null;
  if (tx.nonceIndex !== undefined || tx.nonceMode !== undefined) return null;
  // The game wallet is an implicit account: its key is the account id itself.
  if (tx.publicKey.toString() !== implicitKey(session.accountId)?.toString()) return null;
  if (tx.actions.length !== 1) return null;
  const call = tx.actions[0]!.functionCall;
  if (call === undefined || call.methodName !== 'pet_feed') return null;
  if (call.gas > MAX_FEED_GAS_TGAS * GAS_PER_TGAS) return null;
  let args: unknown;
  try {
    args = JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args as ArrayLike<number>)));
  } catch {
    return null;
  }
  if (typeof args !== 'object' || args === null || Object.keys(args).join() !== 'token_id' || (args as { token_id: unknown }).token_id !== tokenId) return null;
  if (!FEED_PORTIONS.some((p) => p.yocto === call.deposit)) return null;
  if (signature.length !== 64 || bytes.length === 0) return null;
  return call.deposit;
}

export async function sendPortion(env: Env, session: Session, tokenId: string, input: { tx?: unknown; signature?: unknown }): Promise<Reply> {
  const bad: Reply = { status: 400, body: { code: 'bad_tx' } };
  if (typeof input.tx !== 'string' || typeof input.signature !== 'string' || input.tx.length > 2_800 || input.signature.length > 200) {
    return { status: 400, body: { code: 'bad_request' } };
  }
  const bytes = fromBase64(input.tx);
  const signatureBytes = fromBase64(input.signature);
  if (bytes === null || signatureBytes === null) return { status: 400, body: { code: 'bad_request' } };

  let tx: Transaction;
  try {
    tx = Transaction.decode(bytes);
  } catch {
    return bad;
  }
  // Nothing may trail the transaction, and the signature must be this account's over exactly these bytes.
  if (toBase64(tx.encode()) !== input.tx) return bad;
  const deposit = checkedPortion(env, session, tokenId, tx, bytes, signatureBytes);
  if (deposit === null) return bad;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (!tx.publicKey.verify(digest, signatureBytes)) return bad;
  const hash = baseEncode(digest);
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: KeyType.ED25519, data: signatureBytes }) });

  try {
    const pet = await petView(env, tokenId);
    if (pet === null) return { status: 404, body: { code: 'no_pet' } };
    // Read before the send, so a network that stops answering after the meal costs nothing.
    const hatched = (await hatchView(env, session.accountId)).token_id !== null;
    const via = pet.owner_id === session.accountId ? 'owner' : 'link';
    const answer = async (status: 'ok' | 'failed' | 'unknown') => ({ status: 200 as const, body: await outcomeAnswer(env.DB, session.sub, status, hash, hatched, via === 'link') });

    let row = await rowOfPlayer(env.DB, session.accountId);
    if (row !== null && row.id !== hash) return { status: 409, body: { code: 'pending' } };
    if (row === null) {
      // No row: this is the first send, or a repeat of one that is already settled. The player's key has
      // used this nonce only in the second case, and then the network says what became of it.
      const used = await accessKeyNonce(env, session.accountId, tx.publicKey);
      if (used !== null && used >= tx.nonce) {
        const seen = await txStatus(env, hash, session.accountId);
        if (seen?.status === 'ok' || seen?.status === 'failed') return answer(seen.status);
        if (seen?.status === 'pending') return answer('unknown');
        // No answer is no outcome (`txStatus` says the same for its own timeout): the node is asked
        // with the same bytes, which ends in `failed` only when it refuses them and the hash is nowhere.
        return answer((await sendSigned(env, signed)).status);
      }
      const inserted = await env.DB.prepare(
        'INSERT INTO feedings (id, sub, account, token_id, source, via, deposit_yocto, tx_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?1, ?8) ON CONFLICT (account) DO NOTHING',
      )
        .bind(hash, session.sub, session.accountId, tokenId, 'near', via, deposit.toString(), Date.now())
        .run();
      row = await rowOfPlayer(env.DB, session.accountId);
      // Another tab put its row in between: a different hash is refused, the same one is the repeat.
      if (inserted.meta.changes === 0 && (row === null || row.id !== hash)) return { status: 409, body: { code: 'pending' } };
    } else {
      // A repeat: the network may already have it.
      const known = await askNetwork(env, row);
      if (known !== null) return answer(known.status);
    }
    if (row === null) return answer('ok');

    console.log('feed_sent');
    const sent = await sendSigned(env, signed);
    if (sent.status === 'ok') {
      await settleFeeding(env, row, { status: 'ok', value: sent.value, ...(sent.burnt !== undefined ? { burnt: sent.burnt } : {}) });
    } else if (sent.status === 'failed') {
      await settleFeeding(env, row, { status: 'failed', code: sent.code });
    } else {
      console.log('feed_unknown');
    }
    return answer(sent.status);
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable;
    throw e;
  }
}
