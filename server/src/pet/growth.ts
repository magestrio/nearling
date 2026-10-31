// Writing a transition to the contract (`Pet life data`: «Незаписанный переход сервер шлёт снова с той
// же чертой, пока не запишется»). A counted reply leaves a `pending_growth` row with the trait fixed
// (`pet/life.ts`); this writer sends `pet_grow` for it, finds out from the chain whether it landed,
// and finishes once: the line in the conversation, the events and the project's gas.
//
// Called by the pet's desk after a job's result is stored, and by the cron for the rows nobody called
// for. ADR-008: a transition the chain already holds is never sent again.
import { chainDay, ChainUnreachable, PET_GROW_TGAS, petView, stageOf, type PetRecord, type Stage, type Trait } from '../chain';
import { utcDay } from '../http';
import { nearUsdRate, yoctoToUsdMicros } from '../pricing';
import { isPaused } from '../servicePause';
import { track } from '../track';
import { growthLine, type GrowthStage } from './life';

/** A claim older than this belongs to a writer that is gone: 25 s of send and two 8 s reads, with room. */
export const CLAIM_STALE_MS = 60_000;

interface Row {
  stage: GrowthStage;
  trait: Trait;
}

/** The rank of a stage; a row is written when the chain's stage has reached its own. */
const RANK: Record<Stage, number> = { baby: 0, teen: 1, adult: 2 };
/** The contract's spelling of the stage argument (near-sdk's JSON of `Stage`). */
const CONTRACT_STAGE: Record<GrowthStage, string> = { teen: 'Teen', adult: 'Adult' };

export type WriteResult = 'idle' | 'paused' | 'busy' | 'unreadable' | 'waiting' | 'written' | 'found' | 'failed';

/** Tries the oldest unwritten transition of the pet once, in the order of design.md › Решения: the
 * gas pause, the claim, the chain's pet and day, then the send. Never throws for the network: a
 * transition that is not written now is tried again by the cron a minute on. */
export async function writeDueGrowth(env: Env, tokenId: string): Promise<WriteResult> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT stage, trait FROM pending_growth WHERE token_id = ?1 AND (retry_day IS NULL OR retry_day <= ?2) ORDER BY CASE stage WHEN 'teen' THEN 0 ELSE 1 END LIMIT 1",
  )
    .bind(tokenId, utcDay(now))
    .first<Row>();
  if (row === null) return 'idle';
  // Gas only: the AI pause does not stop a write (`Pet life data`).
  if (await isPaused(env.DB, 'grow')) return 'paused';

  const claim = await env.DB.prepare('UPDATE pending_growth SET sending_at = ?3 WHERE token_id = ?1 AND stage = ?2 AND (sending_at IS NULL OR sending_at < ?4) RETURNING stage')
    .bind(tokenId, row.stage, now, now - CLAIM_STALE_MS)
    .first();
  if (claim === null) return 'busy';

  let pet: PetRecord | null;
  let day: number;
  try {
    pet = await petView(env, tokenId);
    day = await chainDay(env);
  } catch (e) {
    if (!(e instanceof ChainUnreachable)) throw e;
    await release(env.DB, tokenId, row.stage);
    console.log('grow_unreadable');
    return 'unreadable';
  }
  if (pet === null) {
    await release(env.DB, tokenId, row.stage);
    return 'unreadable';
  }

  // The chain is already there (an outcome that was unknown has landed): finish, send nothing.
  if (RANK[stageOf(pet)] >= RANK[row.stage]) return finish(env, tokenId, row, pet, null);
  // A second change in the same UTC day is refused by the contract: wait for 00:00 UTC, no transaction.
  if (pet.stage_day >= day) {
    await waitFor(env.DB, tokenId, row.stage, day + 1);
    return 'waiting';
  }

  const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
    methodName: 'pet_grow',
    args: { token_id: tokenId, stage: CONTRACT_STAGE[row.stage], trait: row.trait },
    gas: (PET_GROW_TGAS * 1_000_000_000_000n).toString(),
  });
  if (answer.status === 'ok') {
    console.log('grow_sent');
    return finish(env, tokenId, row, pet, { burnt: answer.burnt ?? null });
  }
  if (answer.status === 'failed' && answer.code === 'stage_today') {
    // The chain's day was not the one read a moment ago: the same wait.
    await waitFor(env.DB, tokenId, row.stage, day + 1);
    return 'waiting';
  }
  // A refusal, an unreachable network or an outcome nobody heard: the next attempt reads the chain
  // first, so a send that did land is found there and never sent again.
  await release(env.DB, tokenId, row.stage);
  console.log(answer.status === 'unknown' ? 'grow_unknown' : `grow_failed:${answer.status === 'failed' ? answer.code : 'unreachable'}`);
  return 'failed';
}

const release = (db: D1Database, tokenId: string, stage: GrowthStage) =>
  db.prepare('UPDATE pending_growth SET sending_at = NULL WHERE token_id = ? AND stage = ?').bind(tokenId, stage).run();

const waitFor = (db: D1Database, tokenId: string, stage: GrowthStage, day: number) =>
  db.prepare('UPDATE pending_growth SET sending_at = NULL, retry_day = ? WHERE token_id = ? AND stage = ?').bind(day, tokenId, stage).run();

/** Finishes a transition once: the line (a thought row with no model and no price) and the row's end in
 * one batch; the events and the project's gas follow only for the writer that deleted the row. `sent`
 * is null when this writer sent nothing (the chain already had the stage), else the gas its own send
 * burned (null when the answer did not say). */
async function finish(env: Env, tokenId: string, row: Row, pet: PetRecord, sent: { burnt: string | null } | null): Promise<WriteResult> {
  const now = Date.now();
  // The adult step repeats the trait when the teen's is the same (`Trait rule` › «черта уже есть»).
  const repeat = row.stage === 'adult' && pet.traits[0] === row.trait;
  const line = growthLine(row.stage, pet.name, row.trait, repeat);
  const written = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status) SELECT ?1, ?2, ?3, 'growth', NULL, ?4, '', '0', 0, 'project', 'project' WHERE EXISTS (SELECT 1 FROM pending_growth WHERE token_id = ?2 AND stage = ?5)",
    ).bind(crypto.randomUUID().replaceAll('-', '').slice(0, 24), tokenId, now, line, row.stage),
    env.DB.prepare('DELETE FROM pending_growth WHERE token_id = ? AND stage = ? RETURNING stage').bind(tokenId, row.stage),
  ]);
  if (written.at(-1)!.results.length === 0) return 'busy';
  track('pet_grew', { stage: row.stage });
  track('trait_gained', { trait: row.trait });
  if (sent?.burnt != null) {
    const rate = nearUsdRate(env.NEAR_USD_RATE);
    if (rate === null) console.log('rate_missing');
    else await env.DB.prepare('INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, ?, ?)').bind(now, 'gas', yoctoToUsdMicros(BigInt(sent.burnt), rate)).run();
  }
  return sent === null ? 'found' : 'written';
}
