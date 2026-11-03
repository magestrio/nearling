// What can hold an errand at «Send» and again when its job starts (`Errand flow` › «can't pay», «out of energy»,
// «tired for today», «several blocks at once», «blocked after Send»). One function for the quote, the route and the
// desk, so the three can't disagree. The order is the spec's: services paused, food, energy, the daily cap — only the
// first that holds is told.
import type { PetRecord } from '../chain';
import { utcDay } from '../http';
import { energyLeft, readLife } from '../pet/life';
import { foodState, isTired, type FoodState } from '../pet/view';
import { fullness } from '../pricing';
import { gasIsLow, isPaused } from '../servicePause';
import { fullRead, isSearchForm, need, searchQuote, view, type ErrandForm } from './price';

export type BlockReason = 'paused' | 'food' | 'asleep' | 'energy' | 'cap';

export interface Block {
  reason: BlockReason;
  /** The price a start needs (food, asleep): «This errand needs up to {price} of food». */
  need?: { yocto: string; cents: number };
  /** The next 00:00 UTC (energy, cap): «{name} is resting until {time}». */
  until?: string;
}

export interface Blocks {
  block: Block | null;
  food: FoodState;
  /** Whether the pet's skill has data sources or code: the allowance of searches is 2 then. */
  hasData: boolean;
}

/** Whether the pet's skill has data sources or code (`Errand price data`). */
export async function hasOutsideData(db: D1Database, tokenId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT EXISTS (SELECT 1 FROM data_sources WHERE token_id = ?1) OR EXISTS (SELECT 1 FROM skill_code WHERE token_id = ?1) AS found')
    .bind(tokenId)
    .first<{ found: number }>();
  return row?.found === 1;
}

/** The first block that holds for `form` now, or none. `checkGas` also reads the server account's balance (the desk
 * does before spending; a quote does not). */
export async function blocksOf(env: Env, tokenId: string, pet: PetRecord, form: ErrandForm, now: number, checkGas = false): Promise<Blocks> {
  const food = await foodState(env.DB, tokenId, pet, now);
  const hasData = await hasOutsideData(env.DB, tokenId);
  const today = utcDay(now);
  const until = new Date((today + 1) * 86_400_000).toISOString();

  if ((await isPaused(env.DB, 'thought')) || (checkGas && (await gasIsLow(env, now)))) return { block: { reason: 'paused' }, food, hasData };

  const needed = need(env, form);
  if (food.room < needed.yocto) {
    return { block: { reason: fullness(food.eff).state === 'asleep' ? 'asleep' : 'food', need: view(needed) }, food, hasData };
  }

  if (energyLeft(await readLife(env.DB, tokenId), today) === 0) return { block: { reason: 'energy', until }, food, hasData };

  // The errand's highest price: a full read, or what the food pays of the searches.
  const highest = isSearchForm(form) ? searchQuote(env, food.room, hasData).upTo.yocto : fullRead(env).yocto;
  if ((await isTired(env, tokenId, food, now)) || food.capLeft < highest) return { block: { reason: 'cap', until }, food, hasData };

  return { block: null, food, hasData };
}
