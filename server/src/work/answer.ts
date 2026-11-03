// The worker's answer: the one call path of advice and of a pet's hire (`Hire request data`, `Worker rule`,
// `Skilled answer data`, ADR-011, ADR-023). `workerCall` builds the worker's own request, sends it, checks the model's
// signature and the leak filter, settles the worker's place of the day and the project's spend, and says what came of
// it. It stores nothing of the asker's: the caller writes the thought and the hire in its own batch.
//
// The seam of `add-pet-errands` (ADR-023): `sources` is the one step between the question and the request where a
// later change calls the pet's data sources; today it brings nothing.
import type { PetRecord } from '../chain';
import { utcDay } from '../http';
import { hasVisible } from '../name/clean';
import { complete, replyOf, signatureOf } from '../nearai';
import { eraseIfCleared, memoryEpoch } from '../pet/forget';
import { energyLeft, moodOf, noteDeed, noteMood, readLife, spendEnergy } from '../pet/life';
import { wornOf } from '../pet/outfits';
import { foodState } from '../pet/view';
import { ceilingFor, ceilingPrice, fullness, thoughtPrice, usd12ToMicros } from '../pricing';
import { inputBound, workerMessages, type Exchange } from '../prompt';
import { callsUsd12, CHAT_TIMEOUT_MS, countEmpty, FREE_EMPTY_ANSWERS, hex, projectPays, randomId, refusalOf, yoctoMicros, type Answer, type SignedCall } from '../spend';
import { quotesInstruction } from './leak';
import { answered, release } from './quote';
import { readSkill, SkillUnreadable } from './skill';

/** A worker's answer is at most this many tokens, and always cheaper than its fee (`Hire request data`). */
const MAX_ANSWER_TOKENS = 400;

export interface WorkerAsk {
  /** The worker as `pet_view` returned it: the caller has read it for its own checks. */
  worker: { id: string; pet: PetRecord };
  question: string;
  /** The price at the moment the place was held: the answer's usage price stays below it by construction. */
  fee: bigint;
  /** The paying pet, whose empty answers of the day the call counts. */
  payerId: string;
  /** The UTC day of the worker's place (`worker_answers`). */
  day: number;
  /** The paying pet's `memory_epoch` when its job was claimed: an answer that lands after the memory was cleared
   * is a `cleared` one (`Hire food data` › «memory cleared before the answer»). */
  payerEpoch?: number;
  /** The asker's last exchange with this worker, told before the question (advice only, `Hire request data`). */
  prior?: Exchange | null;
}

export type WorkerOutcome =
  // Signed, a line, the filter passed: the caller shows it and the fee is owed.
  | { kind: 'answer'; reply: string; call: SignedCall; price: bigint; skilled: boolean }
  // Signed and a line, but the paying pet's memory was cleared while the worker answered: the words are not kept,
  // no fee is owed, the worker earns nothing and its place is back; the paying pet pays the call by usage.
  | { kind: 'cleared'; call: SignedCall; price: bigint; skilled: boolean }
  // Signed, with no line (or stopped by the filter), the paying pet's fourth of the day or later: it pays the call
  // by usage, no fee. `stopped` says the reply held the instruction: its bytes must not be kept.
  | { kind: 'empty'; call: SignedCall; price: bigint; skilled: boolean; stopped: boolean }
  // Nothing to show and nothing owed: the place is back, the project paid what it had to.
  | { kind: 'failed'; code: 'ai_unavailable' | 'paused' };

/** The data step of the request (`add-pet-errands` fills it): layers to add after the skill. None today. */
async function sources(_env: Env, _ask: WorkerAsk): Promise<string[]> {
  return [];
}

/** Runs the worker's call for a place already held. On every outcome but `answer` the place is back; on `answer` it
 * has become an answer of the day. */
export async function workerCall(env: Env, ask: WorkerAsk): Promise<WorkerOutcome> {
  const { worker } = ask;
  const back = async (outcome: WorkerOutcome): Promise<WorkerOutcome> => {
    await release(env, worker.id, ask.day);
    return outcome;
  };

  // The instruction is opened in memory only. A price raised by a skill never buys an answer without it.
  let skill: { instruction: string } | null;
  try {
    skill = await readSkill(env, worker.id);
  } catch (e) {
    if (e instanceof SkillUnreadable) {
      console.log('skill_unreadable');
      return back({ kind: 'failed', code: 'ai_unavailable' });
    }
    throw e;
  }

  const start = Date.now();
  const today = utcDay(start);
  const life = await readLife(env.DB, worker.id);
  const food = await foodState(env.DB, worker.id, worker.pet, start);
  const messages = workerMessages(
    worker.pet,
    ask.question,
    { mood: moodOf(fullness(food.eff).state, life.moodDay, today), energyPercent: energyLeft(life, today) * 10, outfit: await wornOf(env.DB, worker.id) },
    skill?.instruction ?? null,
    await sources(env, ask),
    ask.prior ?? null,
  );
  const bound = inputBound(messages);
  // Cheaper than the fee by construction: the ceiling is what the fee less one yocto pays at this input.
  const maxTokens = ceilingFor(env, bound, ask.fee - 1n, MAX_ANSWER_TOKENS);
  if (maxTokens < 1) return back({ kind: 'failed', code: 'ai_unavailable' });

  // A skilled request carries a fresh 128-bit value outside `messages`, kept nowhere: no guess at the instruction
  // can match the public hash of the request (`Skilled answer data` › «a guess at the instruction»).
  const nonce = skill === null ? undefined : hex(crypto.getRandomValues(new Uint8Array(16)));
  const result = await complete(env, { messages, maxTokens, thinking: false, timeoutMs: CHAT_TIMEOUT_MS, ...(nonce === undefined ? {} : { extra: { nonce } }) });
  const failure = await refusalOf(env, result, ceilingPrice(env, bound, maxTokens));
  if (failure !== null) return back({ kind: 'failed', code: 'code' in failure && failure.code === 'paused' ? 'paused' : 'ai_unavailable' });
  const answer = result as Answer;

  const signed = await signatureOf(env, answer);
  if (signed === null) {
    // The tokens were used and nobody can prove the answer: the project pays them.
    await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, [answer])));
    console.log('signature_missing');
    return back({ kind: 'failed', code: 'ai_unavailable' });
  }
  const call: SignedCall = { answer, signed };

  const reply = replyOf(answer.content).trim();
  const stopped = skill !== null && quotesInstruction(skill.instruction, reply);
  const empty = stopped || !hasVisible(reply);
  const skilled = skill !== null;
  // By usage, and never as high as the fee: what the answer cost above it was the project's.
  const usage = thoughtPrice(env, [{ tokensIn: answer.tokensIn, tokensOut: answer.tokensOut }]);
  const price = usage < ask.fee ? usage : ask.fee - 1n;
  if (usage > price) {
    await projectPays(env, 'edge', yoctoMicros(env, usage - price));
    console.log('worker_over_fee');
  }

  if (empty) {
    // An answer with no line, or a stopped one, counts toward the paying pet's three of the UTC day.
    const n = await countEmpty(env, ask.payerId, utcDay(Date.now()));
    if (n <= FREE_EMPTY_ANSWERS) {
      await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, [answer])));
      console.log(stopped ? 'worker_stopped' : 'worker_empty_free');
      return back({ kind: 'failed', code: 'ai_unavailable' });
    }
    // The fourth: the pet pays the call by usage, but nothing reached the asker, so the worker's place goes back and
    // its count and price stay (`Hire quote data` › «no answer»; §8 › Ответы работника за день counts shown answers).
    console.log(stopped ? 'worker_stopped' : 'worker_empty_paid');
    return back({ kind: 'empty', call, price, skilled, stopped });
  }

  // The paying pet's memory was cleared since its job was claimed: nobody keeps this answer, so the worker did no
  // work worth a place, a step of energy or a deed (`Hire quote data` › «no answer»).
  if (ask.payerEpoch !== undefined && (await memoryEpoch(env.DB, ask.payerId)) !== ask.payerEpoch) {
    console.log('worker_cleared');
    return back({ kind: 'cleared', call, price, skilled });
  }

  // The work itself: a step of energy, a better mood, a deed of the day, never a counted day (`Worker rule`).
  await spendEnergy(env.DB, worker.id, 'work', Date.now());
  await env.DB.batch([...noteMood(env.DB, worker.id, utcDay(Date.now())), ...noteDeed(env.DB, worker.id, 'work')]);
  await answered(env, worker.id, ask.day);
  return { kind: 'answer', reply, call, price, skilled };
}

/** What the paying pet's batch stores of a worker's answer that reached it (shown, empty-and-paid, or cleared). */
export interface StoredAnswer {
  /** `advice` (the player's question) or `hire_answer` (a pet's own hire). */
  kind: 'advice' | 'hire_answer';
  payerId: string;
  thoughtId: string;
  sessionId: string;
  stored: number;
  /** The question of an advice; none for a hire answer (its question is the `hire_question` row of the turn). */
  playerText: string | null;
  worker: { id: string; name: string };
  outcome: Exclude<WorkerOutcome, { kind: 'failed' }>;
  fee: bigint;
  hire: { kind: 'player' | 'pet'; mode: 'auto' | 'manual' | null };
  turnId: string | null;
  /** The payer's `memory_epoch` the job was claimed at. */
  epoch: number;
}

/** The statements of a worker's answer in the paying pet's batch: the thought, its call, the hire (only for an answer
 * shown, and only while the memory has not been cleared since `epoch` — the row says so itself), and the erasure of
 * whatever a clear that landed meanwhile leaves. `hireAt` is the index of the hire's statement (`RETURNING id`: no row
 * back means the clear won and there is no fee). The bytes of a skilled request are never kept; a stopped reply keeps
 * no bytes at all (`Skilled answer data`). */
export function answerStatements(env: Env, a: StoredAnswer): { statements: D1PreparedStatement[]; hireAt: number | null } {
  const { outcome } = a;
  const shown = outcome.kind === 'answer';
  const { answer, signed } = outcome.call;
  const stopped = outcome.kind === 'empty' && outcome.stopped;
  const statements = [
    env.DB.prepare(
      "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, cut, reasked, payer, session_id, status, worker_id, worker_name, skilled, recall, turn_id, erased_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'pet', ?, 'unbilled', ?, ?, ?, ?, ?, ?)",
    ).bind(
      a.thoughtId,
      a.payerId,
      a.stored,
      a.kind,
      // An answer that did not come keeps neither the question (it stays in the player's field) nor a reply.
      shown ? a.playerText : null,
      shown ? outcome.reply : null,
      env.MODEL_ID,
      outcome.price.toString(),
      yoctoMicros(env, outcome.price),
      a.sessionId,
      a.worker.id,
      a.worker.name,
      outcome.skilled ? 1 : 0,
      outcome.skilled ? 0 : 1,
      a.turnId,
      // The words of a cleared answer never were stored: the mark says the clear took them.
      outcome.kind === 'cleared' ? a.stored : null,
    ),
    env.DB.prepare(
      'INSERT INTO thought_calls (thought_id, n, req_bytes, res_bytes, req_sha256, res_sha256, signature, sig_kind, signer, completion_id, tokens_in, tokens_out, tokens_reasoning, cut) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      a.thoughtId,
      // No request bytes for a skilled answer: only the hash (`Skilled answer data` › «no request bytes»).
      outcome.skilled || outcome.kind === 'cleared' ? new Uint8Array(0) : answer.reqBytes,
      stopped || outcome.kind === 'cleared' ? new Uint8Array(0) : answer.resBytes,
      answer.reqSha,
      answer.resSha,
      signed.signature,
      signed.sigKind,
      signed.signer,
      answer.id,
      answer.tokensIn,
      answer.tokensOut,
      answer.tokensReasoning,
      answer.finishReason === 'length' ? 1 : 0,
    ),
  ];
  let hireAt: number | null = null;
  if (shown) {
    hireAt = statements.length;
    statements.push(
      env.DB.prepare(
        "INSERT INTO hires (id, turn_id, hirer_id, worker_id, worker_name, kind, mode, skilled, fee_yocto, fee_usd_micros, answer_thought_id, session_id, status, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'unbilled', ?13 WHERE COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?3), 0) = ?14 RETURNING id",
      ).bind(
        randomId(),
        a.turnId,
        a.payerId,
        a.worker.id,
        a.worker.name,
        a.hire.kind,
        a.hire.mode,
        outcome.skilled ? 1 : 0,
        a.fee.toString(),
        yoctoMicros(env, a.fee),
        a.thoughtId,
        a.sessionId,
        a.stored,
        a.epoch,
      ),
    );
  }
  // The owner may have cleared the memory while the worker was answering: the words go, the receipt stays.
  statements.push(...eraseIfCleared(env.DB, a.payerId, a.thoughtId, a.epoch, a.stored));
  return { statements, hireAt };
}
