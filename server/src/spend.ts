// One thought the pet pays, start to finish: the checks in their order (the cap, the edge of sleep,
// the ceiling), the reserve, the call, the signature, the price by usage, what is stored, and the
// state after (asleep, tired). `PetDesk` runs one of these at a time per pet (Thought queue data),
// so the numbers read here are exact with the previous thought already in.
import { ChainUnreachable, petView, type PetRecord } from './chain';
import { utcDay } from './http';
import { complete, replyOf, signatureOf, type CallResult, type Message, type Signed } from './nearai';
import { hasVisible } from './name/clean';
import { eraseIfCleared, memoryEpoch } from './pet/forget';
import { energyLeft, energyOf, moodOf, planCount, readLife, replyStatements } from './pet/life';
import { wornOf } from './pet/outfits';
import { DIARY_WINDOW_MS } from './pet/ritual';
import { foodState, markTired, type FoodState } from './pet/view';
import {
  callUsd12,
  ceilingFor,
  ceilingPrice,
  EDGE_CEILING,
  FUSE_CHAT,
  FUSE_DEEP,
  fullness,
  HIRE_AUTO_LIMIT_YOCTO,
  MAX_THOUGHT_PRICE_YOCTO,
  minCallPrice,
  nearUsdRate,
  thoughtPrice,
  usd12ToMicros,
  yoctoToUsdMicros,
} from './pricing';
import { buildMessages, hireLayer, inputBound, parseAsk, type Hired, type ThoughtJob } from './prompt';
import { gasIsLow, isPaused, setPause } from './servicePause';
import { track } from './track';
import { findCandidates, type Candidate } from './work/candidates';
import { continueHire } from './work/hire';
import { hireModeOf, type HireMode } from './work/mode';

export type RefusalCode =
  | 'ai_unavailable'
  | 'empty_paid'
  | 'asleep'
  | 'tired'
  | 'no_energy'
  | 'too_hungry'
  | 'paused'
  | 'chain_unreachable'
  | 'no_pet'
  | 'late'
  // an advice (`Advice flow`): the paying pet can't pay, the friend's pet is asleep or resting
  | 'short'
  | 'worker_asleep'
  | 'worker_resting'
  // the paying pet's memory was cleared while the answer was on its way: its words are not kept (`Memory deletion data`)
  | 'memory_cleared'
  // a pet's own hire: the worker answered and its fee stands, the pet's own reply did not come (`Pet hire flow` › «свой ответ не пришёл»)
  | 'own_lost'
  // a pet in Manual chose a known pet: the turn stops at the offer (`Pet hire flow` › «предложение в Manual»)
  | 'offer'
  // a tap on an offer, or on «Try again» of a lost reply, that found nothing to answer (a stale tab: the routes refuse first)
  | 'no_offer'
  | 'no_hire'
  // an errand ended without a report (`errands/run.ts`): its reason is on the errand row, which the page reads
  | 'errand_failed'
  // an advice whose worker's data source or code gave no data (`Adapter call rule`): no answer, no fee, the question is kept
  | 'data_failed';

export type JobResult =
  // `turn`: the turn of a hire whose own reply was lost, for the page's «Try again» (`own_lost`)
  // `price`: what an errand whose report was not kept still cost (`Errand flow` › «memory cleared on the way»)
  // `paid`: for `data_failed`, whether the paying pet paid the data call (past its three failed calls of the day)
  | { code: RefusalCode; events?: string[]; turn?: string; price?: string; paid?: boolean }
  // the worker's price is above the one shown: nothing held or spent, the price now (`Hire quote data`)
  | { code: 'price_rose'; price: string }
  | { thoughtId: string; cut: 'fuse' | 'food' | 'cap' | null; price: string; reasked: boolean; events: string[] };

export const CHAT_TIMEOUT_MS = 60_000;
const DEEP_TIMEOUT_MS = 90_000;
/** After this many empty answers of a pet in a UTC day the pet pays for the next (Thought request data). */
export const FREE_EMPTY_ANSWERS = 3;

export type Answer = Extract<CallResult, { kind: 'answer' }>;
export interface SignedCall {
  answer: Answer;
  signed: Signed;
}

export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export const randomId = () => hex(crypto.getRandomValues(new Uint8Array(12)));

export async function projectPays(env: Env, kind: string, micros: number): Promise<void> {
  if (micros <= 0) return;
  await env.DB.prepare('INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, ?, ?)').bind(Date.now(), kind, micros).run();
}

export function yoctoMicros(env: Env, yocto: bigint): number {
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  return rate === null ? 0 : yoctoToUsdMicros(yocto, rate);
}

/** Calls nobody pays for, in USD: every token they used plus one gas share. */
export function callsUsd12(env: Env, answers: Answer[]): bigint {
  let total = 0n;
  answers.forEach((a, i) => {
    const one = callUsd12(env, a.tokensIn, a.tokensOut);
    // the gas share is one per thought: count it only once
    total += i === 0 ? one : one - callUsd12(env, 0, 0);
  });
  return total;
}

/** The ceiling of a call and the limit that sets it, for the `cut` flag of an answer that reaches it. */
export interface Plan {
  ceiling: number;
  cutKind: 'fuse' | 'food' | 'cap';
  edge: boolean;
}

export function planOf(env: Env, bound: number, fs: FoodState, fuse: number, setAside: bigint): Plan {
  const minCall = minCallPrice(env, bound);
  // From the room, not the food: a purchase that has gone out and has no outcome yet is held.
  if (fs.room < minCall) return { ceiling: EDGE_CEILING, cutKind: 'food', edge: true };
  const food = ceilingFor(env, bound, fs.room - setAside, fuse);
  const cap = ceilingFor(env, bound, fs.capLeft - setAside, fuse);
  const thought = ceilingFor(env, bound, MAX_THOUGHT_PRICE_YOCTO - setAside, fuse);
  const ceiling = Math.max(1, Math.min(fuse, food, cap, thought));
  const fuseLimit = Math.min(fuse, thought);
  const cutKind = ceiling === fuseLimit && fuseLimit <= food && fuseLimit <= cap ? 'fuse' : cap < food ? 'cap' : 'food';
  return { ceiling, cutKind, edge: false };
}

export async function openSession(env: Env, tokenId: string, now: number): Promise<string> {
  const open = await env.DB.prepare("SELECT id FROM debit_sessions WHERE token_id = ? AND status = 'open' AND day = ?")
    .bind(tokenId, utcDay(now))
    .first<{ id: string }>();
  if (open !== null) {
    await env.DB.prepare('UPDATE debit_sessions SET last_at = ? WHERE id = ?').bind(now, open.id).run();
    return open.id;
  }
  const id = randomId();
  await env.DB.prepare("INSERT INTO debit_sessions (id, token_id, day, opened_at, last_at, status) VALUES (?, ?, ?, ?, ?, 'open')")
    .bind(id, tokenId, utcDay(now), now, now)
    .run();
  return id;
}

/** Counts an empty answer of the pet today; the number it is, atomically. */
export async function countEmpty(env: Env, tokenId: string, day: number): Promise<number> {
  const row = await env.DB.prepare(
    'INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 1) ON CONFLICT (token_id, day) DO UPDATE SET n = n + 1 RETURNING n',
  )
    .bind(tokenId, day)
    .first<{ n: number }>();
  return row?.n ?? 1;
}

/** One turn of a hire, as the pet's own reply after the worker (or after a hire that did not happen) sees it: the
 * turn's id, whether its lines are told to the pet later (`recall`, 0 for a skilled worker's turn), and the worker's
 * words to answer from. Such a reply offers no candidates (`Hire request data` › «свой ответ после работника»). */
export interface Turn {
  id: string;
  recall: 0 | 1;
  hired?: Hired;
}

/** What only the desk and a hire turn pass to `run`: the job's row (for what a reloaded page shows of it) and the
 * turn an own reply belongs to. */
export interface RunOpts {
  jobId?: string;
  turn?: Turn;
  ownerAccount?: string;
}

/** Runs one thought. `job` is what the queue holds; the answer is stored in `jobs.result` (codes,
 * ids and numbers — never the text of a line). `epoch` is `pets.memory_epoch` as it stood when the
 * job was claimed (the desk takes it in the claiming statement); a caller with no claim reads it now. */
export async function run(env: Env, tokenId: string, job: ThoughtJob, epoch?: number, opts: RunOpts = {}): Promise<JobResult> {
  const now = Date.now();
  // A diary claimed after its window is refused with nothing read and nothing spent: the screen has said
  // «couldn't write» (`Daily ritual flow` › «дневник не написан»). One claimed before the window may land
  // a call's length after it.
  if (job.kind === 'diary' && now - utcDay(now) * 86_400_000 >= DIARY_WINDOW_MS) return { code: 'late' };
  const heldEpoch = epoch ?? (await memoryEpoch(env.DB, tokenId));
  if (await isPaused(env.DB, 'thought')) return { code: 'paused' };

  let pet: PetRecord | null;
  try {
    // The server's gas is read before a thought: a low balance pauses now, not at the next minute.
    if (await gasIsLow(env, now)) return { code: 'paused' };
    pet = await petView(env, tokenId);
  } catch (e) {
    if (e instanceof ChainUnreachable) return { code: 'chain_unreachable' };
    throw e;
  }
  if (pet === null) return { code: 'no_pet' };
  if (opts.ownerAccount !== undefined && pet.owner_id !== opts.ownerAccount) return { code: 'no_pet' };
  await env.DB.prepare('INSERT OR IGNORE INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)')
    .bind(tokenId, pet.owner_id, now, '')
    .run();

  // «Устал» holds to 00:00 UTC: after a refusal or a cut by the cap, a shorter line does not get through either.
  const tired = await env.DB.prepare('SELECT tired_day FROM pets WHERE token_id = ?').bind(tokenId).first<{ tired_day: number | null }>();
  if (tired?.tired_day != null && tired.tired_day >= utcDay(now)) return { code: 'tired' };

  const fs = await foodState(env.DB, tokenId, pet, now);
  const deep = job.kind === 'reply' && job.mode === 'deep';
  const state = fullness(fs.eff).state;
  if (state === 'asleep') return { code: 'asleep' };
  // At zero energy «Think hard» is refused with the energy's words, also on a hungry pet; nothing is
  // reserved or called, and a second queued deep job meets the same check (`Energy rule`).
  const today = utcDay(now);
  const life = await readLife(env.DB, tokenId);
  const energy = energyLeft(life, today);
  if (deep && energy === 0) return { code: 'no_energy' };
  if (deep && state !== 'full') return { code: 'too_hungry' };

  // `heldEpoch` is older than the memory is read: a clear that lands after the claim makes the
  // answer's words unwanted (`think` erases them with the thought's own batch); one before the claim
  // failed the job and never got here.
  // A pet in Auto that is awake and full may hire in an ordinary chat turn: the known pets it may ask go into the
  // same call as data (`Pet hire flow`); in Manual too, where a choice becomes an offer for the owner. With none the
  // call is the ordinary one, byte for byte. The mode is the one the turn began with: a switch is for the next turn.
  let candidates: Candidate[] = [];
  let hireMode: HireMode = 'auto';
  if (opts.turn === undefined && job.kind === 'reply' && job.mode === 'chat') {
    hireMode = await hireModeOf(env.DB, tokenId);
    candidates = await findCandidates(env, { tokenId, pet, food: fs }, hireMode, now);
  }
  const messages = await buildMessages(
    env.DB,
    tokenId,
    pet,
    job,
    { mood: moodOf(state, life.moodDay, today), energyPercent: energy * 10, outfit: await wornOf(env.DB, tokenId) },
    { ...(candidates.length > 0 ? { hire: hireLayer(candidates) } : {}), ...(opts.turn?.hired === undefined ? {} : { hired: opts.turn.hired }) },
  );
  const bound = inputBound(messages);
  const minCall = minCallPrice(env, bound);
  // The re-ask of «Think hard» is paid before the first call is allowed to eat the room: 40 output
  // tokens at its input, no second gas share.
  const reaskMin = deep ? ceilingPrice(env, bound, EDGE_CEILING, false) : 0n;

  // 1. The daily cap first: with no room for even the cheapest call there is no call and no spend.
  if (fs.capLeft < minCall + reaskMin) {
    await markTired(env.DB, tokenId, now);
    track('daily_cap_reached');
    return { code: 'tired', events: ['daily_cap_reached'] };
  }

  // 2/3. The edge of sleep, or the ceiling (design.md › «The call with a 40-token ceiling»).
  const fuse = deep ? FUSE_DEEP : FUSE_CHAT;
  const plan = planOf(env, bound, fs, fuse, reaskMin);
  const reserve = ceilingPrice(env, bound, plan.ceiling) + reaskMin;
  await env.DB.prepare('INSERT OR REPLACE INTO pet_spend (token_id, reserve_yocto, job_id) VALUES (?, ?, ?)').bind(tokenId, reserve.toString(), null).run();
  try {
    return await think(env, tokenId, pet, job, fs, { messages, bound, plan, deep, reserve, epoch: heldEpoch, candidates, hireMode, opts });
  } finally {
    await env.DB.prepare('DELETE FROM pet_spend WHERE token_id = ?').bind(tokenId).run();
  }
}

interface Ctx {
  messages: Message[];
  bound: number;
  plan: Plan;
  deep: boolean;
  reserve: bigint;
  /** `pets.memory_epoch` as it stood before the request was built. */
  epoch: number;
  /** The known pets the call offered; none for the ordinary call. */
  candidates: Candidate[];
  /** How the pet hires in this turn: Auto goes on to the worker, Manual stops at an offer. */
  hireMode: HireMode;
  opts: RunOpts;
}

async function think(env: Env, tokenId: string, pet: PetRecord, job: ThoughtJob, fs: FoodState, ctx: Ctx): Promise<JobResult> {
  const { messages, bound, deep } = ctx;
  let plan = ctx.plan;
  const calls: SignedCall[] = [];
  const answers: Answer[] = [];

  // First call.
  if (ctx.opts.ownerAccount !== undefined) {
    const current = await petView(env, tokenId);
    if (current?.owner_id !== ctx.opts.ownerAccount) return { code: 'no_pet' };
  }
  const first = await complete(env, { messages, maxTokens: plan.ceiling, thinking: deep, timeoutMs: deep ? DEEP_TIMEOUT_MS : CHAT_TIMEOUT_MS });
  const failure = await refusalOf(env, first, ctx.reserve);
  if (failure !== null) return failure;
  const a1 = first as Answer;
  answers.push(a1);
  let reasked = false;

  let lastReply = replyOf(a1.content);
  // A reasoning that reached the ceiling and left no reply: the same request without reasoning, one
  // thought, one receipt (Deep thought flow › «переспрос»).
  if (deep && !hasVisible(lastReply) && a1.finishReason === 'length') {
    const spent = thoughtPrice(env, [{ tokensIn: a1.tokensIn, tokensOut: a1.tokensOut }]);
    const second = reaskPlan(env, bound, fs, spent);
    if (second !== null) {
      plan = second;
      const retry = await complete(env, { messages, maxTokens: second.ceiling, thinking: false, timeoutMs: CHAT_TIMEOUT_MS });
      const bad = await refusalOf(env, retry, ctx.reserve, answers);
      if (bad !== null) return bad;
      answers.push(retry as Answer);
      reasked = true;
      lastReply = replyOf((retry as Answer).content);
    }
  }

  // Every call of the thought needs its model signature before the reply may be shown.
  for (const answer of answers) {
    const signed = await signatureOf(env, answer);
    if (signed === null) {
      // The tokens were used and nobody can prove the answer: the project pays them.
      await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, answers)));
      console.log('signature_missing');
      return { code: 'ai_unavailable' };
    }
    calls.push({ answer, signed });
  }

  const now = Date.now();
  // The pet chose to ask one of the pets it was offered: this call is the decision thought of a hire, not a reply.
  const ask = ctx.candidates.length > 0 && job.kind === 'reply' ? parseAsk(lastReply, ctx.candidates.length) : null;
  const asked = ask === null ? null : ctx.candidates[ask.n - 1]!;
  const empty = ask === null && !hasVisible(lastReply);
  if (empty) {
    const n = await countEmpty(env, tokenId, utcDay(now));
    if (n <= FREE_EMPTY_ANSWERS) {
      await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, answers)));
      console.log('empty_free');
      return { code: 'ai_unavailable' };
    }
  }

  // The pet pays by usage; at the edge of sleep all it has left, and the project the difference. A purchase
  // held in `sending` or `unknown` takes its price out of `room` and brings a pet with food to this branch
  // too: it answers short at the project's cost until the purchase settles (a known risk, D-92).
  const usagePrice = thoughtPrice(env, answers.map((a) => ({ tokensIn: a.tokensIn, tokensOut: a.tokensOut })));
  let price = plan.edge ? fs.room : usagePrice;
  if (price > fs.room) price = fs.room;
  if (price > fs.capLeft) price = fs.capLeft;
  if (price > MAX_THOUGHT_PRICE_YOCTO) price = MAX_THOUGHT_PRICE_YOCTO;
  if (usagePrice > price) {
    await projectPays(env, 'edge', yoctoMicros(env, usagePrice - price));
    console.log('thought_edge');
  }

  const lastAnswer = answers[answers.length - 1]!;
  const cut = !empty && ask === null && lastAnswer.finishReason === 'length' ? plan.cutKind : null;
  // The answer to the question of the day is a reply of its own kind (§8 › Мысль: «ответ на вопрос дня»);
  // it lives as any reply does (`lives` below). It is the day's question only when it lands in the same UTC
  // day: one that lands after midnight is an ordinary reply (`Daily ritual flow`).
  const isQuestion = job.kind === 'reply' && job.question !== undefined && job.question === utcDay(now);
  const kind = ask !== null ? 'hire_question' : job.kind === 'reply' ? (job.mode === 'deep' ? 'deep' : isQuestion ? 'question' : 'reply') : job.kind;
  const questionDone = isQuestion && !empty && ask === null;
  const turnId = ask !== null ? randomId() : (ctx.opts.turn?.id ?? null);
  const thoughtId = randomId();
  const sessionId = await openSession(env, tokenId, now);
  // A visible reply of the owner's line is a deed of the day: the mood, the counted day with the
  // transition it starts, a «Think hard» step. A greeting, a wake thought, a diary and a thought that
  // did not come (the empty one is among them) do none of it. All in the thought's own batch.
  const lives = job.kind === 'reply' && !empty && ask === null;
  const life = lives
    ? replyStatements(env.DB, tokenId, {
        today: utcDay(now),
        deep,
        count: await planCount(env, await readLife(env.DB, tokenId), pet, utcDay(now), deep),
        now,
      })
    : [];
  const statements = [
    env.DB.prepare(
      "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, cut, reasked, payer, session_id, status, worker_id, worker_name, skilled, recall, turn_id, near_usd_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pet', ?, 'unbilled', ?, ?, ?, ?, ?, ?)",
    ).bind(
      thoughtId,
      tokenId,
      now,
      kind,
      // An empty answer keeps neither the line (the player's message stays in their field) nor a reply.
      job.kind === 'reply' && !empty ? job.text : null,
      // The question the pet wrote to the worker is its words of the decision thought (`Pet hire flow`).
      empty ? null : ask !== null ? ask.question : lastReply.trim(),
      env.MODEL_ID,
      price.toString(),
      yoctoMicros(env, price),
      cut,
      reasked ? 1 : 0,
      sessionId,
      asked?.tokenId ?? null,
      asked?.name ?? null,
      // `skilled` says an answer was given under a skill: the pet's question to the worker is its own thought.
      0,
      asked !== null ? (asked.skilled ? 0 : 1) : (ctx.opts.turn?.recall ?? 1),
      turnId,
      env.NEAR_USD_RATE,
    ),
    ...calls.map(({ answer, signed }, n) =>
      env.DB.prepare(
        'INSERT INTO thought_calls (thought_id, n, req_bytes, res_bytes, req_sha256, res_sha256, signature, sig_kind, signer, completion_id, tokens_in, tokens_out, tokens_reasoning, cut) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        thoughtId,
        n,
        answer.reqBytes,
        answer.resBytes,
        answer.reqSha,
        answer.resSha,
        signed.signature,
        signed.sigKind,
        signed.signer,
        answer.id,
        answer.tokensIn,
        answer.tokensOut,
        answer.tokensReasoning,
        // Per call, as the receipt says: whether this call stopped at its ceiling.
        answer.finishReason === 'length' ? 1 : 0,
      ),
    ),
    // The owner may have cleared the memory while the model was answering: the words go, the receipt stays.
    ...eraseIfCleared(env.DB, tokenId, thoughtId, ctx.epoch, now),
    // Manual: the choice is an offer, one per pet, with the price now (not held) — unless a clear landed meanwhile
    // (`Hire access data` › «стёрта память при предложении»): the row says so itself.
    ...(ask !== null && asked !== null && turnId !== null && ctx.hireMode === 'manual'
      ? [
          env.DB.prepare(
            'INSERT OR REPLACE INTO hire_offers (token_id, turn_id, worker_id, worker_name, question, price_yocto, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?1), 0) = ?8',
          ).bind(tokenId, turnId, asked.tokenId, asked.name, ask.question, asked.price.toString(), now, ctx.epoch),
        ]
      : []),
    // The question is answered in the thought's own batch; a thought that did not come marks nothing.
    ...(questionDone
      ? [
          env.DB.prepare('INSERT INTO ritual_days (token_id, day, question_at) VALUES (?1, ?2, ?3) ON CONFLICT (token_id, day) DO UPDATE SET question_at = COALESCE(question_at, excluded.question_at)').bind(
            tokenId,
            utcDay(now),
            now,
          ),
        ]
      : []),
    // Last: a deep reply's step is the batch's last statement, whose `RETURNING` tells the last step.
    ...life,
  ];
  const written = await env.DB.batch(statements);
  if (lives && deep) energyOf(written.at(-1));
  if (questionDone) track('ritual_completed', { part: 'question' });

  // After the thought: asleep when the food is below one scale thought; tired when the cap ran out.
  const events: string[] = [];
  const left = fs.eff - price;
  if (fullness(left).state === 'asleep') {
    await env.DB.prepare('UPDATE pets SET slept_at = ? WHERE token_id = ? AND slept_at IS NULL').bind(now, tokenId).run();
    events.push('fell_asleep');
    track('pet_fell_asleep');
  }
  if (cut === 'cap' || fs.capLeft - price < minCallPrice(env, 0)) {
    await markTired(env.DB, tokenId, now);
    events.push('daily_cap_reached');
    track('daily_cap_reached');
  }
  if (empty) {
    console.log('empty_paid');
    return { code: 'empty_paid', events };
  }
  if (ask !== null && asked !== null && turnId !== null) {
    // The decision call's reserve is over: the worker's call and the pet's own reply reserve their own.
    await env.DB.prepare('DELETE FROM pet_spend WHERE token_id = ?').bind(tokenId).run();
    console.log('hire_asked');
    track('thought_delivered', { model: 'cheap', for: 'hire' });
    if (ctx.hireMode === 'manual') {
      // The turn stops here; nothing is spent beyond the decision thought. A clear that landed meanwhile left no offer.
      if (ctx.epoch !== (await memoryEpoch(env.DB, tokenId))) return { code: 'memory_cleared', events };
      console.log('hire_offered');
      return { code: 'offer', events };
    }
    return continueHire(env, {
      tokenId,
      job: job as Extract<ThoughtJob, { kind: 'reply' }>,
      jobId: ctx.opts.jobId,
      epoch: ctx.epoch,
      turnId,
      candidate: asked,
      question: ask.question,
      events,
      own: (turn) => run(env, tokenId, job, ctx.epoch, { turn }),
      mode: 'auto',
      ceiling: HIRE_AUTO_LIMIT_YOCTO,
    });
  }
  console.log('thought_ok');
  track('thought_delivered', { model: deep ? 'strong' : 'cheap', for: 'owner', ...(cut !== null ? { cut } : {}), ...(reasked ? { reasked: true } : {}) });
  return { thoughtId, cut, price: price.toString(), reasked, events };
}

/** The room the re-ask has: what the food, the cap and the thought's limit leave after the first
 * call's price, at its input, with no gas share of its own. Null when not even 40 tokens fit. */
export function reaskPlan(env: Env, bound: number, fs: FoodState, spent: bigint, fuse: number = FUSE_CHAT): Plan | null {
  const food = ceilingFor(env, bound, fs.room - spent, fuse, false);
  const cap = ceilingFor(env, bound, fs.capLeft - spent, fuse, false);
  const thought = ceilingFor(env, bound, MAX_THOUGHT_PRICE_YOCTO - spent, fuse, false);
  const ceiling = Math.min(fuse, food, cap, thought);
  if (ceiling < 1) return null;
  const fuseLimit = Math.min(fuse, thought);
  const cutKind = ceiling === fuseLimit && fuseLimit <= food && fuseLimit <= cap ? 'fuse' : cap < food ? 'cap' : 'food';
  return { ceiling, cutKind, edge: false };
}

/** What a call that is not an answer means for the job, with what it cost the project. */
export async function refusalOf(env: Env, result: CallResult, reserve: bigint, earlier: Answer[] = []): Promise<JobResult | null> {
  if (result.kind === 'answer') return null;
  if (result.kind === 'paused') {
    await setPause(env.DB, 'ai', Date.now());
    console.log('ai_402');
    return { code: 'paused' };
  }
  // The tokens of an earlier call of the thought were used and nobody will see the thought.
  if (earlier.length > 0) await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, earlier)));
  if (result.kind === 'timeout') {
    // Nobody saw the answer and the call may be billed: the project pays the price of the ceiling.
    await projectPays(env, 'no_thought', yoctoMicros(env, reserve));
    console.log('ai_timeout');
  } else {
    console.log(`ai_failed:${result.status}`);
  }
  return { code: 'ai_unavailable' };
}
