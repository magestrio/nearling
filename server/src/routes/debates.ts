import { Hono } from 'hono';
import { ChainUnreachable, petKnows, petView, type PetRecord } from '../chain';
import { requireSession, TOKEN_ID, utcDay, type AppContext, type AppEnv } from '../http';
import { hasVisible } from '../name/clean';
import { memoryEpoch } from '../pet/forget';
import { foodState } from '../pet/view';
import { callUsd12, TYPICAL_IN, TYPICAL_OUT, usd12ToMicros } from '../pricing';
import { relation } from '../society/relations';
import { runDebateTurn } from '../debates/turns';
import { opaqueDebateId, recordDebateEvent, recordDebateOpen } from '../debates/events';
import { intactDebateBytes, matchingDebateReceipt } from '../verification/receipt';
import { debateLineText } from '../debates/prompt';

export const debateRoutes = new Hono<AppEnv>();

const ID = /^[0-9a-f]{64}$/;
const CODE = /^[0-9a-f]{32}$/;
const MAX_PER_PET = '0.01';
const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const DAY_MS = 86_400_000;

type Proof = 'first_fed' | 'second_fed' | 'hire';
type DebateStatus = 'invited' | 'accepted' | 'running' | 'completed' | 'declined' | 'expired' | 'gift' | 'cleared' | 'stopped' | 'refused' | 'unavailable';

export interface DebateEligibilityResponse {
  eligible: true;
  firstPet: { tokenId: string; name: string };
  secondPet: { tokenId: string; name: string };
  maxPerPetNear: string;
  estimatePerPetCents: number;
  notice: string;
}

export interface DebateReadResponse {
  id: string;
  analyticsId: string;
  status: DebateStatus;
  topic: string;
  firstPet: { tokenId: string; name: string };
  secondPet: { tokenId: string; name: string };
  openerPet: string;
  maxPerPetNear: string;
  estimatePerPetCents: number;
  endReason?: string | null;
  lines: Array<{ order: number; speakerPet: string; status: string; text: string | null;
    requestBytes: string | null; responseBytes: string | null; signedCall: string | null;
    receiptTxHash: string | null; priceYocto: string | null; nearUsdRate: string | null }>;
}

interface DebateRow {
  id: string;
  first_pet: string;
  second_pet: string;
  first_owner: string;
  second_owner: string;
  first_generation: number;
  second_generation: number;
  first_epoch: number;
  second_epoch: number;
  acquaintance: Proof;
  opener_pet: string;
  topic: string;
  status: DebateStatus;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  ended_at: number | null;
  share_code: string;
  share_hash: string;
  end_reason?: string | null;
}

interface LineRow {
  line_order: number;
  speaker_pet: string;
  status: string;
  text: string | null;
  request_bytes: string | null;
  response_bytes: string | null;
  signed_call: string | null;
  receipt_tx_hash: string | null;
  price_yocto: string | null;
  near_usd_rate: string | null;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function estimatePerPetCents(env: Env): number {
  return Number((usd12ToMicros(2n * callUsd12(env, TYPICAL_IN, TYPICAL_OUT)) / 10_000).toPrecision(2));
}

function nextSequence(pet: PetRecord, tokenId: string): bigint {
  const old = pet.paid_debate?.id;
  if (old === undefined || old === null) return 1n;
  // The stored pair tag identifies the old partner. A new partner can put this pet
  // on the other side of the ordered id, but its monotonic sequence must carry over.
  const oldPartner = BigInt(`0x${old.slice(32, 48)}`) ^ BigInt(tokenId);
  const offset = BigInt(tokenId) < oldPartner ? 0 : 16;
  return BigInt(`0x${old.slice(offset, offset + 16)}`) + 1n;
}

/** Two monotonic per-pet sequences, the XOR pair tag, and a random u64. */
function debateId(firstId: string, secondId: string, first: PetRecord, second: PetRecord): string {
  const a = BigInt(firstId);
  const b = BigInt(secondId);
  const sequenceA = nextSequence(first, firstId);
  const sequenceB = nextSequence(second, secondId);
  if (sequenceA > 0xffff_ffff_ffff_ffffn || sequenceB > 0xffff_ffff_ffff_ffffn) throw new Error('debate_sequence_exhausted');
  const part = (value: bigint) => value.toString(16).padStart(16, '0');
  return `${a < b ? part(sequenceA) + part(sequenceB) : part(sequenceB) + part(sequenceA)}${part(a ^ b)}${randomHex(8)}`;
}

async function pair(env: Env, firstId: string, secondId: string): Promise<[PetRecord, PetRecord] | null> {
  const [first, second] = await Promise.all([petView(env, firstId), petView(env, secondId)]);
  return first !== null && second !== null ? [first, second] : null;
}

async function proof(env: Env, firstId: string, secondId: string, firstOwner: string, secondOwner: string,
  first: PetRecord, second: PetRecord): Promise<Proof | null> {
  if (first.work_known?.includes(secondId) || second.work_known?.includes(firstId)) return 'hire';
  if (await petKnows(env, firstId, secondOwner)) return 'first_fed';
  if (await petKnows(env, secondId, firstOwner)) return 'second_fed';
  return null;
}

async function originalProof(env: Env, row: DebateRow, first: PetRecord, second: PetRecord): Promise<boolean> {
  if (row.acquaintance === 'hire') return first.work_known?.includes(row.second_pet) === true || second.work_known?.includes(row.first_pet) === true;
  if (row.acquaintance === 'first_fed') return petKnows(env, row.first_pet, row.second_owner);
  return petKnows(env, row.second_pet, row.first_owner);
}

function sameBody(body: unknown, fields: string[]): body is Record<string, string> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) &&
    Object.keys(body).sort().join(',') === fields.sort().join(',') &&
    fields.every((key) => typeof (body as Record<string, unknown>)[key] === 'string');
}

async function bodyOf(c: AppContext): Promise<unknown> {
  return c.req.json<unknown>().catch(() => null);
}

async function invitation(c: AppContext, create: boolean): Promise<Response> {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await bodyOf(c);
  const fields = create ? ['firstPet', 'secondPet', 'openerPet', 'topic'] : ['firstPet', 'secondPet'];
  if (!sameBody(body, fields) || !TOKEN_ID.test(body.firstPet) || !TOKEN_ID.test(body.secondPet) || body.firstPet === body.secondPet ||
    BigInt(body.firstPet) > MAX_U64 || BigInt(body.secondPet) > MAX_U64 ||
    (create && (!TOKEN_ID.test(body.openerPet) || ![body.firstPet, body.secondPet].includes(body.openerPet))))
    return c.json({ code: 'bad_request' }, 400);
  if (create && (!hasVisible(body.topic) || [...body.topic].length > 140)) return c.json({ code: 'topic_rejected' }, 400);
  try {
    const pets = await pair(c.env, body.firstPet, body.secondPet);
    if (pets === null) return c.json({ code: 'no_pet' }, 404);
    const [first, second] = pets;
    if (first.owner_id !== session.accountId) return c.json({ code: 'not_owner' }, 403);
    if (first.owner_id === second.owner_id) return c.json({ code: 'same_owner' }, 409);
    const acquaintance = await proof(c.env, body.firstPet, body.secondPet, first.owner_id, second.owner_id, first, second);
    if (acquaintance === null) return c.json({ code: 'unknown_pair' }, 409);
    const now = Date.now();
    const day = utcDay(now);
    if (create) {
      const open = await c.env.DB.prepare(`SELECT id, first_pet, first_owner, second_owner, first_generation, second_generation
        FROM debates WHERE status = 'invited' AND expires_at > ?
          AND ((first_pet = ? AND second_pet = ?) OR (first_pet = ? AND second_pet = ?)) LIMIT 1`)
        .bind(now, body.firstPet, body.secondPet, body.secondPet, body.firstPet)
        .first<Pick<DebateRow, 'id' | 'first_pet' | 'first_owner' | 'second_owner' | 'first_generation' | 'second_generation'>>();
      if (open !== null) {
        const [openFirst, openSecond] = open.first_pet === body.firstPet ? [first, second] : [second, first];
        if (open.first_owner !== openFirst.owner_id || open.second_owner !== openSecond.owner_id ||
          open.first_generation !== openFirst.transfer_generation || open.second_generation !== openSecond.transfer_generation)
          await closeInvitation(c.env.DB, open.id, 'gift', now);
        else return c.json({ code: 'open_pair_invitation' }, 409);
      }
    }
    const [firstFood, secondFood, firstRelation, secondRelation] = await Promise.all([
      foodState(c.env.DB, body.firstPet, first, now), foodState(c.env.DB, body.secondPet, second, now),
      relation(c.env.DB, body.firstPet, body.secondPet), relation(c.env.DB, body.secondPet, body.firstPet),
    ]);
    if (firstFood.eff <= 0n || secondFood.eff <= 0n)
      return c.json({ code: 'asleep', name: firstFood.eff <= 0n ? first.name : second.name,
        petId: firstFood.eff <= 0n ? body.firstPet : body.secondPet }, 409);
    if (firstFood.capLeft <= 0n || secondFood.capLeft <= 0n) return c.json({ code: 'cap_exhausted' }, 409);
    if ((firstRelation?.break_until ?? 0) > now || (secondRelation?.break_until ?? 0) > now)
      return c.json({ code: 'society_refusal', petId: (firstRelation?.break_until ?? 0) > now ? body.firstPet : body.secondPet }, 409);
    const occupied = await c.env.DB.prepare('SELECT pet_id FROM debate_started_days WHERE day = ? AND pet_id IN (?, ?) LIMIT 1')
      .bind(day, body.firstPet, body.secondPet).first();
    const active = await c.env.DB.prepare("SELECT id FROM debates WHERE status = 'running' AND (first_pet IN (?, ?) OR second_pet IN (?, ?)) LIMIT 1")
      .bind(body.firstPet, body.secondPet, body.firstPet, body.secondPet).first();
    if (occupied !== null || active !== null || [first, second].some((pet) => pet.paid_debate?.occupied_day === day))
      return c.json({ code: 'daily_slot_used' }, 409);
    const detail = { firstPet: { tokenId: body.firstPet, name: first.name }, secondPet: { tokenId: body.secondPet, name: second.name }, maxPerPetNear: MAX_PER_PET,
      estimatePerPetCents: estimatePerPetCents(c.env),
      notice: 'Each pet can spend up to 0.01 NEAR. Anyone with the link may read the topic and lines.' };
    if (!create) return c.json({ eligible: true, ...detail } satisfies DebateEligibilityResponse);
    // The initial owner consents by sending; the invited owner has a separate decision row.
    const id = debateId(body.firstPet, body.secondPet, first, second);
    const code = randomHex(16);
    const hash = await sha256(code);
    const [firstEpoch, secondEpoch] = await Promise.all([memoryEpoch(c.env.DB, body.firstPet), memoryEpoch(c.env.DB, body.secondPet)]);
    const expires = (day + 1) * DAY_MS;
    const inserted = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO debates (id, first_pet, second_pet, first_owner, second_owner, first_generation, second_generation,
        first_epoch, second_epoch, acquaintance, opener_pet, topic, created_at, expires_at, share_code, share_hash)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?), 0) = ?
          AND COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?), 0) = ?
          AND NOT EXISTS (SELECT 1 FROM debates WHERE status = 'invited' AND expires_at > ?
            AND ((first_pet = ? AND second_pet = ?) OR (first_pet = ? AND second_pet = ?)))`).bind(
        id, body.firstPet, body.secondPet, first.owner_id, second.owner_id,
        first.transfer_generation, second.transfer_generation, firstEpoch, secondEpoch, acquaintance, body.openerPet, body.topic, now, expires, code, hash,
        body.firstPet, firstEpoch, body.secondPet, secondEpoch, now,
        body.firstPet, body.secondPet, body.secondPet, body.firstPet),
      c.env.DB.prepare(`INSERT INTO debate_consents (debate_id, pet_id, owner_id, decision, decided_at)
        SELECT ?, ?, ?, 'accepted', ? WHERE EXISTS (SELECT 1 FROM debates WHERE id = ?)`)
        .bind(id, body.firstPet, first.owner_id, now, id),
    ]);
    if (inserted[0]!.meta.changes !== 1) {
      const existing = await c.env.DB.prepare(`SELECT 1 FROM debates WHERE status = 'invited' AND expires_at > ?
        AND ((first_pet = ? AND second_pet = ?) OR (first_pet = ? AND second_pet = ?)) LIMIT 1`)
        .bind(now, body.firstPet, body.secondPet, body.secondPet, body.firstPet).first();
      return c.json({ code: existing === null ? 'memory_cleared' : 'open_pair_invitation' }, 409);
    }
    await recordDebateEvent(c.env, { name: 'debate_invited', id, firstPet: body.firstPet, secondPet: body.secondPet, at: now });
    return c.json({ id, status: 'invited', expiresAt: expires, ...detail }, 201);
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
}

debateRoutes.post('/api/debates/eligibility', (c) => invitation(c, false));
debateRoutes.post('/api/debates', (c) => invitation(c, true));

/** Owner-only known pair discovery; the invitation route rechecks every pair at the tap. */
debateRoutes.get('/api/pets/:petId/debates/partners', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const petId = c.req.param('petId');
  if (!TOKEN_ID.test(petId) || BigInt(petId) > MAX_U64) return c.json({ code: 'bad_request' }, 400);
  try {
    const owned = await petView(c.env, petId);
    if (owned === null) return c.json({ code: 'no_pet' }, 404);
    if (owned.owner_id !== session.accountId) return c.json({ code: 'not_owner' }, 403);
    const knownRows = await c.env.DB.prepare('SELECT other_id FROM society_relations WHERE token_id = ?')
      .bind(petId).all<{ other_id: string }>();
    const ids = [...new Set([...knownRows.results.map((row) => row.other_id), ...(owned.work_known ?? [])])]
      .filter((id) => id !== petId && TOKEN_ID.test(id) && BigInt(id) <= MAX_U64);
    const partners: Array<{ tokenId: string; name: string }> = [];
    for (const id of ids) {
      const other = await petView(c.env, id);
      if (other === null || other.owner_id === owned.owner_id) continue;
      if (await proof(c.env, petId, id, owned.owner_id, other.owner_id, owned, other))
        partners.push({ tokenId: id, name: other.name });
    }
    partners.sort((a, b) => a.name.localeCompare(b.name) || a.tokenId.localeCompare(b.tokenId));
    const fresh = await petView(c.env, petId);
    if (fresh === null || fresh.owner_id !== session.accountId || fresh.transfer_generation !== owned.transfer_generation)
      return c.json({ code: 'not_owner' }, 403);
    return c.json({ partners });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
});

/** Discover only opaque pointers. The existing private read supplies the card after its own fresh check. */
debateRoutes.get('/api/pets/:petId/debates/incoming', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const petId = c.req.param('petId');
  if (!TOKEN_ID.test(petId) || BigInt(petId) > MAX_U64) return c.json({ code: 'bad_request' }, 400);
  try {
    const invitedPet = await petView(c.env, petId);
    if (invitedPet === null) return c.json({ code: 'no_pet' }, 404);
    if (invitedPet.owner_id !== session.accountId) return c.json({ code: 'not_owner' }, 403);
    const candidates = await c.env.DB.prepare("SELECT * FROM debates WHERE second_pet = ? AND status = 'invited' AND expires_at > ? ORDER BY created_at DESC LIMIT 50")
      .bind(petId, Date.now()).all<DebateRow>();
    const ids: string[] = [];
    for (const row of candidates.results) {
      if (row.second_generation !== invitedPet.transfer_generation || row.second_owner !== invitedPet.owner_id) continue;
      const firstPet = await petView(c.env, row.first_pet);
      if (firstPet === null || firstPet.transfer_generation !== row.first_generation || firstPet.owner_id !== row.first_owner) continue;
      if (await originalProof(c.env, row, firstPet, invitedPet)) ids.push(row.id);
    }
    const stillInvitedPet = await petView(c.env, petId);
    if (stillInvitedPet === null || stillInvitedPet.owner_id !== session.accountId ||
      stillInvitedPet.transfer_generation !== invitedPet.transfer_generation) return c.json({ code: 'not_owner' }, 403);
    return c.json({ ids });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
});

/** Owner-only record pointers let a reloaded Pet page recover its invitation status. */
debateRoutes.get('/api/pets/:petId/debates', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const petId = c.req.param('petId');
  if (!TOKEN_ID.test(petId) || BigInt(petId) > MAX_U64) return c.json({ code: 'bad_request' }, 400);
  try {
    const owned = await petView(c.env, petId);
    if (owned === null) return c.json({ code: 'no_pet' }, 404);
    if (owned.owner_id !== session.accountId) return c.json({ code: 'not_owner' }, 403);
    const rows = await c.env.DB.prepare('SELECT * FROM debates WHERE first_pet = ? OR second_pet = ? ORDER BY created_at DESC LIMIT 50')
      .bind(petId, petId).all<DebateRow>();
    const records: Array<{ id: string; status: DebateStatus; side: 'proposer' | 'recipient'; at: number; retained?: boolean }> = [];
    for (const row of rows.results) {
      const first = row.first_pet === petId ? owned : await petView(c.env, row.first_pet);
      const second = row.second_pet === petId ? owned : await petView(c.env, row.second_pet);
      if (first === null || second === null || !(await originalProof(c.env, row, first, second))) continue;
      if (row.status === 'invited' && (row.expires_at <= Date.now() ||
        first.transfer_generation !== row.first_generation || second.transfer_generation !== row.second_generation)) continue;
      records.push({ id: row.id, status: row.status, side: row.first_pet === petId ? 'proposer' : 'recipient', at: row.created_at,
        ...(owned.owner_id !== (row.first_pet === petId ? row.first_owner : row.second_owner) ? { retained: true } : {}) });
    }
    const ended = await c.env.DB.prepare('SELECT id, first_pet, second_pet, reason, ended_at FROM debate_ended_invites WHERE first_pet = ? OR second_pet = ? ORDER BY ended_at DESC LIMIT 50')
      .bind(petId, petId).all<{ id: string; first_pet: string; second_pet: string; reason: 'declined' | 'expired' | 'gift' | 'cleared'; ended_at: number }>();
    for (const row of ended.results) {
      const first = row.first_pet === petId ? owned : await petView(c.env, row.first_pet);
      const second = row.second_pet === petId ? owned : await petView(c.env, row.second_pet);
      if (first === null || second === null || !(await proof(c.env, row.first_pet, row.second_pet,
        first.owner_id, second.owner_id, first, second))) continue;
      records.push({ id: row.id, status: row.reason,
        side: row.first_pet === petId ? 'proposer' : 'recipient', at: row.ended_at });
    }
    const fresh = await petView(c.env, petId);
    if (fresh === null || fresh.owner_id !== session.accountId || fresh.transfer_generation !== owned.transfer_generation)
      return c.json({ code: 'not_owner' }, 403);
    records.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    return c.json({ records: records.map(({ at: _at, ...record }) => record) });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
});

async function load(db: D1Database, id: string): Promise<DebateRow | null> {
  return db.prepare('SELECT * FROM debates WHERE id = ?').bind(id).first<DebateRow>();
}

async function closeInvitation(db: D1Database, id: string, reason: 'gift' | 'expired' | 'declined', now: number): Promise<boolean> {
  const result = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO debate_ended_invites (id, first_pet, second_pet, reason, ended_at)
      SELECT id, first_pet, second_pet, ?, ? FROM debates WHERE id = ? AND status = 'invited'`).bind(reason, now, id),
    db.prepare("DELETE FROM debate_consents WHERE debate_id IN (SELECT id FROM debates WHERE id = ? AND status = 'invited')").bind(id),
    db.prepare("DELETE FROM debates WHERE id = ? AND status = 'invited'").bind(id),
  ]);
  return result[2]!.meta.changes > 0;
}

async function expire(db: D1Database, row: DebateRow, now: number): Promise<boolean> {
  if (row.status !== 'invited' || now < row.expires_at) return false;
  await closeInvitation(db, row.id, 'expired', now);
  return true;
}

/** The minute cron removes expired invitation words even when neither owner has the tab open. */
export async function expireDueInvitations(db: D1Database, now: number): Promise<void> {
  const due = await db.prepare("SELECT id FROM debates WHERE status = 'invited' AND expires_at <= ? ORDER BY expires_at LIMIT 100")
    .bind(now).all<{ id: string }>();
  for (const row of due.results) await closeInvitation(db, row.id, 'expired', now);
}

debateRoutes.post('/api/debates/:id/decision', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id');
  const body = await bodyOf(c);
  if (!ID.test(id) || !sameBody(body, ['decision']) || !['accept', 'decline'].includes(body.decision)) return c.json({ code: 'bad_request' }, 400);
  const pointer = await c.env.DB.prepare(`SELECT first_pet, second_pet FROM debates WHERE id = ?
    UNION ALL SELECT first_pet, second_pet FROM debate_ended_invites WHERE id = ? LIMIT 1`).bind(id, id)
    .first<{ first_pet: string; second_pet: string }>();
  if (pointer === null) return c.json({ code: 'no_debate' }, 404);
  let pets: [PetRecord, PetRecord] | null;
  try {
    pets = await pair(c.env, pointer.first_pet, pointer.second_pet);
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
  if (pets === null) return c.json({ code: 'no_pet' }, 404);
  if (pets[1].owner_id !== session.accountId) return c.json({ code: 'not_owner' }, 403);
  const row = await load(c.env.DB, id);
  if (row === null) {
    const ended = await c.env.DB.prepare('SELECT reason FROM debate_ended_invites WHERE id = ?').bind(id)
      .first<{ reason: string }>();
    if (ended === null) return c.json({ code: 'no_debate' }, 404);
    return ended.reason === 'declined' && body.decision === 'decline'
      ? c.json({ id, status: 'declined' }) : c.json({ code: ended.reason }, 409);
  }
  try {
    const [first, second] = pets;
    if (!(await originalProof(c.env, row, first, second))) return c.json({ code: 'unknown_pair' }, 409);
    if (first.owner_id !== row.first_owner || second.owner_id !== row.second_owner ||
      first.transfer_generation !== row.first_generation || second.transfer_generation !== row.second_generation) {
      await closeInvitation(c.env.DB, id, 'gift', Date.now());
      return c.json({ code: 'gift' }, 409);
    }
    if (await expire(c.env.DB, row, Date.now())) return c.json({ code: 'expired' }, 409);
    if (row.status !== 'invited') {
      // Repeating the same consent never starts a second call, even after the first turn advanced.
      return body.decision === 'accept' && row.accepted_at !== null
        ? c.json({ id, status: 'accepted', code: row.share_code }) : c.json({ code: row.status }, 409);
    }
    if (body.decision === 'accept' && (BigInt(first.project_food) + BigInt(first.given_food) <= 0n ||
      BigInt(second.project_food) + BigInt(second.given_food) <= 0n)) return c.json({ code: 'asleep' }, 409);
    const now = Date.now();
    const next = body.decision === 'accept' ? 'accepted' : 'declined';
    if (next === 'declined') {
      if (!(await closeInvitation(c.env.DB, id, 'declined', now))) return c.json({ code: 'decision_conflict' }, 409);
      return c.json({ id, status: 'declined' });
    }
    const updated = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE debates SET status = ?, accepted_at = ?, ended_at = ? WHERE id = ? AND status = 'invited' AND expires_at > ?`)
        .bind('accepted', now, null, id, now),
      c.env.DB.prepare(`INSERT INTO debate_consents (debate_id, pet_id, owner_id, decision, decided_at)
        SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM debates WHERE id = ? AND status = ? AND accepted_at IS ? AND ended_at IS ?)`)
        .bind(id, row.second_pet, session.accountId, 'accepted', now, id, 'accepted', now, null),
    ]);
    if (updated[0]!.meta.changes === 0) return c.json({ code: 'decision_conflict' }, 409);
    await recordDebateEvent(c.env, { name: 'debate_accepted', id, firstPet: row.first_pet, secondPet: row.second_pet, at: now });
    c.executionCtx.waitUntil(runDebateTurn(c.env, id));
    return c.json({ id, status: 'accepted', code: row.share_code });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
});

function publicLines(lines: LineRow[]) {
  return lines.map((line) => ({ order: line.line_order, speakerPet: line.speaker_pet, status: line.status,
    text: debateLineText(line.text, line.line_order), requestBytes: line.status === 'settled' ? line.request_bytes : null,
    responseBytes: line.status === 'settled' ? line.response_bytes : null,
    signedCall: line.status === 'settled' ? line.signed_call : null,
    receiptTxHash: line.status === 'settled' ? line.receipt_tx_hash : null,
    priceYocto: line.price_yocto, nearUsdRate: line.status === 'settled' ? line.near_usd_rate : null }));
}

debateRoutes.post('/api/debates/:id/stop', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id');
  const body = await bodyOf(c);
  if (!ID.test(id) || !sameBody(body, [])) return c.json({ code: 'bad_request' }, 400);
  const row = await load(c.env.DB, id);
  if (row === null) return c.json({ code: 'no_debate' }, 404);
  try {
    const pets = await pair(c.env, row.first_pet, row.second_pet);
    if (pets === null) return c.json({ code: 'no_pet' }, 404);
    if (pets[0].owner_id !== session.accountId && pets[1].owner_id !== session.accountId) return c.json({ code: 'not_owner' }, 403);
    if (pets[0].transfer_generation !== row.first_generation || pets[1].transfer_generation !== row.second_generation)
      return c.json({ code: 'gift' }, 409);
    const stopped = await c.env.DB.prepare(`UPDATE debates SET status = 'stopped', end_reason = 'stopped', ended_at = ?
      WHERE id = ? AND status IN ('accepted', 'running') AND lease_until IS NULL
      AND NOT EXISTS (SELECT 1 FROM debate_lines WHERE debate_id = ? AND status IN ('pending', 'receipt_pending'))`)
      .bind(Date.now(), id, id).run();
    if (stopped.meta.changes === 1) {
      await recordDebateEvent(c.env, { name: 'debate_ended', id, firstPet: row.first_pet, secondPet: row.second_pet,
        reason: 'stopped' });
      return c.json({ id, status: 'stopped' });
    }
    return c.json({ code: 'turn_in_flight' }, 409);
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
});

debateRoutes.post('/api/debates/events', async (c) => {
  const body = await bodyOf(c);
  if (!sameBody(body, ['eventId', 'tabId', 'debateId', 'name']) ||
      !['debate_link_opened', 'debate_receipt_opened'].includes(body.name) ||
      !/^[0-9a-f]{64}$/.test(body.debateId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.eventId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.tabId))
    return c.json({ code: 'bad_request' }, 400);
  await recordDebateOpen(c.env, { eventId: body.eventId, tabId: body.tabId, debateId: body.debateId,
    name: body.name as 'debate_link_opened' | 'debate_receipt_opened', ip: c.req.header('cf-connecting-ip') ?? 'unknown' });
  return c.body(null, 204);
});

debateRoutes.post('/api/debates/line/bytes', async (c) => {
  const body = await bodyOf(c);
  if (body === null || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'code,order' ||
      typeof (body as { code?: unknown }).code !== 'string' || !CODE.test((body as { code: string }).code) ||
      !Number.isInteger((body as { order?: unknown }).order) || Number((body as { order: number }).order) < 1 || Number((body as { order: number }).order) > 4)
    return c.json({ code: 'bad_request' }, 400);
  const input = body as { code: string; order: number };
  const hash = await sha256(input.code);
  const row = await c.env.DB.prepare(`SELECT * FROM debates WHERE share_hash = ? AND status IN
    ('accepted', 'running', 'completed', 'stopped', 'refused', 'unavailable', 'gift')`).bind(hash).first<DebateRow>();
  if (row === null) return c.json({ code: 'no_debate' }, 404);
  const consent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM debate_consents WHERE debate_id = ? AND decision = 'accepted'")
    .bind(row.id).first<{ n: number }>();
  if (consent?.n !== 2) return c.json({ code: 'no_debate' }, 404);
  const line = await c.env.DB.prepare(`SELECT * FROM debate_lines WHERE debate_id = ? AND line_order = ?
    AND status = 'settled' AND receipt_tx_hash IS NOT NULL`).bind(row.id, input.order).first<LineRow>();
  if (line === null || line.request_bytes === null || line.response_bytes === null || line.signed_call === null || line.receipt_tx_hash === null)
    return c.json({ code: 'no_line' }, 404);
  try {
    if (!await intactDebateBytes(line.request_bytes, line.response_bytes, line.signed_call) ||
        !await matchingDebateReceipt(c.env, row.id, input.order, line.speaker_pet, line.price_yocto ?? '', line.signed_call, line.receipt_tx_hash))
      return c.json({ code: 'receipt_unavailable' }, 409);
    // Re-read after the chain call: Clear memory may have deleted the row while it waited.
    const fresh = await c.env.DB.prepare(`SELECT l.request_bytes, l.response_bytes, l.signed_call, l.receipt_tx_hash, l.price_yocto
      FROM debate_lines l JOIN debates d ON d.id = l.debate_id
      WHERE d.share_hash = ? AND l.line_order = ? AND l.status = 'settled'`).bind(hash, input.order)
      .first<Pick<LineRow, 'request_bytes' | 'response_bytes' | 'signed_call' | 'receipt_tx_hash' | 'price_yocto'>>();
    return fresh === null ? c.json({ code: 'no_debate' }, 404) : c.json({ id: row.id, order: input.order, ...fresh });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
});

debateRoutes.post('/api/debates/read', async (c) => {
  const body = await bodyOf(c);
  if (!sameBody(body, ['id']) && !sameBody(body, ['code'])) return c.json({ code: 'bad_request' }, 400);
  const byCode = 'code' in body;
  if (byCode ? !CODE.test(body.code) : !ID.test(body.id)) return c.json({ code: 'bad_request' }, 400);
  let verifiedPets: [PetRecord, PetRecord] | null = null;
  if (!byCode) {
    const session = requireSession(c);
    if (session instanceof Response) return session;
    // Only the pair pointer is read before the fresh owner check. The topic and consent stay sealed.
    const pointer = await c.env.DB.prepare(`SELECT first_pet, second_pet FROM debates WHERE id = ?
      UNION ALL SELECT first_pet, second_pet FROM debate_ended_invites WHERE id = ? LIMIT 1`).bind(body.id, body.id)
      .first<{ first_pet: string; second_pet: string }>();
    if (pointer === null) return c.json({ code: 'no_debate' }, 404);
    try {
      verifiedPets = await pair(c.env, pointer.first_pet, pointer.second_pet);
    } catch (error) {
      if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
      throw error;
    }
    if (verifiedPets === null) return c.json({ code: 'no_pet' }, 404);
    if (verifiedPets[0].owner_id !== session.accountId && verifiedPets[1].owner_id !== session.accountId)
      return c.json({ code: 'not_owner' }, 403);
  }
  const shareHash = byCode ? await sha256(body.code) : null;
  const row = byCode ? await c.env.DB.prepare('SELECT * FROM debates WHERE share_hash = ?').bind(shareHash).first<DebateRow>()
    : await load(c.env.DB, body.id);
  if (row === null) {
    if (byCode) {
      // A revoked code is never a public capability. Only a fresh current owner
      // may recover the fixed ended reason; no words or code leave this lookup.
      const session = c.get('session');
      if (session === null) return c.json({ code: 'no_debate' }, 404);
      const ended = await c.env.DB.prepare(`SELECT id, first_pet, second_pet FROM debate_ended_invites
        WHERE share_hash = ? AND reason = 'cleared' AND clear_during_line = 1`).bind(shareHash)
        .first<{ id: string; first_pet: string; second_pet: string }>();
      if (ended === null) return c.json({ code: 'no_debate' }, 404);
      let pets: [PetRecord, PetRecord] | null;
      try {
        pets = await pair(c.env, ended.first_pet, ended.second_pet);
        if (pets === null || (pets[0].owner_id !== session.accountId && pets[1].owner_id !== session.accountId))
          return c.json({ code: 'no_debate' }, 404);
      } catch (error) {
        if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
        throw error;
      }
      return c.json({ id: ended.id, status: 'cleared', endReason: 'memory_clear',
        firstPet: { tokenId: ended.first_pet, name: pets[0].name }, secondPet: { tokenId: ended.second_pet, name: pets[1].name } });
    }
    const ended = await c.env.DB.prepare('SELECT reason, clear_during_line FROM debate_ended_invites WHERE id = ?').bind(body.id)
      .first<{ reason: 'gift' | 'expired' | 'cleared'; clear_during_line: number }>();
    return ended === null ? c.json({ code: 'no_debate' }, 404) : c.json({ id: body.id, status: ended.reason,
      ...(ended.reason === 'cleared' && ended.clear_during_line === 1 ? { endReason: 'memory_clear' } : {}) });
  }
  if (await expire(c.env.DB, row, Date.now()))
    return byCode ? c.json({ code: 'no_debate' }, 404) : c.json({ id: row.id, status: 'expired' });
  const current = row;
  const consentCount = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM debate_consents WHERE debate_id = ? AND decision = 'accepted'")
    .bind(row.id).first<{ n: number }>();
  const published = consentCount?.n === 2;
  if (byCode && (!published || !['accepted', 'running', 'completed', 'stopped', 'refused', 'unavailable', 'gift'].includes(current.status)))
    return c.json({ code: 'no_debate' }, 404);
  try {
    if (!byCode) {
      const pets = verifiedPets!;
      if (!(await originalProof(c.env, row, pets[0], pets[1]))) return c.json({ code: 'unknown_pair' }, 409);
      if (current.status === 'invited' && (pets[0].transfer_generation !== row.first_generation || pets[1].transfer_generation !== row.second_generation)) {
        await closeInvitation(c.env.DB, row.id, 'gift', Date.now());
        return c.json({ id: row.id, status: 'gift' });
      }
    }
    const [first, second] = await pair(c.env, row.first_pet, row.second_pet) ?? [null, null];
    if (first === null || second === null) return c.json({ code: 'no_pet' }, 404);
    const lines = await c.env.DB.prepare('SELECT * FROM debate_lines WHERE debate_id = ? ORDER BY line_order').bind(row.id).all<LineRow>();
    const consents = byCode ? null : await c.env.DB.prepare('SELECT pet_id, decision FROM debate_consents WHERE debate_id = ?').bind(row.id)
      .all<{ pet_id: string; decision: string }>();
    const analyticsId = await opaqueDebateId(row.id);
    if (!byCode) {
      const freshOwners = await pair(c.env, row.first_pet, row.second_pet);
      const session = c.get('session');
      if (freshOwners === null || session === null ||
        (freshOwners[0].owner_id !== session.accountId && freshOwners[1].owner_id !== session.accountId))
        return c.json({ code: 'not_owner' }, 403);
    }
    // Every awaited chain or row read above can overlap Clear memory. The final D1
    // lookup is after them, so a removed row or revoked code cannot release saved words.
    const active = await load(c.env.DB, row.id);
    if (active === null || (byCode && (active.share_hash !== shareHash ||
      !['accepted', 'running', 'completed', 'stopped', 'refused', 'unavailable', 'gift'].includes(active.status))))
      return c.json({ code: 'no_debate' }, 404);
    const shared: DebateReadResponse = { id: row.id, analyticsId, status: active.status, topic: row.topic,
      firstPet: { tokenId: row.first_pet, name: first.name }, secondPet: { tokenId: row.second_pet, name: second.name },
      openerPet: row.opener_pet, maxPerPetNear: MAX_PER_PET, estimatePerPetCents: estimatePerPetCents(c.env),
      endReason: active.end_reason ?? null, lines: publicLines(lines.results) };
    if (byCode) return c.json(shared);
    return c.json({ ...shared, consents: consents!.results.map((entry) => ({ petId: entry.pet_id, decision: entry.decision })),
      expiresAt: row.expires_at, ...(published ? { code: row.share_code } : {}) });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
});
