// Who wakes a pet: `wakeIfFed` is called by the state poll (the food in the network grew) and, in
// later changes, by feeding and by the worker's earnings (design.md › «Кто будит»). `slept_at` is the
// server's own note that the pet fell asleep; the network is the truth for the food.
import { petView } from '../chain';
import { fullness, STARTER_FOOD_YOCTO } from '../pricing';
import { track } from '../track';
import { desk, enqueueJob } from './desk';
import { foodState } from './view';

export type WakeCause = 'owner' | 'link' | 'work';

/** Wakes a sleeping pet whose food is back to one scale thought, whoever brought it: states in NEAR
 * do not move with the rate (`Pet food data` › «курс сменился»). Returns whether it woke. */
export async function wakeIfFed(env: Env, tokenId: string, cause: WakeCause, friend?: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT slept_at FROM pets WHERE token_id = ?').bind(tokenId).first<{ slept_at: number | null }>();
  if (row === null || row.slept_at === null) return false;
  const pet = await petView(env, tokenId);
  if (pet === null) return false;
  const fs = await foodState(env.DB, tokenId, pet, Date.now());
  if (fullness(fs.eff, STARTER_FOOD_YOCTO).state === 'asleep') return false;
  // Atomic: of two polls that see the food, one wakes the pet.
  const woke = await env.DB.prepare('UPDATE pets SET slept_at = NULL WHERE token_id = ? AND slept_at IS NOT NULL').bind(tokenId).run();
  if (woke.meta.changes === 0) return false;
  if (cause === 'link') {
    await env.DB.prepare("INSERT INTO memory_notes (token_id, kind, name, at) VALUES (?, 'fed_by', ?, ?)").bind(tokenId, friend ?? '', Date.now()).run();
  }
  await enqueueJob(env.DB, tokenId, { kind: 'wake', cause, friend });
  await desk(env, tokenId).arm(tokenId);
  track('pet_woke', { via: cause });
  return true;
}
