// Writing the riddle's item to the contract (`Wardrobe data`: «The first solved riddle sends
// `outfit_grant`, again until it lands»). The reveal of a riddle (`riddle/cron.ts` › `finishReveal`)
// leaves an `outfit_grants` row for every pet whose right answer it counted; this writer sends
// `outfit_grant` for it, finds out from the chain whether it landed, and finishes once: the row's end,
// the event and the project's gas. Same shape as `pet/growth.ts`.
//
// Called by the cron for the rows nobody called for. ADR-008: an item the chain already holds is never
// sent again.
import { ChainUnreachable, OUTFIT_GRANT_TGAS, petView } from '../chain';
import { nearUsdRate, yoctoToUsdMicros } from '../pricing';
import { gasIsLow, isPaused } from '../servicePause';
import { track } from '../track';
import { CLAIM_STALE_MS } from './growth';
import { dropItemSend, itemTxStatements } from './itemTx';
import { OUTFITS, THINKING_CAP_ID } from './outfits';

/** The slug of the item `outfit_grant` writes. */
const THINKING_CAP = OUTFITS[THINKING_CAP_ID].slug;

/** At most this many pets get their item written in a tick. */
export const GRANTS_PER_TICK = 10;

export type GrantResult = 'idle' | 'paused' | 'busy' | 'unreadable' | 'written' | 'found' | 'failed';

/** Tries the pet's waiting item once, in the order of design.md › The riddle's item: the gas pause, the
 * claim, the chain's pet, then the send. Never throws for the network: an item that is not written now is
 * tried again by the cron a minute on. */
export async function writeDueGrant(env: Env, tokenId: string): Promise<GrantResult> {
  const now = Date.now();
  const waiting = await env.DB.prepare('SELECT 1 AS found FROM outfit_grants WHERE token_id = ?').bind(tokenId).first();
  if (waiting === null) return 'idle';
  // Gas only: the AI pause does not stop a write.
  if (await isPaused(env.DB, 'outfit')) return 'paused';

  const claim = await env.DB.prepare('UPDATE outfit_grants SET sending_at = ?2 WHERE token_id = ?1 AND (sending_at IS NULL OR sending_at < ?3) RETURNING tried')
    .bind(tokenId, now, now - CLAIM_STALE_MS)
    .first<{ tried: number }>();
  if (claim === null) return 'busy';

  let pet;
  try {
    // The server's gas is read before a send: a low balance pauses now, not at the next minute.
    if (await gasIsLow(env, now)) {
      await release(env.DB, tokenId);
      return 'paused';
    }
    pet = await petView(env, tokenId);
  } catch (e) {
    if (!(e instanceof ChainUnreachable)) throw e;
    await release(env.DB, tokenId);
    console.log('outfit_grant_unreadable');
    return 'unreadable';
  }
  if (pet === null) {
    await release(env.DB, tokenId);
    console.log('outfit_grant_unreadable');
    return 'unreadable';
  }

  // The chain is already there. If a send was made before (`tried`), its outcome was lost and it landed:
  // the event fires now. If not, this is a second solved riddle of a pet that has the cap: nothing fires.
  if (pet.outfits.includes(THINKING_CAP_ID)) return finish(env, tokenId, claim.tried === 1, null);

  await env.DB.prepare('UPDATE outfit_grants SET tried = 1 WHERE token_id = ?').bind(tokenId).run();
  const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
    methodName: 'outfit_grant',
    args: { token_id: tokenId },
    gas: (OUTFIT_GRANT_TGAS * 1_000_000_000_000n).toString(),
    writes: { tokenId, item: THINKING_CAP },
  });
  if (answer.status === 'ok') {
    console.log('outfit_grant_sent');
    return finish(env, tokenId, true, { burnt: answer.burnt ?? null, txHash: answer.txHash });
  }
  // A send the network answered `failed` did not write the item, whatever its code.
  if (answer.status === 'failed') await dropItemSend(env.DB, answer.txHash);
  // The contract says the item is there: as the chain having it, and this very row sent for it. The hash
  // that wrote it is an earlier send's, and `item_sends` holds it.
  if (answer.status === 'failed' && answer.code === 'outfit_owned') return finish(env, tokenId, true, null);
  // A refusal, an unreachable network or an outcome nobody heard: the next attempt reads the chain
  // first, so a send that did land is found there and never sent again.
  await release(env.DB, tokenId);
  console.log(answer.status === 'unknown' ? 'outfit_grant_unknown' : `outfit_grant_failed:${answer.status === 'failed' ? answer.code : 'unreachable'}`);
  return 'failed';
}

/** The pets with an item waiting, oldest first, a few at a time. */
export async function writeDueGrants(env: Env): Promise<void> {
  const due = await env.DB.prepare('SELECT token_id FROM outfit_grants ORDER BY created_at, rowid LIMIT ?').bind(GRANTS_PER_TICK).all<{ token_id: string }>();
  for (const { token_id } of due.results) await writeDueGrant(env, token_id);
}

const release = (db: D1Database, tokenId: string) => db.prepare('UPDATE outfit_grants SET sending_at = NULL WHERE token_id = ?').bind(tokenId).run();

/** Finishes a grant once: the row goes, and only the writer that deleted it fires the event and adds the
 * gas. `fires` is false for a second solved riddle (a read, no send, no event). `sent` is null when this
 * writer sent nothing, else the gas its own send burned (null when the answer did not say) and the hash of
 * its transaction, which wrote the item and is kept with the row's end. */
async function finish(env: Env, tokenId: string, fires: boolean, sent: { burnt: string | null; txHash: string } | null): Promise<GrantResult> {
  const now = Date.now();
  const written = await env.DB.batch([
    env.DB.prepare('DELETE FROM outfit_grants WHERE token_id = ? RETURNING token_id').bind(tokenId),
    ...(sent === null ? [] : itemTxStatements(env.DB, tokenId, THINKING_CAP, sent.txHash, now)),
  ]);
  if (written[0]!.results.length === 0) return 'busy';
  if (fires) track('outfit_earned', { via: 'riddle' });
  if (sent?.burnt != null) {
    const rate = nearUsdRate(env.NEAR_USD_RATE);
    if (rate === null) console.log('rate_missing');
    else await env.DB.prepare('INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, ?, ?)').bind(now, 'gas', yoctoToUsdMicros(BigInt(sent.burnt), rate)).run();
  }
  return sent === null ? 'found' : 'written';
}
