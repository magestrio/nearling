// What a thought of an errand does to the pet once it is stored (`Errand flow`, `Energy rule`, `Mood rule`, `Pet food
// data`), the same for a read and a search errand.
import type { PetRecord } from '../chain';
import { planCount, readLife, replyStatements, spendEnergy } from '../pet/life';
import { markTired, type FoodState } from '../pet/view';
import { fullness, minCallPrice } from '../pricing';
import { track } from '../track';

/** What a thought of an errand does to the pet once it is stored: a shown report lifts the mood, counts the day and
 * takes a step of energy (no trait, no deed); the food it took may put the pet to sleep, the cap may tire it. */
export async function afterThought(
  env: Env,
  tokenId: string,
  pet: PetRecord,
  fs: FoodState,
  a: { price: bigint; cut: 'fuse' | 'food' | 'cap' | null; shown: boolean; today: number; now: number },
): Promise<string[]> {
  const events: string[] = [];
  if (a.shown) {
    await env.DB.batch(replyStatements(env.DB, tokenId, { today: a.today, deep: false, count: await planCount(env, await readLife(env.DB, tokenId), pet, a.today, false), now: a.now }));
    await spendEnergy(env.DB, tokenId, 'errand', a.now);
  }
  if (fullness(fs.eff - a.price).state === 'asleep') {
    await env.DB.prepare('UPDATE pets SET slept_at = ? WHERE token_id = ? AND slept_at IS NULL').bind(a.now, tokenId).run();
    events.push('fell_asleep');
    track('pet_fell_asleep');
  }
  if (a.cut === 'cap' || fs.capLeft - a.price < minCallPrice(env, 0)) {
    await markTired(env.DB, tokenId, a.now);
    events.push('daily_cap_reached');
    track('daily_cap_reached');
  }
  return events;
}
