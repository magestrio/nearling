// The pet's life between days (`Growth flow`, `Trait rule`, `Mood rule`, `Energy rule`): the rules as
// pure functions, the statements that count, and the seams `add-daily-ritual` and `add-pet-work`
// call (`noteDeed`, `noteFriend`, `noteMood`, `spendEnergy`). Everything here lives in D1 by token_id
// and never reaches the network (`Pet life data`); the one thing the contract learns is the trait of
// a transition, from `pet/growth.ts`.
import { ChainUnreachable, chainDay, stageOf, type PetRecord, type Trait } from '../chain';
import { utcDay } from '../http';
import { type FullnessState } from '../pricing';
import { track } from '../track';

/** A pet grows on its 2nd and 3rd counted day (`Growth flow`). */
export const LAST_COUNTED_DAY = 3;
/** Ten steps, a step is 10% of the energy and one step of the DS meter (`Energy rule`). */
export const ENERGY_STEPS = 10;

export type Mood = 'happy' | 'calm' | 'sleepy';
export type GrowthStage = 'teen' | 'adult';

/** The word of a trait in the transition line and on the owner's screen. */
export const TRAIT_WORD: Record<Trait, string> = {
  clever: 'clever',
  sociable: 'sociable',
  hard_working: 'hard-working',
  thoughtful: 'thoughtful',
  cozy: 'cozy',
};

export interface Deeds {
  riddles: number;
  friends: number;
  works: number;
  deeps: number;
}

/** The trait of a window: the most frequent deed, a tie by the order clever, sociable, hard-working,
 * thoughtful, and no deed at all is cozy (`Trait rule`). Pure: the server chooses, never the model. */
export function chooseTrait(deeds: Deeds): Trait {
  const order: [Trait, number][] = [
    ['clever', deeds.riddles],
    ['sociable', deeds.friends],
    ['hard_working', deeds.works],
    ['thoughtful', deeds.deeps],
  ];
  let best = order[0]!;
  for (const entry of order) if (entry[1] > best[1]) best = entry;
  return best[1] > 0 ? best[0] : 'cozy';
}

/** The mood of the day for a viewer (`Mood rule`): none for a sleeping pet, sleepy while hungry (over
 * the events of the day), happy after an event of today, calm otherwise. Needs no reset and no write
 * of its own: hunger and 00:00 UTC change the answer. */
export function moodOf(condition: FullnessState, moodDay: number | null, today: number): Mood | null {
  if (condition === 'asleep') return null;
  if (condition === 'hungry') return 'sleepy';
  return moodDay === today ? 'happy' : 'calm';
}

/** The steps of energy left today; another day than `energyDay` reads full. */
export function energyLeft(row: { energyDay: number | null; energyUsed: number } | null, today: number): number {
  if (row === null || row.energyDay !== today) return ENERGY_STEPS;
  return Math.max(0, ENERGY_STEPS - row.energyUsed);
}

/** The line of a transition that was written: a new trait at the teen step, a new or a strengthened
 * one at the adult step (`Growth flow`, `Trait rule` › «черта уже есть»). */
export function growthLine(stage: GrowthStage, name: string, trait: Trait, repeat: boolean): string {
  const word = TRAIT_WORD[trait];
  if (stage === 'teen') return `${name} is a teen now — and turned out ${word}!`;
  return repeat ? `${name} is all grown up — and even more ${word}!` : `${name} is all grown up — and has become ${word} too!`;
}

// ---------------------------------------------------------------------------------------------
// The state of a pet's life.

export interface LifeState {
  countedDays: number;
  /** The chain's UTC day of the last counted reply; null = only the birth day, which `stage_day` holds. */
  lastCountedDay: number | null;
  riddles: number;
  works: number;
  deeps: number;
  /** Distinct friends who fed the pet in the window. */
  friends: number;
  moodDay: number | null;
  energyDay: number | null;
  energyUsed: number;
}

interface LifeRow {
  counted_days: number;
  last_counted_day: number | null;
  riddles: number;
  works: number;
  deeps: number;
  friends: number;
  mood_day: number | null;
  energy_day: number | null;
  energy_used: number;
}

/** The life of a pet; a pet with no row has one counted day, no deeds and full energy. */
export async function readLife(db: D1Database, tokenId: string): Promise<LifeState> {
  const row = await db
    .prepare(
      'SELECT counted_days, last_counted_day, riddles, works, deeps, mood_day, energy_day, energy_used, (SELECT COUNT(*) FROM life_friends WHERE token_id = ?1) AS friends FROM pet_life WHERE token_id = ?1',
    )
    .bind(tokenId)
    .first<LifeRow>();
  if (row === null) return { countedDays: 1, lastCountedDay: null, riddles: 0, works: 0, deeps: 0, friends: 0, moodDay: null, energyDay: null, energyUsed: 0 };
  return {
    countedDays: row.counted_days,
    lastCountedDay: row.last_counted_day,
    riddles: row.riddles,
    works: row.works,
    deeps: row.deeps,
    friends: row.friends,
    moodDay: row.mood_day,
    energyDay: row.energy_day,
    energyUsed: row.energy_used,
  };
}

// ---------------------------------------------------------------------------------------------
// Counting a reply.

export interface CountPlan {
  /** The counted day this reply makes (2 or 3). */
  countedDays: number;
  /** The chain's UTC day of the reply. */
  day: number;
  /** The transition the reply starts and its trait, fixed now from the window it closes. */
  stage: GrowthStage;
  trait: Trait;
}

/** Whether a reply counts a day, and the transition it starts. The chain is read only when it can
 * matter: the pet is not adult, fewer than three days are counted and the Worker's clock says a day
 * later than the last counted one (one read per pet per day, for three days). The counted day is the
 * chain's own (`Pet life data`); a read that fails takes the Worker's clock, since a lost day would
 * be worse than a day off by seconds (ADR-008). `deep` is the reply's own deed: it counts in the
 * window it closes. */
export async function planCount(
  env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID' | 'SERVER_ACCOUNT_ID'>,
  life: LifeState,
  pet: Pick<PetRecord, 'stage' | 'stage_day'>,
  today: number,
  deep: boolean,
): Promise<CountPlan | null> {
  if (life.countedDays >= LAST_COUNTED_DAY || stageOf(pet) === 'adult') return null;
  const last = life.lastCountedDay ?? pet.stage_day;
  if (today <= last) return null;
  let day = today;
  try {
    day = await chainDay(env);
  } catch (e) {
    if (!(e instanceof ChainUnreachable)) throw e;
    console.log('chain_day_unread');
  }
  if (day <= last) return null;
  const countedDays = life.countedDays + 1;
  const trait = chooseTrait({ riddles: life.riddles, friends: life.friends, works: life.works, deeps: life.deeps + (deep ? 1 : 0) });
  return { countedDays, day, stage: countedDays === 2 ? 'teen' : 'adult', trait };
}

const ensureLife = (db: D1Database, tokenId: string) => db.prepare('INSERT OR IGNORE INTO pet_life (token_id) VALUES (?)').bind(tokenId);

/** The deed column each seam writes. */
const DEED_COLUMN = { riddle: 'riddles', work: 'works', deep: 'deeps' } as const;
export type DeedKind = keyof typeof DEED_COLUMN;

/** A deed of the window (a riddle answered, work done for others, a «Think hard» answered). Kept
 * while fewer than three days are counted: from the adult step nothing reads a deed. */
export function noteDeed(db: D1Database, tokenId: string, kind: DeedKind): D1PreparedStatement[] {
  const column = DEED_COLUMN[kind];
  return [
    ensureLife(db, tokenId),
    db.prepare(`UPDATE pet_life SET ${column} = ${column} + 1 WHERE token_id = ? AND counted_days < ${LAST_COUNTED_DAY}`).bind(tokenId),
  ];
}

/** A friend who fed the pet counts once in the window; not written from the adult step on. */
export function noteFriend(db: D1Database, tokenId: string, account: string): D1PreparedStatement[] {
  return [
    db
      .prepare(`INSERT OR IGNORE INTO life_friends (token_id, account) SELECT ?1, ?2 WHERE COALESCE((SELECT counted_days FROM pet_life WHERE token_id = ?1), 1) < ${LAST_COUNTED_DAY}`)
      .bind(tokenId, account),
  ];
}

/** An event of the day lifts the mood (`Mood rule`): the Worker's UTC day. */
export function noteMood(db: D1Database, tokenId: string, today: number): D1PreparedStatement[] {
  return [ensureLife(db, tokenId), db.prepare('UPDATE pet_life SET mood_day = ?2 WHERE token_id = ?1').bind(tokenId, today)];
}

/** One step of energy, in one statement guarded at ten: a read and then a write would race with
 * work done for another pet from another desk. `RETURNING` gives the steps used when it changed a
 * row and nothing at zero. */
function spendStep(db: D1Database, tokenId: string, today: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE pet_life SET energy_used = CASE WHEN energy_day = ?2 THEN energy_used + 1 ELSE 1 END, energy_day = ?2 WHERE token_id = ?1 AND (energy_day IS NOT ?2 OR energy_used < ${ENERGY_STEPS}) RETURNING energy_used`,
    )
    .bind(tokenId, today);
}

export interface Spent {
  spent: boolean;
  /** Steps left after this one (0 = the last was just taken, or none was left). */
  left: number;
}

/** What the `RETURNING` rows of `spendStep` say. The last step fires `energy_depleted` once. */
function spentOf(rows: { energy_used: number }[], by: 'deep' | 'work' | 'errand' | 'watch'): Spent {
  const used = rows[0]?.energy_used;
  if (used === undefined) return { spent: false, left: 0 };
  if (used >= ENERGY_STEPS) track('energy_depleted', { by });
  return { spent: true, left: Math.max(0, ENERGY_STEPS - used) };
}

/** What a reply writes in the thought's own batch (`## Решения` › Counting): the pet answered, so
 * the mood of the day, a deep reply's deed and step, and a counted day with the transition it
 * starts. The step is the last statement, so `energyOf` reads it from the batch's last result. */
export function replyStatements(
  db: D1Database,
  tokenId: string,
  a: { today: number; deep: boolean; count: CountPlan | null; now: number },
): D1PreparedStatement[] {
  const statements = [...noteMood(db, tokenId, a.today)];
  if (a.deep) statements.push(...noteDeed(db, tokenId, 'deep').slice(1));
  const count = a.count;
  if (count !== null) {
    const was = count.countedDays - 1;
    // The counted day, the transition (its trait fixed from this window) and the window's reset,
    // each guarded by the day this very reply wrote.
    const wrote = 'EXISTS (SELECT 1 FROM pet_life WHERE token_id = ?1 AND counted_days = ?2 AND last_counted_day = ?3)';
    statements.push(
      db.prepare('UPDATE pet_life SET counted_days = ?2, last_counted_day = ?3 WHERE token_id = ?1 AND counted_days = ?4').bind(tokenId, count.countedDays, count.day, was),
      db
        .prepare(`INSERT OR IGNORE INTO pending_growth (token_id, stage, trait, created_at) SELECT ?1, ?4, ?5, ?6 WHERE ${wrote}`)
        .bind(tokenId, count.countedDays, count.day, count.stage, count.trait, a.now),
      db.prepare(`UPDATE pet_life SET riddles = 0, works = 0, deeps = 0 WHERE token_id = ?1 AND counted_days = ?2 AND last_counted_day = ?3`).bind(tokenId, count.countedDays, count.day),
      db.prepare(`DELETE FROM life_friends WHERE token_id = ?1 AND ${wrote}`).bind(tokenId, count.countedDays, count.day),
    );
  }
  if (a.deep) statements.push(spendStep(db, tokenId, a.today));
  return statements;
}

/** The step a `replyStatements` batch took, from the batch's last result (a deep reply only). */
export function energyOf(last: { results: unknown[] } | undefined): Spent {
  return spentOf((last?.results ?? []) as { energy_used: number }[], 'deep');
}

/** The seam of `add-pet-work`: one step for work done for others, `spent: false` at zero (nothing
 * is taken then). */
export async function spendEnergy(db: D1Database, tokenId: string, by: 'deep' | 'work' | 'errand' | 'watch', now: number): Promise<Spent> {
  const written = await db.batch([ensureLife(db, tokenId), spendStep(db, tokenId, utcDay(now))]);
  return spentOf((written[1]?.results ?? []) as { energy_used: number }[], by);
}
