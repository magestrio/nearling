// One thought the pet pays, start to finish: the checks in their order (the cap, the edge of sleep,
// the ceiling), the reserve, the call, the signature, the price by usage, what is stored, and the
// state after (asleep, tired). `PetDesk` runs one of these at a time per pet (Thought queue data),
// so the numbers read here are exact with the previous thought already in.
import { ChainUnreachable, petView, type PetRecord } from './chain';
import { utcDay } from './http';
import { complete, replyOf, signatureOf, type CallResult, type Message, type Signed } from './nearai';
import { hasVisible } from './name/clean';
import { eraseIfCleared, memoryEpoch } from './pet/forget';
import { foodState, markTired, type FoodState } from './pet/view';
import {
  callUsd12,
  ceilingFor,
  ceilingPrice,
  EDGE_CEILING,
  FUSE_CHAT,
  FUSE_DEEP,
  fullness,
  MAX_THOUGHT_PRICE_YOCTO,
  minCallPrice,
  nearUsdRate,
  thoughtPrice,
  usd12ToMicros,
  yoctoToUsdMicros,
} from './pricing';
import { buildMessages, inputBound, type ThoughtJob } from './prompt';
import { gasIsLow, isPaused, setPause } from './servicePause';
import { track } from './track';

export type RefusalCode = 'ai_unavailable' | 'empty_paid' | 'asleep' | 'tired' | 'too_hungry' | 'paused' | 'chain_unreachable' | 'no_pet';

export type JobResult =
  | { code: RefusalCode; events?: string[] }
  | { thoughtId: string; cut: 'fuse' | 'food' | 'cap' | null; price: string; reasked: boolean; events: string[] };

const CHAT_TIMEOUT_MS = 60_000;
const DEEP_TIMEOUT_MS = 90_000;
/** After this many empty answers of a pet in a UTC day the pet pays for the next (Thought request data). */
const FREE_EMPTY_ANSWERS = 3;

type Answer = Extract<CallResult, { kind: 'answer' }>;
interface SignedCall {
  answer: Answer;
  signed: Signed;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomId = () => hex(crypto.getRandomValues(new Uint8Array(12)));

async function projectPays(env: Env, kind: string, micros: number): Promise<void> {
  if (micros <= 0) return;
  await env.DB.prepare('INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, ?, ?)').bind(Date.now(), kind, micros).run();
}

function yoctoMicros(env: Env, yocto: bigint): number {
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  return rate === null ? 0 : yoctoToUsdMicros(yocto, rate);
}

/** Calls nobody pays for, in USD: every token they used plus one gas share. */
function callsUsd12(env: Env, answers: Answer[]): bigint {
  let total = 0n;
  answers.forEach((a, i) => {
    const one = callUsd12(env, a.tokensIn, a.tokensOut);
    // the gas share is one per thought: count it only once
    total += i === 0 ? one : one - callUsd12(env, 0, 0);
  });
  return total;
}

/** The ceiling of a call and the limit that sets it, for the `cut` flag of an answer that reaches it. */
interface Plan {
  ceiling: number;
  cutKind: 'fuse' | 'food' | 'cap';
  edge: boolean;
}

function planOf(env: Env, bound: number, fs: FoodState, fuse: number, setAside: bigint): Plan {
  const minCall = minCallPrice(env, bound);
  if (fs.eff < minCall) return { ceiling: EDGE_CEILING, cutKind: 'food', edge: true };
  const food = ceilingFor(env, bound, fs.eff - setAside, fuse);
  const cap = ceilingFor(env, bound, fs.capLeft - setAside, fuse);
  const thought = ceilingFor(env, bound, MAX_THOUGHT_PRICE_YOCTO - setAside, fuse);
  const ceiling = Math.max(1, Math.min(fuse, food, cap, thought));
  const fuseLimit = Math.min(fuse, thought);
  const cutKind = ceiling === fuseLimit && fuseLimit <= food && fuseLimit <= cap ? 'fuse' : cap < food ? 'cap' : 'food';
  return { ceiling, cutKind, edge: false };
}

async function openSession(env: Env, tokenId: string, now: number): Promise<string> {
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
async function countEmpty(env: Env, tokenId: string, day: number): Promise<number> {
  const row = await env.DB.prepare(
    'INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 1) ON CONFLICT (token_id, day) DO UPDATE SET n = n + 1 RETURNING n',
  )
    .bind(tokenId, day)
    .first<{ n: number }>();
  return row?.n ?? 1;
}

/** Runs one thought. `job` is what the queue holds; the answer is stored in `jobs.result` (codes,
 * ids and numbers — never the text of a line). `epoch` is `pets.memory_epoch` as it stood when the
 * job was claimed (the desk takes it in the claiming statement); a caller with no claim reads it now. */
export async function run(env: Env, tokenId: string, job: ThoughtJob, epoch?: number): Promise<JobResult> {
  const now = Date.now();
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
  if (deep && state !== 'full') return { code: 'too_hungry' };

  // `heldEpoch` is older than the memory is read: a clear that lands after the claim makes the
  // answer's words unwanted (`think` erases them with the thought's own batch); one before the claim
  // failed the job and never got here.
  const messages = await buildMessages(env.DB, tokenId, pet, job);
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
    return await think(env, tokenId, pet, job, fs, { messages, bound, plan, deep, reserve, epoch: heldEpoch });
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
}

async function think(env: Env, tokenId: string, pet: PetRecord, job: ThoughtJob, fs: FoodState, ctx: Ctx): Promise<JobResult> {
  const { messages, bound, deep } = ctx;
  let plan = ctx.plan;
  const calls: SignedCall[] = [];
  const answers: Answer[] = [];

  // First call.
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
  const empty = !hasVisible(lastReply);
  if (empty) {
    const n = await countEmpty(env, tokenId, utcDay(now));
    if (n <= FREE_EMPTY_ANSWERS) {
      await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, answers)));
      console.log('empty_free');
      return { code: 'ai_unavailable' };
    }
  }

  // The pet pays by usage; at the edge of sleep all it has left, and the project the difference.
  const usagePrice = thoughtPrice(env, answers.map((a) => ({ tokensIn: a.tokensIn, tokensOut: a.tokensOut })));
  let price = plan.edge ? fs.eff : usagePrice;
  if (price > fs.eff) price = fs.eff;
  if (price > fs.capLeft) price = fs.capLeft;
  if (price > MAX_THOUGHT_PRICE_YOCTO) price = MAX_THOUGHT_PRICE_YOCTO;
  if (usagePrice > price) {
    await projectPays(env, 'edge', yoctoMicros(env, usagePrice - price));
    console.log('thought_edge');
  }

  const lastAnswer = answers[answers.length - 1]!;
  const cut = !empty && lastAnswer.finishReason === 'length' ? plan.cutKind : null;
  const kind = job.kind === 'reply' ? (job.mode === 'deep' ? 'deep' : 'reply') : job.kind;
  const thoughtId = randomId();
  const sessionId = await openSession(env, tokenId, now);
  const statements = [
    env.DB.prepare(
      "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, cut, reasked, payer, session_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pet', ?, 'unbilled')",
    ).bind(
      thoughtId,
      tokenId,
      now,
      kind,
      // An empty answer keeps neither the line (the player's message stays in their field) nor a reply.
      job.kind === 'reply' && !empty ? job.text : null,
      empty ? null : lastReply.trim(),
      env.MODEL_ID,
      price.toString(),
      yoctoMicros(env, price),
      cut,
      reasked ? 1 : 0,
      sessionId,
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
  ];
  await env.DB.batch(statements);

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
  console.log('thought_ok');
  track('thought_delivered', { model: deep ? 'strong' : 'cheap', for: 'owner', ...(cut !== null ? { cut } : {}), ...(reasked ? { reasked: true } : {}) });
  return { thoughtId, cut, price: price.toString(), reasked, events };
}

/** The room the re-ask has: what the food, the cap and the thought's limit leave after the first
 * call's price, at its input, with no gas share of its own. Null when not even 40 tokens fit. */
function reaskPlan(env: Env, bound: number, fs: FoodState, spent: bigint): Plan | null {
  const food = ceilingFor(env, bound, fs.eff - spent, FUSE_CHAT, false);
  const cap = ceilingFor(env, bound, fs.capLeft - spent, FUSE_CHAT, false);
  const thought = ceilingFor(env, bound, MAX_THOUGHT_PRICE_YOCTO - spent, FUSE_CHAT, false);
  const ceiling = Math.min(FUSE_CHAT, food, cap, thought);
  if (ceiling < 1) return null;
  const fuseLimit = Math.min(FUSE_CHAT, thought);
  const cutKind = ceiling === fuseLimit && fuseLimit <= food && fuseLimit <= cap ? 'fuse' : cap < food ? 'cap' : 'food';
  return { ceiling, cutKind, edge: false };
}

/** What a call that is not an answer means for the job, with what it cost the project. */
async function refusalOf(env: Env, result: CallResult, reserve: bigint, earlier: Answer[] = []): Promise<JobResult | null> {
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
