// What the server shows of a pet: its food after the thoughts the network has not seen yet, and the
// fullness from it. The same numbers for every viewer (Pet food data).
import type { PetRecord } from '../chain';
import { utcDay } from '../http';
import { memoryEpoch } from './forget';
import { DAILY_CAP_YOCTO, deepEstimate, deepEstimateUsd12, fullness, minCallPrice, nearUsdRate, OUTFIT_PRICE_YOCTO, outfitCents, type Fullness, type FullnessState, type PriceEnv } from '../pricing';
import { energyLeft, moodOf, readLife, TRAIT_WORD, type Mood } from './life';
import { noticesOf, readWardrobe, slugsOf, type OutfitSlug } from './outfits';
import { entryToday } from './ritual';
import { hireModeOf, type HireMode } from '../work/mode';
import { readOffer } from '../work/offerRead';
import { priceView } from '../work/quote';
import { skillLabel } from '../work/skill';

/** The exact prices of the thoughts answered but not yet debited on the network, summed. Their
 * reserves (a call in flight) are not here: the fullness does not count them. A hired answer is counted
 * as its fee, not its own price: the fee pays it, and the contract takes the fee (`Hire price rule`,
 * `Advice flow` › «ответ»: the paying pet's fullness is lower by the price at once). */
export async function unbilledYocto(db: D1Database, tokenId: string): Promise<bigint> {
  const [thoughts, hires] = await db.batch<{ yocto: string }>([
    db
      .prepare(
        "SELECT price_yocto AS yocto FROM thoughts t WHERE token_id = ? AND status = 'unbilled' AND NOT EXISTS (SELECT 1 FROM hires h WHERE h.answer_thought_id = t.id AND h.status = 'unbilled')",
      )
      .bind(tokenId),
    // Only while the answer is `unbilled` too: once the batch took the thought the network has the fee.
    db
      .prepare("SELECT fee_yocto AS yocto FROM hires h WHERE hirer_id = ? AND status = 'unbilled' AND EXISTS (SELECT 1 FROM thoughts t WHERE t.id = h.answer_thought_id AND t.status = 'unbilled')")
      .bind(tokenId),
  ]);
  return [...(thoughts?.results ?? []), ...(hires?.results ?? [])].reduce((sum, row) => sum + BigInt(row.yocto), 0n);
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
    .prepare("SELECT 1 AS found FROM thoughts WHERE token_id = ? AND (player_text IS NOT NULL OR (erased_at IS NOT NULL AND kind IN ('reply', 'deep', 'question'))) LIMIT 1")
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
  /** The prices of the outfit purchases whose send has gone out and has no outcome yet (`sending`,
   * `unknown`): held against the food and the cap, though the network has not taken them (`Thought
   * queue data`). The fullness does not count them. */
  held: bigint;
  /** What a new spend may use of the food: `eff` less `held`, not below zero. A thought plans and
   * prices from it; what state the pet is in is read from `eff`. */
  room: bigint;
  /** The daily cap left: the cap, minus what the contract debited today, minus every unbilled thought
   * (also a session of yesterday whose batch will run after midnight and count in the new day), minus
   * `held`. */
  capLeft: bigint;
}

/** The prices of the purchases held (see `FoodState.held`). */
export async function heldYocto(db: D1Database, tokenId: string): Promise<bigint> {
  const rows = await db
    .prepare("SELECT price_yocto FROM outfit_buys WHERE token_id = ? AND status IN ('sending', 'unknown')")
    .bind(tokenId)
    .all<{ price_yocto: string }>();
  return rows.results.reduce((sum, row) => sum + BigInt(row.price_yocto), 0n);
}

export async function foodState(db: D1Database, tokenId: string, pet: PetRecord, nowMs: number): Promise<FoodState> {
  const unbilled = await unbilledYocto(db, tokenId);
  const held = await heldYocto(db, tokenId);
  const debitedToday = pet.debit_day === utcDay(nowMs) ? BigInt(pet.debited_today) : 0n;
  const left = DAILY_CAP_YOCTO - debitedToday - unbilled - held;
  const eff = effectiveFood(pet, unbilled);
  return { eff, unbilled, held, room: eff > held ? eff - held : 0n, capLeft: left < 0n ? 0n : left };
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
  /** How many times a meal woke the pet: a page that sends a smaller number to `/state?wakes=` is told
   * of the wake (`Sleep and wake flow`); a page learns the number at load and never replays an old wake. */
  wakes: number;
  /** The face of the day (`Mood rule`): the same for every viewer; null for a pet that sleeps. */
  mood: Mood | null;
  /** The traits as words, each once, in the order gained (`Pet life display rule`: the owner's). */
  traits: string[];
  /** The steps of energy left today, 0…10 (`Energy rule`): the owner sees it always. */
  energy: number;
  /** The entry of today is there, unread, and the pet is awake: the Pet screen opens the Diary by itself
   * (`Daily ritual flow` › «встречает дневником»). */
  diaryUnread: boolean;
  /** The thought on its way (`pendingJob`) is the answer to the question of the day. */
  pendingQuestion: boolean;
  /** The outfit items the pet has on the chain, in the catalogue's order (`Wardrobe screen`). */
  outfits: OutfitSlug[];
  /** The worn item (`Outfit rule`), or none. */
  worn: OutfitSlug | null;
  /** The earned items whose notice has not been shown, in the catalogue's order (`New outfit notice screen`). */
  notices: OutfitSlug[];
  /** What «Buy · {price}» says: cents with two significant digits at the rate of NEAR, and the same
   * price in yocto. */
  outfitPrice: { cents: number; yocto: string };
  /** How the pet hires, for the switch of the Pet screen (`Hire mode rule`): the owner's only. */
  hireMode: HireMode;
  /** The Manual offer standing, with the worker's name and the price named (`Pet hire flow` › «предложение в Manual»);
   * none for a pet that sleeps (the offer goes where it is read). */
  offer: { worker: string; question: string; price: { yocto: string; cents: number } } | null;
  /** Whom the pet on its way is asking, so a reloaded page says «{name} is asking {worker}…» (`jobs.progress`). */
  pendingProgress: { asking: string } | null;
  /** How many hires of the pet are settled on the network (recorded or refused): a page that sees the number move
   * reads the conversation again, and learns «· no fee» without a reload. */
  hiresSeen: number;
  /** The pet's skill label, the owner's view of it (`Skill rule`); never the instruction. */
  skill: { label: string } | null;
}

/** The price of a bought outfit as the owner's view and the Wardrobe carry it. An empty rate is a
 * config error, as it is for `deepPrice`. */
export function outfitPrice(env: Pick<Env, 'NEAR_USD_RATE'>): { cents: number; yocto: string } {
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  if (rate === null) throw new Error('rate_missing');
  return { cents: outfitCents(rate), yocto: OUTFIT_PRICE_YOCTO.toString() };
}

interface PendingRow {
  id: string;
  // `hire`, `decline` and `finish` (`work/offer.ts`) are the pet's own reply to the owner's line, whichever way it came
  kind: 'reply' | 'greeting' | 'wake' | 'hire' | 'decline' | 'finish';
  mode: string | null;
  payload: string | null;
  progress: string | null;
}

function pendingLine(row: PendingRow | null): string | null {
  if (row === null || row.kind !== 'reply' || row.payload === null) return null;
  const text = (JSON.parse(row.payload) as { text?: unknown }).text;
  return typeof text === 'string' ? text : null;
}

/** The job is the answer to the question of the day (`jobs.payload.question` holds its UTC day). */
function isQuestion(row: PendingRow | null): boolean {
  if (row === null || row.kind !== 'reply' || row.payload === null) return false;
  return typeof (JSON.parse(row.payload) as { question?: unknown }).question === 'number';
}

/** The wake counter of the pet and the friend who made the last wake (`''`: a nameless friend; null:
 * the owner's own meal, work, or a memory that was cleared). */
export async function wakeState(db: D1Database, tokenId: string): Promise<{ wakes: number; by: string | null }> {
  const row = await db.prepare('SELECT wake_seq, wake_by FROM pets WHERE token_id = ?').bind(tokenId).first<{ wake_seq: number; wake_by: string | null }>();
  return { wakes: row?.wake_seq ?? 0, by: row?.wake_by ?? null };
}

/** Everything only the owner is shown of the pet, from the state the caller already read. */
export async function ownerFields(env: Env, tokenId: string, pet: PetRecord, pausedNow: boolean): Promise<OwnerFields> {
  const now = Date.now();
  const food = await foodState(env.DB, tokenId, pet, now);
  // An advice the pet pays for is read on the friend's page, not this one (`Advice flow`): not the owner's «is thinking…».
  const pending = await env.DB.prepare("SELECT id, kind, mode, payload, progress FROM jobs WHERE token_id = ? AND status IN ('queued', 'running') AND kind NOT IN ('diary', 'advice', 'errand') ORDER BY created_at, rowid LIMIT 1")
    .bind(tokenId)
    .first<PendingRow>();
  const last = await env.DB.prepare('SELECT id FROM thoughts WHERE token_id = ? AND reply_text IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .bind(tokenId)
    .first<{ id: string }>();
  const tired = await isTired(env, tokenId, food, now);
  const state = fullness(food.eff);
  const life = await readLife(env.DB, tokenId);
  const today = utcDay(now);
  const energy = energyLeft(life, today);
  const wardrobe = await readWardrobe(env.DB, tokenId);
  const { entry, pet: row } = await entryToday(env.DB, tokenId, now);
  const read = await env.DB.prepare('SELECT 1 AS found FROM ritual_days WHERE token_id = ? AND day = ? AND read_at IS NOT NULL').bind(tokenId, today).first();
  const offer = await readOffer(env.DB, tokenId, state.state === 'asleep');
  return {
    fullness: state,
    tired,
    // «Back at {time}» also at zero energy: both end at 00:00 UTC (`Energy rule`).
    ...(tired || energy === 0 ? { until: new Date((today + 1) * 86_400_000).toISOString() } : {}),
    paused: pausedNow,
    deepPrice: await deepPrice(env, tokenId),
    hello: await hello(env.DB, tokenId),
    pendingJob: pending?.id ?? null,
    pendingMode: pending === null ? null : pending.mode === 'deep' ? 'deep' : 'chat',
    pendingKind: pending === null ? null : pending.kind === 'hire' || pending.kind === 'decline' || pending.kind === 'finish' ? 'reply' : pending.kind,
    pendingText: pendingLine(pending),
    lastThought: last?.id ?? null,
    memoryEpoch: await memoryEpoch(env.DB, tokenId),
    wakes: (await wakeState(env.DB, tokenId)).wakes,
    mood: moodOf(state.state, life.moodDay, today),
    traits: [...new Set(pet.traits)].map((t) => TRAIT_WORD[t]),
    energy,
    diaryUnread: entry.kind === 'text' && read === null && row?.slept_at == null,
    pendingQuestion: isQuestion(pending),
    outfits: slugsOf(pet.outfits),
    worn: wardrobe.worn,
    notices: noticesOf(pet.outfits, wardrobe.seen),
    outfitPrice: outfitPrice(env),
    hireMode: await hireModeOf(env.DB, tokenId),
    offer: offer === null ? null : { worker: offer.worker, question: offer.question, price: priceView(env, offer.price) },
    pendingProgress: progressOf(pending?.progress ?? null),
    hiresSeen: (await env.DB.prepare("SELECT COUNT(*) AS n FROM hires WHERE hirer_id = ? AND status <> 'unbilled'").bind(tokenId).first<{ n: number }>())?.n ?? 0,
    skill: await skillLabel(env.DB, tokenId),
  };
}

/** `jobs.progress` as the page reads it: whom the pet is asking, or nothing. */
function progressOf(raw: string | null): { asking: string } | null {
  if (raw === null) return null;
  const asking = (JSON.parse(raw) as { asking?: unknown }).asking;
  return typeof asking === 'string' ? { asking } : null;
}

/** The mood of the day for any viewer, from the pet's fullness (`Mood rule`). The Worker's UTC day. */
export async function moodFor(db: D1Database, tokenId: string, condition: FullnessState, nowMs: number): Promise<Mood | null> {
  const row = await db.prepare('SELECT mood_day FROM pet_life WHERE token_id = ?').bind(tokenId).first<{ mood_day: number | null }>();
  return moodOf(condition, row?.mood_day ?? null, utcDay(nowMs));
}
