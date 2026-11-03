// Who a pet may hire in a turn (`Hire eligibility rule`, `Known pets rule`, `Hire request data`): the pets it knows,
// read from the contract, each checked against the rules, at most three drawn, skilled first. The pet's own facts
// (awake, full after the fee, the fee covered by food that is given or earned, the cap) are checked once for the
// turn; each worker's (another owner, awake, energy, a place in its day, the Auto limit) once per candidate. The same
// checks run again when the hire is made, since the world moves between the decision and the call.
import { ChainUnreachable, petKnows, petView, tokenIdsOf, type PetRecord } from '../chain';
import { utcDay } from '../http';
import { energyLeft, readLife } from '../pet/life';
import { foodState, type FoodState } from '../pet/view';
import { fullness, HIRE_AUTO_LIMIT_YOCTO, minCallPrice, TYPICAL_IN } from '../pricing';
import type { CandidateLine } from '../prompt';
import { priceOf } from './quote';
import type { HireMode } from './mode';

/** How many known pets a turn reads, and how many it offers. */
const READ_LIMIT = 12;
const OFFER_LIMIT = 3;
/** How long a turn waits for its candidates; a build choice, not a spec value (it keeps a no-hire turn near its usual time). */
export const CANDIDATES_DEADLINE_MS = 1_000;

/** The pet that may hire, with what the checks read of it. */
export interface Hirer {
  tokenId: string;
  pet: PetRecord;
  food: FoodState;
}

export interface Candidate extends CandidateLine {
  tokenId: string;
  /** Server side only: it never goes into a request (`Hire request data`). */
  name: string;
  pet: PetRecord;
  skilled: boolean;
  /** What this pet's fee is now. */
  price: bigint;
}

/** What of the hirer's food can pay a pet's fee: the contract's given and earned food, less what the unbilled spend
 * will take out of it (pet-kind fees first, then whatever the unbilled thoughts and player-kind fees leave after the
 * project's food), less purchases held. The starter food and snacks are the project's and never pay a hire. */
export async function givenRoom(db: D1Database, tokenId: string, pet: PetRecord, held: bigint): Promise<bigint> {
  const [thoughts, hires] = await db.batch<{ yocto: string; kind?: string }>([
    db.prepare("SELECT price_yocto AS yocto FROM thoughts t WHERE token_id = ? AND status = 'unbilled' AND NOT EXISTS (SELECT 1 FROM hires h WHERE h.answer_thought_id = t.id AND h.status = 'unbilled')").bind(tokenId),
    db
      .prepare("SELECT fee_yocto AS yocto, kind FROM hires h WHERE hirer_id = ? AND status = 'unbilled' AND EXISTS (SELECT 1 FROM thoughts t WHERE t.id = h.answer_thought_id AND t.status = 'unbilled')")
      .bind(tokenId),
  ]);
  let others = (thoughts?.results ?? []).reduce((sum, r) => sum + BigInt(r.yocto), 0n);
  let petFees = 0n;
  for (const h of hires?.results ?? []) {
    if (h.kind === 'pet') petFees += BigInt(h.yocto);
    else others += BigInt(h.yocto);
  }
  const project = BigInt(pet.project_food);
  const fromGiven = petFees + (others > project ? others - project : 0n);
  const room = BigInt(pet.given_food) - fromGiven - held;
  return room > 0n ? room : 0n;
}

/** The turn's own checks: awake, full, and a day's cap that is not spent. Nothing here depends on a worker. */
export function hirerMayHire(hirer: Hirer): boolean {
  return fullness(hirer.food.eff).state === 'full';
}

export type WorkerCheck =
  | { ok: true; price: bigint; skilled: boolean; label: string | null }
  | { ok: false; why: 'gone' | 'same_owner' | 'asleep' | 'no_energy' | 'full_day' | 'over_limit' | 'no_given_food' | 'not_full' | 'over_cap' | 'data_failed' };

/** A worker's fit for a hire by `hirer` at `now`. `mode` says whether the Auto limit applies. */
export async function checkWorker(env: Env, hirer: Hirer, workerId: string, worker: PetRecord | null, mode: HireMode, now: number): Promise<WorkerCheck> {
  if (worker === null) return { ok: false, why: 'gone' };
  if (worker.owner_id === hirer.pet.owner_id) return { ok: false, why: 'same_owner' };
  const today = utcDay(now);
  if (fullness((await foodState(env.DB, workerId, worker, now)).eff).state === 'asleep') return { ok: false, why: 'asleep' };
  if (energyLeft(await readLife(env.DB, workerId), today) === 0) return { ok: false, why: 'no_energy' };
  const quote = await priceOf(env, workerId, today);
  if (!quote.open) return { ok: false, why: 'full_day' };
  const price = quote.yocto;
  if (mode === 'auto' && price > HIRE_AUTO_LIMIT_YOCTO) return { ok: false, why: 'over_limit' };
  // A worker whose data failed in a job today is out of Auto until 00:00 UTC; a Manual offer ignores the mark
  // (`Data source call data` › «a failed worker in Auto»).
  if (mode === 'auto' && (await env.DB.prepare('SELECT 1 AS found FROM worker_answers WHERE token_id = ? AND day = ? AND data_failed = 1').bind(workerId, today).first()) !== null) {
    return { ok: false, why: 'data_failed' };
  }
  if (price > (await givenRoom(env.DB, hirer.tokenId, hirer.pet, hirer.food.held))) return { ok: false, why: 'no_given_food' };
  // After the fee the pet is still full by all its food, with the purchases held counted out.
  if (fullness(hirer.food.room > price ? hirer.food.room - price : 0n).state !== 'full') return { ok: false, why: 'not_full' };
  // The fee and the turn's own reply fit what the day's cap leaves.
  if (price + minCallPrice(env, TYPICAL_IN) > hirer.food.capLeft) return { ok: false, why: 'over_cap' };
  const skill = await env.DB.prepare('SELECT label FROM skills WHERE token_id = ?').bind(workerId).first<{ label: string }>();
  return { ok: true, price, skilled: skill !== null, label: skill?.label ?? null };
}

const shuffled = <T>(items: T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/** The known pets of `hirer` that may be hired now: the pets of the feeders (each account confirmed by the
 * contract's `pet_knows`) and the pets met through work (`pet_view.work_known`), without the hirer's owner's, at most
 * 12 read, at most 3 drawn, skilled first. A chain that cannot be read leaves none: the turn is the ordinary one. */
export async function findCandidates(env: Env, hirer: Hirer, mode: HireMode, now: number): Promise<Candidate[]> {
  if (!hirerMayHire(hirer)) return [];
  // A turn with no hire waits no longer than usual (`Pet hire flow`): the reads of up to 12 known pets share one
  // deadline, and past it the turn is the ordinary one. The reads left behind finish and are dropped.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<Candidate[]>((resolve) => {
    timer = setTimeout(() => {
      console.log('candidates_late');
      resolve([]);
    }, CANDIDATES_DEADLINE_MS);
  });
  try {
    return await Promise.race([readCandidates(env, hirer, mode, now), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function readCandidates(env: Env, hirer: Hirer, mode: HireMode, now: number): Promise<Candidate[]> {
  let ids: string[];
  try {
    const feeders = await env.DB.prepare('SELECT account FROM known_index WHERE token_id = ? ORDER BY rowid DESC LIMIT ?').bind(hirer.tokenId, READ_LIMIT).all<{ account: string }>();
    const accounts = feeders.results.map((r) => r.account).filter((a) => a !== hirer.pet.owner_id);
    const confirmed = (await Promise.all(accounts.map(async (a) => ((await petKnows(env, hirer.tokenId, a)) ? a : null)))).filter((a): a is string => a !== null);
    const fromFeeders = (await Promise.all(confirmed.map((a) => tokenIdsOf(env, a, READ_LIMIT)))).flat();
    ids = [...new Set([...fromFeeders, ...(hirer.pet.work_known ?? [])])].filter((id) => id !== hirer.tokenId).slice(0, READ_LIMIT);
    // Read and checked side by side: a turn with a hire to weigh waits no longer than the slowest of them.
    const checked = await Promise.all(
      ids.map(async (id) => {
        const pet = await petView(env, id);
        return { id, pet, check: await checkWorker(env, hirer, id, pet, mode, now) };
      }),
    );
    const fit: Candidate[] = [];
    for (const { id, pet, check } of checked) {
      if (check.ok && pet !== null) fit.push({ tokenId: id, name: pet.name, pet, character: pet.character, label: check.label, skilled: check.skilled, price: check.price });
    }
    return [...shuffled(fit.filter((c) => c.skilled)), ...shuffled(fit.filter((c) => !c.skilled))].slice(0, OFFER_LIMIT);
  } catch (e) {
    if (e instanceof ChainUnreachable) return [];
    throw e;
  }
}
