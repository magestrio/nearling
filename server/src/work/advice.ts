// The advice a player asks of a friend's pet, paid by their own pet (`Advice flow`, `Hire access data`). It is a job of
// the PAYING pet: one of that pet's spends, run by its desk one at a time (`Thought queue data`). The checks that move
// with time run here, in the job; the route (`routes/work.ts`) takes the question only when the session owns the payer.
import { ChainUnreachable, petView, type PetRecord } from '../chain';
import { utcDay } from '../http';
import { energyLeft, readLife } from '../pet/life';
import { foodState, isTired, markTired } from '../pet/view';
import { fullness, minCallPrice } from '../pricing';
import { gasIsLow, isPaused } from '../servicePause';
import type { Exchange } from '../prompt';
import { openSession, randomId, type JobResult } from '../spend';
import { track } from '../track';
import { relation } from '../society/relations';
import { recordSocietyEvent } from '../society/events';
import { recordWillEvent } from '../will/events';
import { answerStatements, dataOnly, workerCall } from './answer';
import { hold, pairPrice, release, type Quote } from './quote';

/** What the desk keeps of an advice while it is queued: the worker, the question (the only copy, gone with the job),
 * and the price the page showed, a ceiling (`Hire quote data`). */
export interface AdviceJob {
  kind: 'advice';
  worker: string;
  text: string;
  shown: string;
}

export type PayerState = 'ok' | 'asleep' | 'short' | 'tired';

export interface AdviceFacts {
  quote: Quote;
  skilled: boolean;
  workerAsleep: boolean;
  /** The worker has no energy left today, or has answered as often as a day allows: it rests to 00:00 UTC. */
  resting: boolean;
  payer: PayerState;
}

/** The facts of an advice at this moment, read by the page (`GET …/advice`) and by the job alike. The order of the
 * payer's states is the page's: asleep, then can't pay, then tired. */
export async function adviceFacts(env: Env, a: { payerId: string; payer: PetRecord; workerId: string; worker: PetRecord; now: number }): Promise<AdviceFacts> {
  const today = utcDay(a.now);
  const quote = await pairPrice(env, a.payerId, a.workerId, today, a.now);
  const workerFood = await foodState(env.DB, a.workerId, a.worker, a.now);
  const rested = energyLeft(await readLife(env.DB, a.workerId), today) > 0;
  const payerFood = await foodState(env.DB, a.payerId, a.payer, a.now);
  let payer: PayerState = 'ok';
  if (fullness(payerFood.eff).state === 'asleep') payer = 'asleep';
  else if (fullness(payerFood.room > quote.yocto ? payerFood.room - quote.yocto : 0n).state === 'asleep') payer = 'short';
  else if ((await isTired(env, a.payerId, payerFood, a.now)) || quote.yocto > payerFood.capLeft) payer = 'tired';
  return {
    quote,
    skilled: (await env.DB.prepare('SELECT 1 AS found FROM skills WHERE token_id = ?').bind(a.workerId).first()) !== null,
    workerAsleep: fullness(workerFood.eff).state === 'asleep',
    resting: !rested || !quote.open,
    payer,
  };
}

/** Runs one advice of the paying pet `payerId`. The order of refusals: the pause, the chain, the payer (asleep, can't
 * pay, tired) with nothing held, the worker (asleep, resting), then the place at the shown price, then the call. */
export async function runAdvice(env: Env, payerId: string, job: AdviceJob, epoch: number): Promise<JobResult> {
  const refused = async (until: number): Promise<JobResult> => {
    track('pet_hire_refused', { by: 'player', reason: 'relationship' });
    await recordSocietyEvent(env, 'pet_hire_refused', { by: 'player', reason: 'relationship' });
    return { code: 'society_refused', until: new Date(until).toISOString() };
  };
  const now = Date.now();
  if (await isPaused(env.DB, 'thought')) return { code: 'paused' };
  let payer: PetRecord | null;
  let worker: PetRecord | null;
  try {
    if (await gasIsLow(env, now)) return { code: 'paused' };
    [payer, worker] = await Promise.all([petView(env, payerId), petView(env, job.worker)]);
  } catch (e) {
    if (e instanceof ChainUnreachable) return { code: 'chain_unreachable' };
    throw e;
  }
  // A pet given to the worker's owner since the question was sent can no longer hire it (`hire:<i>:same_owner`).
  if (payer === null || worker === null || payer.owner_id === worker.owner_id) return { code: 'no_pet' };
  await env.DB.prepare('INSERT OR IGNORE INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)').bind(payerId, payer.owner_id, now, '').run();

  const facts = await adviceFacts(env, { payerId, payer, workerId: job.worker, worker, now });
  if (facts.quote.refusalUntil != null) return refused(facts.quote.refusalUntil);
  if (facts.payer !== 'ok') return { code: facts.payer };
  if (facts.workerAsleep) return { code: 'worker_asleep' };
  if (facts.resting) return { code: 'worker_resting' };

  const day = utcDay(now);
  const held = await hold(env, job.worker, day, BigInt(job.shown), now, payerId);
  if (!held.ok) {
    console.log('advice_refused:price_rose');
    return held.open ? { code: 'price_rose', price: held.price.toString() } : { code: 'worker_resting' };
  }

  const fresh = await pairPrice(env, payerId, job.worker, day, Date.now());
  if (fresh.refusalUntil != null) {
    await release(env, job.worker, day);
    return refused(fresh.refusalUntil);
  }
  if (fresh.discounted !== held.discounted) {
    await release(env, job.worker, day);
    const changed = await pairPrice(env, payerId, job.worker, day, Date.now());
    return { code: 'price_rose', price: changed.yocto.toString() };
  }

  const prior = await lastExchange(env.DB, payerId, job.worker);
  const out = await workerCall(env, { worker: { id: job.worker, pet: worker }, question: job.text, fee: held.fee, payerId, payerGeneration: payer.transfer_generation, day, payerEpoch: epoch, prior, job: 'advice', pair: { payerName: payer.name, stance: (await relation(env.DB, payerId, job.worker))?.stance ?? 'neutral' } });
  if (out.kind === 'failed') {
    console.log(`advice_refused:${out.code}`);
    return { code: out.code };
  }
  if (out.kind === 'declined') {
    track('pet_hire_refused', { by: 'player', reason: 'character', project_usd: out.projectMicros / 1_000_000 });
    await recordWillEvent(env, 'pet_hire_refused', { id: out.id, by: 'player', reason: 'character', project_usd: out.projectMicros / 1_000_000 });
    return { code: 'character_refused', refusal: { id: out.id, reason: out.reason } };
  }
  // A data source or the code gave no data (`Adapter call rule` › «data failed in advice»): no fee and no worker's answer,
  // the question is kept. Among the paying pet's first three failed calls of the day the project paid the data call; from
  // the fourth the paying pet pays it by usage as a thought with no reply, below.
  if (out.kind === 'data_failed' && !out.paid) {
    console.log('advice_refused:data_failed');
    return { code: 'data_failed', paid: false };
  }
  const outcome = out.kind === 'data_failed' ? dataOnly(out) : out;

  // The fee is owed only for an answer shown to a pet whose memory stands: one hire row, unbilled until the batch that
  // debits it records it. Cleared on the way: no fee and no hire, the pet pays the call by usage (`Hire food data`).
  const stored = Date.now();
  const thoughtId = randomId();
  const sessionId = await openSession(env, payerId, stored);
  const { statements, hireAt } = answerStatements(env, {
    kind: 'advice',
    payerId,
    thoughtId,
    sessionId,
    stored,
    playerText: job.text,
    worker: { id: job.worker, name: worker.name },
    outcome,
    fee: held.fee,
    discounted: held.discounted,
    hire: { kind: 'player', mode: null },
    turnId: null,
    epoch,
  });
  if (outcome.kind === 'answer') {
    statements.push(env.DB.prepare(`INSERT INTO known_pets (account_id, token_id, reason, interacted_at)
      SELECT ?1, ?2, 'paid_advice', ?3 WHERE EXISTS
        (SELECT 1 FROM hires WHERE answer_thought_id = ?4 AND kind = 'player')
      ON CONFLICT (account_id, token_id) DO UPDATE SET reason = 'paid_advice', interacted_at = excluded.interacted_at`)
      .bind(payer.owner_id, job.worker, stored, thoughtId));
  }
  const written = await env.DB.batch(statements);
  // A clear that landed between the worker's answer and this batch refused the hire's row by itself.
  const cleared = outcome.kind === 'cleared' || (hireAt !== null && (written[hireAt]?.results.length ?? 0) === 0);
  const answered = outcome.kind === 'answer' && !cleared;

  // After the advice: asleep when the food (the fee out of it) is below one scale thought; tired when the cap is used.
  const events: string[] = [];
  const left = await foodState(env.DB, payerId, payer, stored);
  if (fullness(left.eff).state === 'asleep') {
    await env.DB.prepare('UPDATE pets SET slept_at = ? WHERE token_id = ? AND slept_at IS NULL').bind(stored, payerId).run();
    events.push('fell_asleep');
    track('pet_fell_asleep');
  }
  if (left.capLeft < minCallPrice(env, 0)) {
    await markTired(env.DB, payerId, stored);
    events.push('daily_cap_reached');
    track('daily_cap_reached');
  }
  if (cleared) {
    console.log('advice_cleared');
    return { code: 'memory_cleared', events };
  }
  if (out.kind === 'data_failed') return { code: 'data_failed', paid: true, events };
  if (!answered) return { code: 'empty_paid', events };
  console.log('advice_ok');
  track('thought_delivered', { model: 'cheap', for: 'hirer' });
  return { thoughtId, cut: null, price: out.price.toString(), reasked: false, events };
}

/** The paying pet's last exchange with this worker that is still in its conversation: the words went with a clear of
 * its memory otherwise. A skilled worker's answer is here too — it is the asker's own record of what it was told
 * (`recall = 0` keeps it out of the pet's later requests, not out of the follow-up to the worker that said it). */
export async function lastExchange(db: D1Database, payerId: string, workerId: string): Promise<(Exchange & { id: string; skilled: boolean; dataLabels: string[] }) | null> {
  const row = await db
    .prepare(
      "SELECT id, player_text, reply_text, skilled, data_labels FROM thoughts WHERE token_id = ? AND kind = 'advice' AND worker_id = ? AND player_text IS NOT NULL AND reply_text IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(payerId, workerId)
    .first<{ id: string; player_text: string; reply_text: string; skilled: number; data_labels: string | null }>();
  return row === null
    ? null
    : { id: row.id, question: row.player_text, answer: row.reply_text, skilled: row.skilled === 1, dataLabels: row.data_labels === null ? [] : (JSON.parse(row.data_labels) as string[]) };
}

/** The data sources of the worker's skill that a job may read, by name: what the line under the advice column names
 * (`Adapter call rule` › «advice line»). A source with no ticked tool is never called, so it is not named. */
export async function readableSourceLabels(db: D1Database, workerId: string): Promise<string[]> {
  const rows = await db.prepare('SELECT label, tools FROM data_sources WHERE token_id = ? ORDER BY created_at, rowid').bind(workerId).all<{ label: string; tools: string }>();
  return rows.results.filter((r) => (JSON.parse(r.tools) as { ticked: boolean }[]).some((t) => t.ticked)).map((r) => r.label);
}
