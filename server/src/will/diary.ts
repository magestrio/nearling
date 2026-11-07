import { decodeSignedTransaction } from 'near-api-js';
import { petView, sendSigned, transactionExpired, txStatus, type PetRecord } from '../chain';
import { memoryEpoch } from '../pet/forget';
import { BOUGHT_IDS, OUTFITS } from '../pet/outfits';
import { gasIsLow } from '../servicePause';
import { track } from '../track';
import { recordWillEvent } from './events';

const START_GAS = (5n * 1_000_000_000_000n).toString();
const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const PRIVATE_WORDS = /\b(?:hire|hired|work|worker|job|question|answer|pay|spend|buy|bought|owner|guilt|sorry)\b/i;

export interface WishOffer { slugs: string[]; existing: string | null }

/** Only code-set purchasable, unowned items reach the paid diary request. */
export async function wishOffer(db: D1Database, tokenId: string, pet: PetRecord): Promise<WishOffer> {
  const row = await db.prepare("SELECT item, owner_generation, memory_epoch FROM pet_wishes WHERE token_id = ? AND status IN ('starting', 'active', 'paused', 'buying', 'waiting_day')")
    .bind(tokenId).first<{ item: string; owner_generation: number; memory_epoch: number }>();
  if (row !== null && (row.owner_generation !== pet.transfer_generation || row.memory_epoch !== await memoryEpoch(db, tokenId))) {
    return { existing: null, slugs: [] };
  }
  return { existing: row?.item ?? null, slugs: row === null
    ? BOUGHT_IDS.filter((id) => !pet.outfits.includes(id)).map((id) => OUTFITS[id].slug)
    : [] };
}

export function wishInstruction(offer: WishOffer): string {
  if (offer.existing !== null) return `\nYour private wish is ${JSON.stringify(offer.existing)}. You may add one short diary line about wanting it. Prefix it WISH LINE: before your final question. Do not mention another owner, private job words, guilt or a spending demand.`;
  if (offer.slugs.length === 0) return '';
  return `\nYou may choose one outfit you do not own from ${offer.slugs.map((s) => JSON.stringify(s)).join(', ')} based on your character. Before your final question, write WISH <slug> | <short reason> | <one short diary line>. Do not mention another owner, private job words, guilt or a spending demand. Choose only one listed slug.`;
}

export interface WishChoice { item: string | null; reason: string | null; line: string | null; reply: string }

/** Model markers never become a conversation line. Invalid choices start no reserve. */
export function parseWish(text: string, offer: WishOffer, blockedNames: readonly string[] = []): WishChoice {
  let item: string | null = null;
  let reason: string | null = null;
  let line: string | null = null;
  const plain: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const value = raw.trim();
    if (value.startsWith('WISH LINE:')) {
      const candidate = value.slice('WISH LINE:'.length).trim();
      if (offer.existing !== null && line === null && safe(candidate, 240, blockedNames)) line = candidate;
    } else if (value.startsWith('WISH ')) {
      if (item !== null || offer.existing !== null) continue;
      const parts = value.slice(5).split('|').map((part) => part.trim());
      if (parts.length !== 3 || !offer.slugs.includes(parts[0]!)) continue;
      const candidateReason = parts[1]!;
      const candidateLine = parts[2]!;
      if (!safe(candidateReason, 160, blockedNames) || !safe(candidateLine, 240, blockedNames)) continue;
      item = parts[0]!;
      reason = candidateReason;
      line = candidateLine;
    } else plain.push(raw);
  }
  return { item, reason, line, reply: plain.join('\n').trim() };
}

function safe(value: string, limit: number, blockedNames: readonly string[]): boolean {
  return value.length > 0 && [...value].length <= limit && !/[\r\n\u0085\p{Zl}\p{Zp}]/u.test(value)
    && !PRIVATE_WORDS.test(value) && blockedNames.every((name) => name === '' || !value.toLowerCase().includes(name.toLowerCase()));
}

export function wishStatements(db: D1Database, tokenId: string, day: number, epoch: number, generation: number,
  choice: WishChoice, now: number): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (choice.item !== null && choice.reason !== null) {
    const op = randomId();
    statements.push(db.prepare(`INSERT OR IGNORE INTO pet_wishes
      (token_id, item, reason, status, owner_generation, memory_epoch, diary_day, start_op, created_at)
      SELECT ?, ?, ?, 'starting', ?, ?, ?, ?, ? WHERE COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?), 0) = ?`)
      .bind(tokenId, choice.item, choice.reason, generation, epoch, day, op, now, tokenId, epoch));
    statements.push(db.prepare(`INSERT OR IGNORE INTO will_operations (id, token_id, kind, status, item, created_at)
      SELECT ?, ?, 'start', 'queued', ?, ? WHERE EXISTS (SELECT 1 FROM pet_wishes WHERE token_id = ? AND start_op = ?)`)
      .bind(op, tokenId, choice.item, now, tokenId, op));
  }
  if (choice.line !== null) statements.push(db.prepare(`INSERT OR IGNORE INTO will_diary_lines (token_id, day, line, memory_epoch)
    SELECT ?, ?, ?, ? WHERE COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?), 0) = ?`)
    .bind(tokenId, day, choice.line, epoch, tokenId, epoch));
  return statements;
}

export async function privateWish(db: D1Database, tokenId: string, pet: PetRecord): Promise<{
  item: string; reason: string; status: string; reserveYocto: string;
} | null> {
  const row = await db.prepare("SELECT item, reason, status, owner_generation, memory_epoch FROM pet_wishes WHERE token_id = ? AND status <> 'starting'")
    .bind(tokenId).first<{ item: string; reason: string; status: string; owner_generation: number; memory_epoch: number }>();
  if (row === null || row.memory_epoch !== await memoryEpoch(db, tokenId)) return null;
  if (row.owner_generation !== pet.transfer_generation) {
    // A transfer can happen outside this app. The public generation is authoritative.
    await db.batch([
      db.prepare("UPDATE pet_wishes SET status = 'paused' WHERE token_id = ? AND owner_generation = ?")
        .bind(tokenId, row.owner_generation),
      db.prepare("UPDATE work_invitations SET status = 'expired' WHERE status = 'open' AND (sender_token = ? OR recipient_token = ?)")
        .bind(tokenId, tokenId),
    ]);
  }
  return { item: row.item, reason: row.reason,
    status: row.owner_generation !== pet.transfer_generation || !pet.wish_active ? 'paused' : row.status,
    reserveYocto: pet.wish_reserve ?? '0' };
}

/** A lost response is reconciled by hash or public active flag before any new send. */
export async function startPendingWish(env: Env, tokenId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT w.item, w.owner_generation, w.memory_epoch, w.diary_day, w.start_op, o.status, o.purpose, o.tx_hash, o.signed_bytes, o.rebroadcast_at, o.sending_at, o.created_at
    FROM pet_wishes w JOIN will_operations o ON o.id = w.start_op
    WHERE w.token_id = ? AND w.status = 'starting'`).bind(tokenId)
    .first<{ item: string; owner_generation: number; memory_epoch: number; diary_day: number; start_op: string; status: string; purpose: string; tx_hash: string | null; signed_bytes: ArrayBuffer | null; rebroadcast_at: number | null; sending_at: number | null; created_at: number }>();
  if (row === null) return;
  const pet = await petView(env, tokenId);
  if (pet === null || pet.transfer_generation !== row.owner_generation || await memoryEpoch(env.DB, tokenId) !== row.memory_epoch ||
    !BOUGHT_IDS.some((id) => OUTFITS[id].slug === row.item && !pet.outfits.includes(id))) {
    if (row.purpose === 'resume') {
      await failStart(env, tokenId, row.start_op, row.diary_day, row.tx_hash);
      return;
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pet_wishes WHERE token_id = ? AND status = 'starting'").bind(tokenId),
      env.DB.prepare('DELETE FROM will_diary_lines WHERE token_id = ? AND day = ?').bind(tokenId, row.diary_day),
      env.DB.prepare('DELETE FROM work_invitations WHERE sender_token = ? AND day = ?').bind(tokenId, row.diary_day),
      env.DB.prepare("UPDATE will_operations SET status = 'failed', settled_at = ? WHERE id = ?").bind(Date.now(), row.start_op),
    ]);
    return;
  }
  if (pet.wish_active) {
    return confirmStart(env, tokenId, row.start_op);
  }
  if (row.status === 'unknown' && row.tx_hash !== null) {
    const outcome = await txStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID);
    if (outcome === null) {
      const signed = row.signed_bytes === null ? null : decodeSignedTransaction(new Uint8Array(row.signed_bytes));
      if (signed !== null && await transactionExpired(env, signed.transaction.blockHash, row.created_at)) {
        // An expiry only permits a new signature after one more public-state and hash read.
        const [fresh, latest] = await Promise.all([petView(env, tokenId), txStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID)]);
        if (fresh?.wish_active || latest?.status === 'ok') return confirmStart(env, tokenId, row.start_op);
        if (latest?.status === 'pending') return;
        await env.DB.prepare("UPDATE will_operations SET status = 'queued', tx_hash = NULL, signed_bytes = NULL WHERE id = ? AND status = 'unknown'")
          .bind(row.start_op).run();
      } else if (signed !== null && Date.now() - (row.rebroadcast_at ?? row.sending_at ?? row.created_at) >= 60_000) {
        const claim = await env.DB.prepare("UPDATE will_operations SET rebroadcast_at = ? WHERE id = ? AND status = 'unknown' AND (rebroadcast_at IS NULL OR rebroadcast_at <= ?)")
          .bind(Date.now(), row.start_op, Date.now() - 60_000).run();
        if (claim.meta.changes === 1) await sendSigned(env, signed);
        return;
      } else return;
    }
    if (outcome?.status === 'ok') {
      return confirmStart(env, tokenId, row.start_op);
    }
    if (outcome?.status === 'pending') return;
    if (outcome?.status === 'failed') return failStart(env, tokenId, row.start_op, row.diary_day, row.tx_hash);
  } else if (row.status === 'sending' && row.tx_hash !== null) {
    await env.DB.prepare("UPDATE will_operations SET status = 'unknown' WHERE id = ? AND status = 'sending'").bind(row.start_op).run();
    return;
  } else if (row.status === 'sending' && row.tx_hash === null && row.sending_at !== null && Date.now() - row.sending_at > 300_000) {
    // The key's onSigned hook refuses to broadcast if this row is no longer sending.
    await env.DB.prepare("UPDATE will_operations SET status = 'queued' WHERE id = ? AND status = 'sending' AND tx_hash IS NULL")
      .bind(row.start_op).run();
  } else if (row.status === 'unknown' && row.tx_hash === null) {
    await env.DB.prepare("UPDATE will_operations SET status = 'queued' WHERE id = ? AND status = 'unknown'").bind(row.start_op).run();
  }
  if (await gasIsLow(env, Date.now())) return;
  const claimed = await env.DB.prepare("UPDATE will_operations SET status = 'sending', sending_at = ? WHERE id = ? AND status = 'queued' RETURNING id")
    .bind(Date.now(), row.start_op).first();
  if (claimed === null) return;
  const sent = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
    methodName: 'will_start', args: { token_id: tokenId }, gas: START_GAS,
    writes: { kind: 'will_start', op: row.start_op },
  });
  if (sent.status === 'ok') {
    await confirmStart(env, tokenId, row.start_op);
  } else if (sent.status === 'failed') {
    await failStart(env, tokenId, row.start_op, row.diary_day, sent.txHash);
  } else {
    await env.DB.prepare("UPDATE will_operations SET status = 'unknown', tx_hash = COALESCE(tx_hash, ?) WHERE id = ?")
      .bind('txHash' in sent ? sent.txHash : null, row.start_op).run();
  }
}

async function failStart(env: Env, tokenId: string, op: string, day: number, hash: string | null): Promise<void> {
  const resume = (await env.DB.prepare('SELECT purpose FROM will_operations WHERE id = ?').bind(op)
    .first<{ purpose: string }>())?.purpose === 'resume';
  await env.DB.batch([
    resume ? env.DB.prepare("UPDATE pet_wishes SET status = 'paused' WHERE token_id = ? AND status = 'starting' AND start_op = ?").bind(tokenId, op)
      : env.DB.prepare("DELETE FROM pet_wishes WHERE token_id = ? AND status = 'starting' AND start_op = ?").bind(tokenId, op),
    ...(!resume ? [env.DB.prepare('DELETE FROM will_diary_lines WHERE token_id = ? AND day = ?').bind(tokenId, day),
      env.DB.prepare('DELETE FROM work_invitations WHERE sender_token = ? AND day = ?').bind(tokenId, day)] : []),
    env.DB.prepare("UPDATE will_operations SET status = 'failed', tx_hash = COALESCE(tx_hash, ?), settled_at = ? WHERE id = ?")
      .bind(hash, Date.now(), op),
  ]);
}

async function confirmStart(env: Env, tokenId: string, op: string): Promise<void> {
  const resume = (await env.DB.prepare('SELECT purpose FROM will_operations WHERE id = ?').bind(op)
    .first<{ purpose: string }>())?.purpose === 'resume';
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE pet_wishes SET status = 'active' WHERE token_id = ? AND status = 'starting' AND start_op = ?")
      .bind(tokenId, op),
    env.DB.prepare("UPDATE will_operations SET status = 'confirmed', settled_at = ? WHERE id = ? AND status IN ('queued', 'sending', 'unknown')")
      .bind(Date.now(), op),
  ]);
  if (results[0]?.meta.changes === 1 && !resume) {
    track('pet_wish_chosen');
    await recordWillEvent(env, 'pet_wish_chosen', { id: op });
    const invited = await env.DB.prepare(`SELECT id FROM work_invitations WHERE sender_token = ?
      AND day = (SELECT diary_day FROM pet_wishes WHERE token_id = ?) AND status = 'open'`)
      .bind(tokenId, tokenId).first<{ id: string }>();
    if (invited !== null) {
      track('pet_work_invited');
      await recordWillEvent(env, 'pet_work_invited', { id: invited.id });
    }
  }
}
