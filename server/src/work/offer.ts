// A pet in Manual asks first (`Pet hire flow`, `Hire access data`): the offer it left at its decision, the three jobs the
// owner's answer queues — «Ask {worker}» (`hire`), «No thanks» or a new line (`decline`), «Try again» under a lost own reply
// (`finish`) — and the facts the routes check before queuing them. The jobs are the paying pet's, run by its desk one at a
// time. Nothing here logs a word of a question or an answer.
import { ChainUnreachable, petView, type PetRecord } from '../chain';
import { gasIsLow, isPaused } from '../servicePause';
import { foodState } from '../pet/view';
import { fullness } from '../pricing';
import type { ThoughtJob } from '../prompt';
import { run, type JobResult } from '../spend';
import { closeOffer, continueHire, ownOrLost } from './hire';
import { readOffer, type Offer } from './offerRead';

export interface HireJob {
  kind: 'hire';
  /** The price the tap showed, a ceiling (`Hire quote data`). */
  price: string;
}
export interface DeclineJob {
  kind: 'decline';
  /** A new line instead of an answer queued it, not a tap on «No thanks»: the offer goes whatever comes of the reply, since the
   * line behind it is the next turn (`нажатая кнопка вернулась` is about a tapped button). */
  line?: boolean;
}
export interface FinishJob {
  kind: 'finish';
}
export type OfferJob = HireJob | DeclineJob | FinishJob;

/** The offer of an owner's route, with the asleep check made from the contract's record and the food. */
export async function standingOffer(env: Env, tokenId: string, pet: PetRecord): Promise<Offer | null> {
  const row = await env.DB.prepare('SELECT 1 AS found FROM hire_offers WHERE token_id = ?').bind(tokenId).first();
  if (row === null) return null;
  const food = await foodState(env.DB, tokenId, pet, Date.now());
  return readOffer(env.DB, tokenId, fullness(food.eff).state === 'asleep');
}

/** An answer to the offer (or a lost reply's retry) is already on its way: a second tap finds nothing to answer. */
export async function offerJobOnItsWay(db: D1Database, tokenId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS found FROM jobs WHERE token_id = ? AND kind IN ('hire', 'decline', 'finish') AND status IN ('queued', 'running') LIMIT 1").bind(tokenId).first();
  return row !== null;
}

/** The turn's words: the owner's line and the pet's question, the two sides of the decision thought. */
async function turnWords(db: D1Database, tokenId: string, turnId: string): Promise<{ line: string; question: string } | null> {
  const row = await db
    .prepare("SELECT player_text, reply_text FROM thoughts WHERE token_id = ? AND turn_id = ? AND kind = 'hire_question'")
    .bind(tokenId, turnId)
    .first<{ player_text: string | null; reply_text: string | null }>();
  return row === null || row.player_text === null || row.reply_text === null ? null : { line: row.player_text, question: row.reply_text };
}

const replyJob = (text: string): Extract<ThoughtJob, { kind: 'reply' }> => ({ kind: 'reply', mode: 'chat', text });

/** The turn whose own reply is missing after the worker's answer, while «Try again» may still finish it: the worker's
 * answer is kept, no reply of the turn has words, and no later line was sent (a job of a line queued after the answer
 * ends the chance, whether or not it was answered). */
export interface LostTurn {
  turnId: string;
  line: string;
  question: string;
  answer: string;
  worker: string;
  skilled: boolean;
}

export async function lostTurn(db: D1Database, tokenId: string): Promise<LostTurn | null> {
  const row = await db
    .prepare(
      `SELECT q.turn_id, q.player_text, q.reply_text AS question, a.reply_text AS answer, a.worker_name, a.skilled, a.created_at AS answered_at
       FROM thoughts a JOIN thoughts q ON q.token_id = a.token_id AND q.turn_id = a.turn_id AND q.kind = 'hire_question'
       WHERE a.token_id = ? AND a.kind = 'hire_answer' AND a.reply_text IS NOT NULL AND q.player_text IS NOT NULL AND q.reply_text IS NOT NULL
       ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
    )
    .bind(tokenId)
    .first<{ turn_id: string; player_text: string; question: string; answer: string; worker_name: string | null; skilled: number; answered_at: number }>();
  if (row === null) return null;
  const replied = await db.prepare("SELECT 1 AS found FROM thoughts WHERE token_id = ? AND turn_id = ? AND kind IN ('reply', 'question') AND reply_text IS NOT NULL").bind(tokenId, row.turn_id).first();
  if (replied !== null) return null;
  const later = await db
    .prepare("SELECT 1 AS found FROM jobs WHERE token_id = ? AND kind IN ('reply', 'hire', 'decline') AND created_at > ? LIMIT 1")
    .bind(tokenId, row.answered_at)
    .first();
  if (later !== null) return null;
  return { turnId: row.turn_id, line: row.player_text, question: row.question, answer: row.answer, worker: row.worker_name ?? '', skilled: row.skilled === 1 };
}

/** Whether the service may run a thought now, as the other jobs ask it. */
async function mayRun(env: Env): Promise<JobResult | null> {
  if (await isPaused(env.DB, 'thought')) return { code: 'paused' };
  try {
    if (await gasIsLow(env, Date.now())) return { code: 'paused' };
  } catch (e) {
    if (e instanceof ChainUnreachable) return { code: 'chain_unreachable' };
    throw e;
  }
  return null;
}

/** «Ask {worker}»: the hire of the offer at the price the tap showed or the offer's, the lower — each a ceiling. */
export async function runHire(env: Env, tokenId: string, job: HireJob, epoch: number, jobId: string): Promise<JobResult> {
  const refused = await mayRun(env);
  if (refused !== null) return refused;
  let pet: PetRecord | null;
  try {
    pet = await petView(env, tokenId);
  } catch (e) {
    if (e instanceof ChainUnreachable) return { code: 'chain_unreachable' };
    throw e;
  }
  if (pet === null) return { code: 'no_pet' };
  const offer = await readOffer(env.DB, tokenId, fullness((await foodState(env.DB, tokenId, pet, Date.now())).eff).state === 'asleep');
  if (offer === null) return { code: 'no_offer' };
  const words = await turnWords(env.DB, tokenId, offer.turnId);
  if (words === null) return { code: 'memory_cleared' };
  const tapped = BigInt(job.price);
  return continueHire(env, {
    tokenId,
    job: replyJob(words.line),
    jobId,
    epoch,
    turnId: offer.turnId,
    candidate: { tokenId: offer.workerId, name: offer.worker },
    question: words.question,
    events: [],
    own: (turn) => run(env, tokenId, replyJob(words.line), epoch, { turn }),
    mode: 'manual',
    ceiling: tapped < offer.price ? tapped : offer.price,
  });
}

/** «No thanks», or the new line that came instead: the pet answers the line itself, as an ordinary thought from its own
 * food, with no fee (`отказ в Manual`). The offer goes with that answer; a tapped «No thanks» whose answer did not come (the
 * AI provider down, an empty reply the pet paid for) leaves it standing, and the button is back (`нажатая кнопка вернулась`). */
export async function runDecline(env: Env, tokenId: string, epoch: number, viaLine = false): Promise<JobResult> {
  const offer = await env.DB.prepare('SELECT turn_id FROM hire_offers WHERE token_id = ?').bind(tokenId).first<{ turn_id: string }>();
  if (offer === null) return { code: 'no_offer' };
  const words = await turnWords(env.DB, tokenId, offer.turn_id);
  if (viaLine || words === null) await closeOffer(env.DB, tokenId, false);
  if (words === null) return { code: 'memory_cleared' };
  const own = await run(env, tokenId, replyJob(words.line), epoch, { turn: { id: offer.turn_id, recall: 1 } });
  if (!viaLine && ('thoughtId' in own || own.code === 'memory_cleared')) await closeOffer(env.DB, tokenId, false);
  return own;
}

/** «Try again» under a lost own reply: the own reply only, from the worker's answer already kept — no new question,
 * no new place, no fee (`свой ответ заново`). */
export async function runFinish(env: Env, tokenId: string, epoch: number): Promise<JobResult> {
  const lost = await lostTurn(env.DB, tokenId);
  if (lost === null) return { code: 'no_hire' };
  const own = await run(env, tokenId, replyJob(lost.line), epoch, {
    turn: { id: lost.turnId, recall: lost.skilled ? 0 : 1, hired: { worker: lost.worker, question: lost.question, answer: lost.answer, turnId: lost.turnId } },
  });
  console.log('hire_finish');
  return ownOrLost(own, lost.turnId, []);
}
