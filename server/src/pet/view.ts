// What the server shows of a pet: its food after the thoughts the network has not seen yet, and the
// fullness from it. The same numbers for every viewer (Pet food data).
import type { PetRecord } from '../chain';
import { utcDay } from '../http';
import { memoryEpoch } from './forget';
import { DAILY_CAP_YOCTO, deepEstimate, deepEstimateUsd12, fullness, minCallPrice, type Fullness, type PriceEnv } from '../pricing';

/** The exact prices of the thoughts answered but not yet debited on the network, summed. Their
 * reserves (a call in flight) are not here: the fullness does not count them. */
export async function unbilledYocto(db: D1Database, tokenId: string): Promise<bigint> {
  const rows = await db
    .prepare("SELECT price_yocto FROM thoughts WHERE token_id = ? AND status = 'unbilled'")
    .bind(tokenId)
    .all<{ price_yocto: string }>();
  return rows.results.reduce((sum, row) => sum + BigInt(row.price_yocto), 0n);
}

/** Food in the contract (the project's and the given) minus the unbilled thoughts. */
export function effectiveFood(pet: PetRecord, unbilled: bigint): bigint {
  return BigInt(pet.project_food) + BigInt(pet.given_food) - unbilled;
}

export async function fullnessOf(db: D1Database, tokenId: string, pet: PetRecord): Promise<Fullness> {
  return fullness(effectiveFood(pet, await unbilledYocto(db, tokenId)));
}

/** True while the owner has not sent a line of their own: the conversation they see has no player
 * line (the input hint «Say hi to {name}…»). Decided here, not by the client from the log. */
export async function hello(db: D1Database, tokenId: string): Promise<boolean> {
  const row = await db
    // An erased reply still says the owner wrote: a clear leaves the hint at «Talk to…», not «Say hi to…».
    .prepare("SELECT 1 AS found FROM thoughts WHERE token_id = ? AND (player_text IS NOT NULL OR (erased_at IS NOT NULL AND kind IN ('reply', 'deep'))) LIMIT 1")
    .bind(tokenId)
    .first<{ found: number }>();
  return row === null;
}

// ---------------------------------------------------------------------------------------------
// The pet's money as the server counts it: the food after the thoughts the network has not seen,
// and what the daily cap leaves (Pet food data, Daily cap rule).

export interface FoodState {
  /** Food in the contract minus the unbilled thoughts (can be negative only by a defect). */
  eff: bigint;
  unbilled: bigint;
  /** The daily cap left: the cap, minus what the contract debited today, minus every unbilled thought
   * (also a session of yesterday whose batch will run after midnight and count in the new day). */
  capLeft: bigint;
}

export async function foodState(db: D1Database, tokenId: string, pet: PetRecord, nowMs: number): Promise<FoodState> {
  const unbilled = await unbilledYocto(db, tokenId);
  const debitedToday = pet.debit_day === utcDay(nowMs) ? BigInt(pet.debited_today) : 0n;
  const left = DAILY_CAP_YOCTO - debitedToday - unbilled;
  return { eff: effectiveFood(pet, unbilled), unbilled, capLeft: left < 0n ? 0n : left };
}

/** «Устал» holds to 00:00 UTC of the day it was written. It is written when a reply is refused or
 * cut by the cap, and by a poll that sees the cap left below even a call with no input at all (no
 * reply would pass) — so the screen does not flicker between «Устал» and an open field. */
export async function isTired(env: Env, tokenId: string, food: FoodState, nowMs: number): Promise<boolean> {
  const today = utcDay(nowMs);
  const row = await env.DB.prepare('SELECT tired_day FROM pets WHERE token_id = ?').bind(tokenId).first<{ tired_day: number | null }>();
  if (row?.tired_day != null && row.tired_day >= today) return true;
  if (food.capLeft < minCallPrice(env, 0)) {
    await markTired(env.DB, tokenId, nowMs);
    return true;
  }
  return false;
}

export async function markTired(db: D1Database, tokenId: string, nowMs: number): Promise<void> {
  await db.prepare('UPDATE pets SET tired_day = ? WHERE token_id = ?').bind(utcDay(nowMs), tokenId).run();
}

/** The «Think hard · ≈ {price}» of the owner's view: cents with two significant digits (USD is
 * fixed, §4) and the same price in yocto (the rate of NEAR moves only this). The last prompt of
 * the pet stands for the input; a pet that never thought uses 2,300. */
export async function deepPrice(env: Env & PriceEnv, tokenId: string): Promise<{ cents: number; yocto: string }> {
  const row = await env.DB.prepare(
    'SELECT c.tokens_in AS n FROM thought_calls c JOIN thoughts t ON t.id = c.thought_id WHERE t.token_id = ? ORDER BY t.created_at DESC, c.n DESC LIMIT 1',
  )
    .bind(tokenId)
    .first<{ n: number }>();
  const yocto = deepEstimate(env, row?.n ?? null);
  const usd12 = deepEstimateUsd12(env, row?.n ?? null);
  const cents = Number((Number(usd12) / 1e10).toPrecision(2));
  return { cents, yocto: yocto.toString() };
}

export interface OwnerFields {
  fullness: Fullness;
  tired: boolean;
  /** The next 00:00 UTC (ISO), while tired: «Back at {time}». */
  until?: string;
  paused: boolean;
  deepPrice: { cents: number; yocto: string };
  hello: boolean;
  /** The oldest thought on its way that the page shows (a diary is not: it writes itself at night). */
  pendingJob: string | null;
  /** the mode of that job, so a reloaded page shows «is thinking…» or «is thinking hard…» (`Thought queue data`) */
  pendingMode: 'chat' | 'deep' | null;
  /** what kind of thought it is: «Try again» of a failed one depends on it */
  pendingKind: 'reply' | 'greeting' | 'wake' | null;
  /** the owner's own line of a reply on its way: another tab, or this one after a reload, shows it */
  pendingText: string | null;
  /** the newest thought with a reply: a page that has not got it reads the conversation again */
  lastThought: string | null;
  /** How many times the memory was cleared: a tab whose number is older reads the conversation again. */
  memoryEpoch: number;
}

interface PendingRow {
  id: string;
  kind: 'reply' | 'greeting' | 'wake';
  mode: string | null;
  payload: string | null;
}

function pendingLine(row: PendingRow | null): string | null {
  if (row === null || row.kind !== 'reply' || row.payload === null) return null;
  const text = (JSON.parse(row.payload) as { text?: unknown }).text;
  return typeof text === 'string' ? text : null;
}

/** Everything only the owner is shown of the pet, from the state the caller already read. */
export async function ownerFields(env: Env, tokenId: string, pet: PetRecord, pausedNow: boolean): Promise<OwnerFields> {
  const now = Date.now();
  const food = await foodState(env.DB, tokenId, pet, now);
  const pending = await env.DB.prepare("SELECT id, kind, mode, payload FROM jobs WHERE token_id = ? AND status IN ('queued', 'running') AND kind <> 'diary' ORDER BY created_at, rowid LIMIT 1")
    .bind(tokenId)
    .first<PendingRow>();
  const last = await env.DB.prepare('SELECT id FROM thoughts WHERE token_id = ? AND reply_text IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .bind(tokenId)
    .first<{ id: string }>();
  const tired = await isTired(env, tokenId, food, now);
  return {
    fullness: fullness(food.eff),
    tired,
    ...(tired ? { until: new Date((utcDay(now) + 1) * 86_400_000).toISOString() } : {}),
    paused: pausedNow,
    deepPrice: await deepPrice(env, tokenId),
    hello: await hello(env.DB, tokenId),
    pendingJob: pending?.id ?? null,
    pendingMode: pending === null ? null : pending.mode === 'deep' ? 'deep' : 'chat',
    pendingKind: pending?.kind ?? null,
    pendingText: pendingLine(pending),
    lastThought: last?.id ?? null,
    memoryEpoch: await memoryEpoch(env.DB, tokenId),
  };
}
