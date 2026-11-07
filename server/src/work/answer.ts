// The worker's answer: the one call path of advice and of a pet's hire (`Hire request data`, `Worker rule`,
// `Skilled answer data`, ADR-011, ADR-023). `workerCall` builds the worker's own request, sends it, checks the model's
// signature and the leak filter, settles the worker's place of the day and the project's spend, and says what came of
// it. It stores nothing of the asker's: the caller writes the thought and the hire in its own batch.
//
// The data step (`add-pet-errands`, `Adapter call rule`, ADR-023, ADR-024): a worker whose skill has data sources or code gets
// one call first that may ask for them (label `data`), then the answer call with what they brought as quoted data; both
// calls are on the worker's receipt. A tool that fails ends the job with no answer and no fee (`data_failed`).
import type { PetRecord } from '../chain';
import { utcDay } from '../http';
import { hasVisible } from '../name/clean';
import { complete, replyOf, signatureOf } from '../nearai';
import { eraseIfCleared, memoryEpoch } from '../pet/forget';
import { energyLeft, moodOf, noteDeed, noteMood, readLife, spendEnergy } from '../pet/life';
import { wornOf } from '../pet/outfits';
import { foodState } from '../pet/view';
import { ceilingFor, ceilingPrice, fullness, thoughtPrice, usd12ToMicros } from '../pricing';
import { DATA_CALL_LINE, inputBound, MARKET_LINE, RETELL_LINE, workerMessages, type Exchange } from '../prompt';
import { setPause } from '../servicePause';
import { DATA_MAX_TOKENS, loadOffer, numbered, runDataStep, sourceLabelsOf, type Read } from '../sources/step';
import { callsUsd12, CHAT_TIMEOUT_MS, countEmpty, FREE_EMPTY_ANSWERS, hex, projectPays, randomId, refusalOf, yoctoMicros, type Answer, type SignedCall } from '../spend';
import { track } from '../track';
import { approvedWorkNotes, workNoteData } from '../experience/use';
import { pairInstruction, parseReaction } from '../society/reaction';
import type { Stance, Reaction } from '../society/relations';
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
  /** Whose job calls the worker: the events of its data say so (`adapter_called`, `skill_code_ran`). */
  job: 'hire' | 'advice';
  pair?: { payerName: string; stance: Stance };
}

/** What the answer call was told beside the question: the data call that preceded it, and the data sources it read. */
export interface WithData {
  /** The worker's data call, signed, when one was made: call `n = 0` of the receipt, label `data`. */
  data: SignedCall | null;
  /** A private approved note entered this request; its request bytes must never leave the Worker. */
  experience?: boolean;
}

export type WorkerOutcome =
  // Signed, a line, the filter passed: the caller shows it and the fee is owed. `labels`: the data sources it read.
  | ({ kind: 'answer'; reply: string; call: SignedCall; price: bigint; skilled: boolean; labels: string[]; reaction: Reaction | null } & WithData)
  // Signed and a line, but the paying pet's memory was cleared while the worker answered: the words are not kept,
  // no fee is owed, the worker earns nothing and its place is back; the paying pet pays the call by usage.
  | ({ kind: 'cleared'; call: SignedCall; price: bigint; skilled: boolean } & WithData)
  // Signed, with no line (or stopped by the filter), the paying pet's fourth of the day or later: it pays the call
  // by usage, no fee. `stopped` says the reply held the instruction: its bytes must not be kept. `only: 'data'`: the
  // call is a data call that failed (`data_failed`, paid), the whole of the receipt.
  | ({ kind: 'empty'; call: SignedCall; price: bigint; skilled: boolean; stopped: boolean; only?: 'data' } & WithData)
  // A data source or the code did not give its data (`Adapter call rule`): no answer call, no fee, the place is back.
  // `call` is the data call, `price` its usage (cut under the fee), `paid` whether the paying pet pays it (past its three
  // failed calls of the UTC day) or the project does; `labels` are those that failed.
  | { kind: 'data_failed'; call: SignedCall; price: bigint; paid: boolean; labels: string[] }
  // Nothing to show and nothing owed: the place is back, the project paid what it had to.
  | { kind: 'failed'; code: 'ai_unavailable' | 'paused' };

/** The paying pet's thought for a data call that failed past its three: a thought with no reply whose receipt is the data
 * call (`Adapter call rule` › «data failed in a hire, past three»). */
export function dataOnly(out: Extract<WorkerOutcome, { kind: 'data_failed' }>): Extract<WorkerOutcome, { kind: 'empty' }> {
  return { kind: 'empty', call: out.call, data: null, price: out.price, skilled: true, stopped: false, only: 'data' };
}

/** The worker is out of Auto until 00:00 UTC (`Data source call data` › «a failed worker in Auto»): a mark by token id and
 * day that holds no words. */
async function markDataFailed(env: Env, workerId: string, day: number): Promise<void> {
  await env.DB.prepare('UPDATE worker_answers SET data_failed = 1 WHERE token_id = ? AND day = ?').bind(workerId, day).run();
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
  const layers = { mood: moodOf(fullness(food.eff).state, life.moodDay, today), energyPercent: energyLeft(life, today) * 10, outfit: await wornOf(env.DB, worker.id) };
  const notes = await approvedWorkNotes(env.DB, worker.id, worker.pet);
  const noteData = workNoteData(notes);

  // The data step: the worker's data call and the tools it asks for, run by the server. The call is cheaper than the fee
  // by construction, like the answer; a worker with no data to read makes none (`Adapter call rule`).
  let data: SignedCall | null = null;
  let reads: Read[] = [];
  const offer = skill === null ? null : await loadOffer(env, worker.id);
  if (offer !== null && skill !== null) {
    const dataMessages = workerMessages(worker.pet, ask.question + noteData, layers, skill.instruction, [DATA_CALL_LINE], ask.prior ?? null);
    const dataBound = inputBound(dataMessages) + offer.toolsBytes;
    const dataTokens = ceilingFor(env, dataBound, ask.fee - 1n, DATA_MAX_TOKENS);
    if (dataTokens < 1) return back({ kind: 'failed', code: 'ai_unavailable' });
    const step = await runDataStep(env, offer, { tokenId: worker.id, job: ask.job, messages: dataMessages, maxTokens: dataTokens, bound: dataBound });
    if (step.kind === 'paused') {
      await setPause(env.DB, 'ai', Date.now());
      console.log('ai_402');
      return back({ kind: 'failed', code: 'paused' });
    }
    if (step.kind === 'lost') return back({ kind: 'failed', code: 'ai_unavailable' });
    data = step.call;
    reads = step.reads;
    if (step.failed.length > 0) return back(await dataFailed(env, ask, data, step.failed));
  }
  const dataTokens = data === null ? [] : [{ tokensIn: data.answer.tokensIn, tokensOut: data.answer.tokensOut }];
  const dataAnswers = data === null ? [] : [data.answer];
  const labels = sourceLabelsOf(reads);

  const messages = workerMessages(
    worker.pet,
    ask.question + noteData,
    layers,
    skill?.instruction ?? null,
    [...(reads.length === 0 ? [] : [RETELL_LINE, MARKET_LINE]), ...(ask.pair === undefined ? [] : [pairInstruction(ask.pair.payerName, worker.pet.name, ask.pair.stance)])],
    ask.prior ?? null,
    numbered(reads),
  );
  const bound = inputBound(messages);
  // Cheaper than the fee by construction: the ceiling is what the fee less one yocto, less the data call's price, pays at
  // this input (the gas share is in the data call's price already).
  const maxTokens = ceilingFor(env, bound, ask.fee - 1n - thoughtPriceOf(env, dataTokens), MAX_ANSWER_TOKENS, data === null);
  if (maxTokens < 1) {
    await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, dataAnswers)));
    return back({ kind: 'failed', code: 'ai_unavailable' });
  }

  // A skilled request carries a fresh 128-bit value outside `messages`, kept nowhere: no guess at the instruction
  // can match the public hash of the request (`Skilled answer data` › «a guess at the instruction»).
  const nonce = skill === null ? undefined : hex(crypto.getRandomValues(new Uint8Array(16)));
  const result = await complete(env, { messages, maxTokens, thinking: false, timeoutMs: CHAT_TIMEOUT_MS, ...(nonce === undefined ? {} : { extra: { nonce } }) });
  const failure = await refusalOf(env, result, ceilingPrice(env, bound, maxTokens, data === null), dataAnswers);
  if (failure !== null) return back({ kind: 'failed', code: 'code' in failure && failure.code === 'paused' ? 'paused' : 'ai_unavailable' });
  const answer = result as Answer;

  const signed = await signatureOf(env, answer);
  if (signed === null) {
    // The tokens were used and nobody can prove the answer: the project pays them.
    await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, [...dataAnswers, answer])));
    console.log('signature_missing');
    return back({ kind: 'failed', code: 'ai_unavailable' });
  }
  const call: SignedCall = { answer, signed };

  const parsed = parseReaction(replyOf(answer.content));
  const reply = parsed.reply;
  const stopped = (skill !== null && quotesInstruction(skill.instruction, reply))
    || notes.some((note) => quotesInstruction(note, reply));
  const empty = stopped || !hasVisible(reply);
  const skilled = skill !== null;
  // By usage, and never as high as the fee: what the answer cost above it was the project's.
  const usage = thoughtPrice(env, [...dataTokens, { tokensIn: answer.tokensIn, tokensOut: answer.tokensOut }]);
  const price = usage < ask.fee ? usage : ask.fee - 1n;
  if (usage > price) {
    await projectPays(env, 'edge', yoctoMicros(env, usage - price));
    console.log('worker_over_fee');
  }

  if (empty) {
    // An answer with no line, or a stopped one, counts toward the paying pet's three of the UTC day.
    const n = await countEmpty(env, ask.payerId, utcDay(Date.now()));
    if (n <= FREE_EMPTY_ANSWERS) {
      await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, [...dataAnswers, answer])));
      console.log(stopped ? 'worker_stopped' : 'worker_empty_free');
      return back({ kind: 'failed', code: 'ai_unavailable' });
    }
    // The fourth: the pet pays the call by usage, but nothing reached the asker, so the worker's place goes back and
    // its count and price stay (`Hire quote data` › «no answer»; §8 › Ответы работника за день counts shown answers).
    console.log(stopped ? 'worker_stopped' : 'worker_empty_paid');
    return back({ kind: 'empty', call, data, price, skilled, stopped,
      ...(notes.length > 0 ? { experience: true } : {}) });
  }

  // The paying pet's memory was cleared since its job was claimed: nobody keeps this answer, so the worker did no
  // work worth a place, a step of energy or a deed (`Hire quote data` › «no answer»).
  if (ask.payerEpoch !== undefined && (await memoryEpoch(env.DB, ask.payerId)) !== ask.payerEpoch) {
    console.log('worker_cleared');
    return back({ kind: 'cleared', call, data, price, skilled,
      ...(notes.length > 0 ? { experience: true } : {}) });
  }

  // The work itself: a step of energy, a better mood, a deed of the day, never a counted day (`Worker rule`).
  await spendEnergy(env.DB, worker.id, 'work', Date.now());
  await env.DB.batch([...noteMood(env.DB, worker.id, utcDay(Date.now())), ...noteDeed(env.DB, worker.id, 'work')]);
  await answered(env, worker.id, ask.day);
  return { kind: 'answer', reply, reaction: parsed.reaction, call, data, price, skilled, labels,
    ...(notes.length > 0 ? { experience: true } : {}) };
}

const thoughtPriceOf = (env: Env, calls: { tokensIn: number; tokensOut: number }[]): bigint => (calls.length === 0 ? 0n : thoughtPrice(env, calls));

/** A tool of the worker's skill gave no data (`Adapter call rule` › «data failed in a hire», «…, past three»): no answer
 * call, no fee. The paying pet's three failed calls of the UTC day decide who pays the data call — the project among the
 * first three, the paying pet by usage from the fourth — and the worker is out of Auto until 00:00 UTC. */
async function dataFailed(env: Env, ask: WorkerAsk, call: SignedCall, labels: string[]): Promise<WorkerOutcome> {
  const n = await countEmpty(env, ask.payerId, utcDay(Date.now()));
  await markDataFailed(env, ask.worker.id, ask.day);
  const usage = thoughtPrice(env, [{ tokensIn: call.answer.tokensIn, tokensOut: call.answer.tokensOut }]);
  const price = usage < ask.fee ? usage : ask.fee - 1n;
  const paid = n > FREE_EMPTY_ANSWERS;
  if (!paid) await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, [call.answer])));
  else if (usage > price) await projectPays(env, 'edge', yoctoMicros(env, usage - price));
  console.log(paid ? 'worker_data_failed_paid' : 'worker_data_failed');
  track('thought_failed', { for: 'hirer', payer: paid ? 'pet' : 'project', cost_usd: Number(callsUsd12(env, [call.answer])) / 1e12 });
  return { kind: 'data_failed', call, price, paid, labels };
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
  outcome: Exclude<WorkerOutcome, { kind: 'failed' } | { kind: 'data_failed' }>;
  fee: bigint;
  discounted?: boolean;
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
  const stopped = outcome.kind === 'empty' && outcome.stopped;
  const statements = [
    env.DB.prepare(
      "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, cut, reasked, payer, session_id, status, worker_id, worker_name, skilled, recall, turn_id, erased_at, data_labels, near_usd_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'pet', ?, 'unbilled', ?, ?, ?, ?, ?, ?, ?, ?)",
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
      // The data sources the shown answer read, for the line under it (`Adapter call rule` › «hired answer line»).
      shown && outcome.labels.length > 0 ? JSON.stringify(outcome.labels) : null,
      env.NEAR_USD_RATE,
    ),
    // The receipt: the worker's data call first (label `data`), then the call that answers (label `report` beside a data
    // call, as an errand's; none otherwise). A data call that failed past three is the whole of its receipt.
    ...[
      ...(outcome.data === null ? [] : [{ ...outcome.data, label: 'data' as string | null }]),
      { ...outcome.call, label: outcome.kind === 'empty' && outcome.only === 'data' ? 'data' : outcome.data === null ? null : 'report' },
    ].map(({ answer, signed, label }, n) =>
      env.DB.prepare(
        'INSERT INTO thought_calls (thought_id, n, req_bytes, res_bytes, req_sha256, res_sha256, signature, sig_kind, signer, completion_id, tokens_in, tokens_out, tokens_reasoning, cut, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        a.thoughtId,
        n,
        // No request bytes for a skilled answer: only the hash (`Skilled answer data` › «no request bytes»).
        outcome.skilled || outcome.experience || outcome.kind === 'cleared' ? new Uint8Array(0) : answer.reqBytes,
        // A worker's data call can quote the skill too; its content is never needed after the answer call.
        stopped || outcome.kind === 'cleared' || label === 'data' ? new Uint8Array(0) : answer.resBytes,
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
        label,
      ),
    ),
  ];
  let hireAt: number | null = null;
  if (shown) {
    hireAt = statements.length;
    statements.push(
      env.DB.prepare(
        "INSERT INTO hires (id, turn_id, hirer_id, worker_id, worker_name, kind, mode, skilled, fee_yocto, fee_usd_micros, answer_thought_id, session_id, status, created_at, experience, society_reaction, society_payer_epoch, society_worker_epoch, society_discounted) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'unbilled', ?13, ?15, ?16, ?14, COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?4), 0), ?17 WHERE COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?3), 0) = ?14 RETURNING id",
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
        outcome.experience ? 1 : 0,
        outcome.reaction ?? null,
        a.discounted ? 1 : 0,
      ),
    );
  }
  // The owner may have cleared the memory while the worker was answering: the words go, the receipt stays.
  statements.push(...eraseIfCleared(env.DB, a.payerId, a.thoughtId, a.epoch, a.stored));
  return { statements, hireAt };
}
