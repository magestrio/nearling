// The rest of a hire, after the pet chose to ask a known pet in its usual call (`Pet hire flow`) in Auto, or after the
// owner tapped «Ask {worker}» on a Manual offer (`work/offer.ts`): the checks again, the place of the worker's day,
// the worker's call, what the hirer's batch stores of it, and the pet's own reply with the worker's words. The
// decision thought is already stored by the caller (`spend.ts` › `think`); nothing here logs a word of a question or
// an answer.
import { ChainUnreachable, petView, type PetRecord } from '../chain';
import { utcDay } from '../http';
import { memoryEpoch } from '../pet/forget';
import { foodState } from '../pet/view';
import type { ThoughtJob } from '../prompt';
import { openSession, randomId, type JobResult, type Turn } from '../spend';
import { track } from '../track';
import { answerStatements, workerCall, type WorkerOutcome } from './answer';
import { checkWorker, type Candidate } from './candidates';
import { hold, priceOf } from './quote';

export interface HireTurn {
  tokenId: string;
  job: Extract<ThoughtJob, { kind: 'reply' }>;
  /** The row of the job, to tell a reloaded page who the pet is asking. */
  jobId: string | undefined;
  /** `memory_epoch` when the job was claimed. */
  epoch: number;
  turnId: string;
  /** The pet asked: its token id and its name (a Manual tap has no more of it than the offer kept). */
  candidate: Pick<Candidate, 'tokenId' | 'name'>;
  /** What the pet wrote to the worker, the words of its decision thought. */
  question: string;
  /** What the decision thought already found (asleep, cap): told with the result of the turn. */
  events: string[];
  /** The pet's own reply, a thought of its own that reads the turn (`run` with a turn). */
  own: (turn: Turn) => Promise<JobResult>;
  /** Auto: the pet decided by itself. Manual: the owner tapped «Ask {worker}» on the offer. */
  mode: 'auto' | 'manual';
  /** The most the hire may cost: Auto's limit, or the lower of the offer's price and the one the tap showed. */
  ceiling: bigint;
}

/** The Manual offer of the pet is answered: it goes, and the answer is counted once. */
export async function closeOffer(db: D1Database, tokenId: string, accepted: boolean): Promise<void> {
  const gone = await db.prepare('DELETE FROM hire_offers WHERE token_id = ? RETURNING token_id').bind(tokenId).first();
  if (gone !== null) track('hire_offer_answered', { accepted });
}

const eventsOf = (result: JobResult): string[] => ('events' in result ? (result.events ?? []) : []);

const withEvents = (result: JobResult, events: string[]): JobResult => ({ ...result, events: [...events, ...eventsOf(result)] }) as JobResult;

export async function continueHire(env: Env, t: HireTurn): Promise<JobResult> {
  // A clear that landed while the decision call was running: nobody keeps the turn, so the worker is not called.
  if (t.epoch !== (await memoryEpoch(env.DB, t.tokenId))) return { code: 'memory_cleared', events: t.events };
  if (t.jobId !== undefined) {
    await env.DB.prepare('UPDATE jobs SET progress = ? WHERE id = ?').bind(JSON.stringify({ asking: t.candidate.name }), t.jobId).run();
  }

  // The Manual offer is answered by what the tap brought: the worker's answer, or the pet's own reply. A price that rose takes a
  // new tap; a tap that brought neither (the AI provider down, an empty reply the pet paid for) leaves the offer standing, so
  // «Ask {worker}» and «No thanks» come back (`нажатая кнопка вернулась`).
  const answerOffer = async () => {
    if (t.mode === 'manual') await closeOffer(env.DB, t.tokenId, true);
  };
  const priceRose = async (price: bigint): Promise<JobResult> => {
    await env.DB.prepare('UPDATE hire_offers SET price_yocto = ? WHERE token_id = ?').bind(price.toString(), t.tokenId).run();
    console.log('hire_price_rose');
    return { code: 'price_rose', price: price.toString() };
  };

  // No hire after all: an event line of the turn and the pet's own reply, an ordinary thought from its food.
  const failed = async (code: 'failed' | 'empty'): Promise<JobResult> => {
    const eventId = randomId();
    await env.DB.prepare(
      "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status, worker_id, worker_name, turn_id) VALUES (?, ?, ?, 'hire_event', NULL, ?, '', '0', 0, 'project', 'project', ?, ?, ?)",
    )
      .bind(eventId, t.tokenId, Date.now(), code, t.candidate.tokenId, t.candidate.name, t.turnId)
      .run();
    const own = await t.own({ id: t.turnId, recall: 1 });
    if (t.mode === 'manual') {
      if ('thoughtId' in own || own.code === 'memory_cleared') await answerOffer();
      // no answer at all: the turn reads as before the tap, the offer's buttons back, the event line not told
      else await env.DB.prepare("DELETE FROM thoughts WHERE id = ? AND kind = 'hire_event'").bind(eventId).run();
    }
    return withEvents(own, t.events);
  };

  const now = Date.now();
  let hirer: PetRecord | null;
  let worker: PetRecord | null;
  try {
    [hirer, worker] = await Promise.all([petView(env, t.tokenId), petView(env, t.candidate.tokenId)]);
  } catch (e) {
    if (e instanceof ChainUnreachable) {
      console.log('hire_failed:chain');
      return failed('failed');
    }
    throw e;
  }
  if (hirer === null) return { code: 'no_pet', events: t.events };
  // The world moved since the candidates were read: awake, energy, a place, the pet's food after the decision thought.
  const check = await checkWorker(env, { tokenId: t.tokenId, pet: hirer, food: await foodState(env.DB, t.tokenId, hirer, now) }, t.candidate.tokenId, worker, t.mode, now);
  if (!check.ok || worker === null) {
    // A price that rose past the offer's can be why the pet's food no longer covers it: that is the price's news.
    if (t.mode === 'manual' && !check.ok && ['no_given_food', 'not_full', 'over_cap'].includes(check.why)) {
      const quote = await priceOf(env, t.candidate.tokenId, utcDay(now));
      if (quote.open && quote.yocto > t.ceiling) return priceRose(quote.yocto);
    }
    console.log(`hire_failed:${check.ok ? 'gone' : check.why}`);
    return failed('failed');
  }

  const day = utcDay(now);
  const held = await hold(env, t.candidate.tokenId, day, t.ceiling, now);
  if (!held.ok) {
    // A tap on an offer whose price rose spends nothing and names the new price (`price rose on an offer`).
    if (t.mode === 'manual' && held.open) return priceRose(held.price);
    console.log('hire_failed:price_rose');
    return failed('failed');
  }

  const out: WorkerOutcome = await workerCall(env, { worker: { id: t.candidate.tokenId, pet: worker }, question: t.question, fee: held.fee, payerId: t.tokenId, day, payerEpoch: t.epoch });
  if (out.kind === 'failed') {
    console.log(`hire_failed:${out.code}`);
    return out.code === 'paused' ? { code: 'paused', events: t.events } : failed('failed');
  }

  // What the hirer's batch stores: the worker's thought, and for a shown answer the hire (the fee). A cleared answer
  // has no fee and no hire; an empty one the pet pays by usage; neither is a hire (`Hire food data`).
  const stored = Date.now();
  const thoughtId = randomId();
  const { statements, hireAt } = answerStatements(env, {
    kind: 'hire_answer',
    payerId: t.tokenId,
    thoughtId,
    sessionId: await openSession(env, t.tokenId, stored),
    stored,
    playerText: null,
    worker: { id: t.candidate.tokenId, name: worker.name },
    outcome: out,
    fee: held.fee,
    hire: { kind: 'pet', mode: t.mode },
    turnId: t.turnId,
    epoch: t.epoch,
  });
  const written = await env.DB.batch(statements);
  if (out.kind === 'cleared' || (hireAt !== null && (written[hireAt]?.results.length ?? 0) === 0)) {
    console.log('hire_cleared');
    return { code: 'memory_cleared', events: t.events };
  }
  if (out.kind === 'empty') {
    console.log('hire_failed:empty');
    return failed('empty');
  }

  console.log('hire_ok');
  // the worker's answer is kept and paid for whatever the pet's own reply comes to: the offer is answered
  await answerOffer();
  track('thought_delivered', { model: 'cheap', for: 'hirer' });
  const own = await t.own({ id: t.turnId, recall: out.skilled ? 0 : 1, hired: { worker: worker.name, question: t.question, answer: out.reply, turnId: t.turnId } });
  // The worker's answer and its fee stand whatever came of the pet's own reply: "Try again" finishes it.
  return ownOrLost(own, t.turnId, t.events);
}

/** The result of the pet's own reply after a worker's answer: a thought, a clear that landed (nothing is left to
 * finish), or the reply lost — the worker's answer and its fee stand and «Try again» finishes it. */
export function ownOrLost(own: JobResult, turnId: string, events: string[]): JobResult {
  if ('thoughtId' in own || own.code === 'memory_cleared') return withEvents(own, events);
  return { code: 'own_lost', turn: turnId, events: [...events, ...eventsOf(own)] };
}
