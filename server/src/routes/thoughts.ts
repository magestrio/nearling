// The owner's conversation: a line in (`POST …/thoughts`), the first greeting, the poll of the pet's
// state and of a job's outcome, and the earlier lines. Every route reads the owner from the contract
// on each request, without a cache (Conversation access data); a signed-in player who is not the
// owner is turned away before anything is read, queued or sent (`403 not_owner`).
import { Hono } from 'hono';
import { ChainUnreachable, petView, stageOf, type PetRecord } from '../chain';
import { requireSession, TOKEN_ID, type AppContext, type AppEnv } from '../http';
import { hasVisible } from '../name/clean';
import { settleLate } from '../errands/late';
import { errandView, readErrand, awayErrand } from '../errands/store';
import { linkForToken } from '../gift/link';
import { desk, enqueueJob, jobOf } from '../pet/desk';
import { memoryEpoch } from '../pet/forget';
import { settleRitual } from '../pet/ritual';
import { ownerFields, wakeState } from '../pet/view';
import { pendingFriendWake, wakeIfFed } from '../pet/wake';
import { isPaused, pauseReason } from '../servicePause';
import { offerJobOnItsWay, standingOffer } from '../work/offer';
import { priceView } from '../work/quote';

export const thoughtRoutes = new Hono<AppEnv>();

/** A player's line: up to 500 code points, with at least one visible character. */
const MAX_LINE_CODE_POINTS = 500;
const CONVERSATION_PAGE = 50;
/** The event line of a hire that did not happen, by what its row says (`work/hire.ts`): the data lines are
 * `Adapter call rule` › «data failed in a hire» and «…, past three». */
const HIRE_EVENT_CODES: Record<string, string> = { empty: 'hire_empty', data_failed: 'hire_data_failed', data_failed_paid: 'hire_data_failed_paid', society_refused: 'society_refused', character_refused: 'character_refused' };

/** The owner's pet, or the response to send instead. */
export async function ownedPet(c: AppContext): Promise<{ pet: PetRecord; id: string } | Response> {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id') ?? '';
  if (!TOKEN_ID.test(id)) return c.json({ code: 'no_pet' }, 404);
  let pet: PetRecord | null;
  try {
    pet = await petView(c.env, id);
  } catch (e) {
    if (e instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw e;
  }
  if (pet === null) return c.json({ code: 'no_pet' }, 404);
  if (pet.owner_id !== session.accountId) {
    const known = await c.env.DB.prepare("SELECT 1 FROM known_pets WHERE account_id = ?1 AND token_id = ?2 AND reason = 'gift' UNION SELECT 1 FROM gift_flights WHERE sender = ?1 AND token_id = ?2 AND state = 'ok' LIMIT 1")
      .bind(session.accountId, id).first();
    if (known !== null) return c.json({ error: 'former_owner' }, 403);
    return c.json({ code: 'not_owner' }, 403);
  }
  return { pet, id };
}

/** The desk runs the queue now, and its alarm is the fallback. */
export function run(c: AppContext, tokenId: string): void {
  const stub = desk(c.env, tokenId);
  c.executionCtx.waitUntil(stub.process(tokenId));
  c.executionCtx.waitUntil(stub.arm(tokenId));
}

/** Ends the ritual and writes what is due to the chain after the response has gone: the response of a
 * part never waits for a transaction (two reads and a send, a minute at worst), and a mark that lands
 * later is `Streak rule` › «серия записана позже». A settle that fails is the cron's next minute. */
export function settleLater(c: AppContext, tokenId: string): void {
  c.executionCtx.waitUntil(
    settleRitual(c.env, tokenId).then(
      () => undefined,
      () => console.log('settle_failed'),
    ),
  );
}

thoughtRoutes.post('/api/pets/:id/thoughts', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ text?: unknown; mode?: unknown }>().catch(() => null);
  if (body === null || typeof body.text !== 'string' || (body.mode !== 'chat' && body.mode !== 'deep')) return c.json({ code: 'bad_request' }, 400);
  if ([...body.text].length > MAX_LINE_CODE_POINTS || !hasVisible(body.text)) return c.json({ code: 'bad_request' }, 400);

  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  // On a pause the line is not taken: nothing queued, reserved or spent.
  if (await isPaused(c.env.DB, 'thought')) return c.json({ code: 'paused' }, 409);
  // While the pet is off on an errand nothing is sent to it (`Errand flow` › «sent»); a stale tab's line stops here.
  if ((await awayErrand(c.env.DB, owned.id)) !== null) return c.json({ code: 'away' }, 409);

  // A Manual offer still standing is declined first, in the queue before the line: the pet answers its old line itself
  // and the new one goes next (`Pet hire flow` › «отказ в Manual»). An offer whose hirer is asleep goes at this read.
  if ((await standingOffer(c.env, owned.id, owned.pet)) !== null && !(await offerJobOnItsWay(c.env.DB, owned.id))) {
    await enqueueJob(c.env.DB, owned.id, { kind: 'decline', line: true }, session.accountId);
  }
  const job = await enqueueJob(c.env.DB, owned.id, { kind: 'reply', mode: body.mode, text: body.text }, session.accountId);
  run(c, owned.id);
  return c.json({ job }, 202);
});

// The first line of a newborn. The server queues it itself at birth; the client asks again on the
// empty Pet screen and this changes nothing if it is already there.
thoughtRoutes.post('/api/pets/:id/greeting', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  // A pet whose memory was cleared does not speak first again, even if its greeting never landed
  // (`Memory deletion flow` › «стёр»).
  if ((await memoryEpoch(c.env.DB, owned.id)) > 0) return c.json({ job: null }, 202);
  const existing = await c.env.DB.prepare(
    "SELECT id FROM jobs WHERE token_id = ? AND kind = 'greeting' AND status IN ('queued', 'running') ORDER BY created_at LIMIT 1",
  )
    .bind(owned.id)
    .first<{ id: string }>();
  const done = await c.env.DB.prepare("SELECT 1 AS found FROM thoughts WHERE token_id = ? AND kind = 'greeting' LIMIT 1").bind(owned.id).first();
  if (existing !== null) {
    c.executionCtx.waitUntil(desk(c.env, owned.id).process(owned.id));
    return c.json({ job: existing.id }, 202);
  }
  if (done !== null) return c.json({ job: null }, 202);
  const job = await enqueueJob(c.env.DB, owned.id, { kind: 'greeting' });
  run(c, owned.id);
  return c.json({ job }, 202);
});

// «Try again» under a wake thought that did not come: the same thought again, its cause kept by the
// failed job. Nothing to retry: `{ job: null }`.
thoughtRoutes.post('/api/pets/:id/wake', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  if (await isPaused(c.env.DB, 'thought')) return c.json({ code: 'paused' }, 409);
  const last = await c.env.DB.prepare("SELECT id, status, payload, result FROM jobs WHERE token_id = ? AND kind = 'wake' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(owned.id)
    .first<{ id: string; status: string; payload: string | null; result: string | null }>();
  if (last === null) return c.json({ job: null }, 202);
  if (last.status === 'queued' || last.status === 'running') {
    c.executionCtx.waitUntil(desk(c.env, owned.id).process(owned.id));
    return c.json({ job: last.id }, 202);
  }
  if (last.payload === null) return c.json({ job: null }, 202);
  const job = await enqueueJob(c.env.DB, owned.id, jobOf({ id: last.id, kind: 'wake', mode: null, payload: last.payload }), owned.pet.owner_id);
  await c.env.DB.prepare('UPDATE jobs SET payload = NULL WHERE id = ?').bind(last.id).run();
  run(c, owned.id);
  return c.json({ job }, 202);
});

thoughtRoutes.get('/api/pets/:id/state', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const { pet, id } = owned;

  // The food grew while the pet slept (a feeding of the owner, a friend): it wakes. While a friend's
  // meal is still on its way the poll leaves the wake to the flow that sent it: the food is visible
  // on chain before the outcome is settled, and a wake by the poll would lose the friend's thanks.
  const events: string[] = [];
  const friendOnItsWay = await c.env.DB.prepare("SELECT 1 AS found FROM feedings WHERE token_id = ? AND via = 'link' LIMIT 1").bind(id).first();
  // The wake's source is the receipt that raised the food: a recorded `cross_chain_feed` credit is
  // «From another chain». While no such receipt has been read the wake carries no source line and no
  // name, and a friend's meal still on its way keeps its own line (and thanks) from the flow that sent it.
  const named = await pendingFriendWake(c.env, id);
  const crossChainCredit = friendOnItsWay !== null || named.pending || named.woke ? null : await c.env.DB.prepare(`SELECT 1 AS found FROM any_chain_delivery_evidence d
    JOIN any_chain_credit_evidence e ON e.credit_id = d.credit_id
    JOIN pets p ON p.token_id = d.token_id
    WHERE d.token_id = ? AND p.slept_at IS NOT NULL AND e.was_asleep = 1
      AND e.recorded_at >= p.slept_at LIMIT 1`).bind(id).first();
  let woke = named.woke || (friendOnItsWay === null && !named.pending &&
    (await wakeIfFed(c.env, id, crossChainCredit === null ? 'unattributed' : 'cross_chain')));
  // A wake that a feeding flow made since this page loaded is told by the counter, once per page
  // (`?wakes=<n>` of the page; a page that sends none is told of no old wake).
  const wakesSeen = c.req.query('wakes');
  const wake = await wakeState(c.env.DB, id);
  let friend: string | undefined;
  let wakeSource: 'cross_chain' | undefined;
  if (wakesSeen !== undefined && /^\d{1,9}$/.test(wakesSeen) && Number(wakesSeen) < wake.wakes) {
    woke = true;
    if (wake.by !== null) friend = wake.by === '' ? 'A friend' : wake.by;
  }
  if (woke && wake.source === 'cross_chain') { friend = undefined; wakeSource = 'cross_chain'; }
  if (woke) events.push('woke');

  // A desk that died in a deploy runs nothing by itself: whoever looks at the pet starts it again.
  const waiting = await c.env.DB.prepare("SELECT 1 AS found FROM jobs WHERE token_id = ? AND status IN ('queued', 'running') LIMIT 1").bind(id).first();
  if (waiting !== null) c.executionCtx.waitUntil(desk(c.env, id).process(id));

  // An errand not back 3 minutes after «Send» is settled by whoever looks first, the poll or the cron: the page
  // sees it at 3:00, not a minute later (`Errand flow` › «not back in 3 minutes»).
  await settleLate(c.env, id, Date.now(), pet);
  const fields = await ownerFields(c.env, id, pet, (await pauseReason(c.env.DB)) !== null);
  // The errand the pet is off on, or the one that came back without a report (a failed errand of an earlier owner is
  // erased by this read).
  const errand = await errandView(c.env.DB, await readErrand(c.env.DB, id, pet.owner_id), c.req.query('job') === undefined);
  const out: Record<string, unknown> = { tokenId: id, name: pet.name, stage: stageOf(pet), ...fields, errand, events, ...(friend !== undefined ? { friend } : {}), ...(wakeSource ? { wakeSource } : {}) };
  // The owner page polls this route every five seconds, including while asleep. An acceptance
  // appears on the open page through that existing poll; a new UTC day or service pause does not
  // remove the accepted link.
  const gift = await linkForToken(c.env.DB, id);
  out.gift = gift !== null && gift.giver_account === pet.owner_id && (gift.status === 'waiting' || gift.status === 'accepted')
    ? { code: gift.code, status: gift.status, acceptedName: gift.accepted_name, acceptedAccount: gift.accepted_account, version: gift.version }
    : null;
  const jobId = c.req.query('job');
  if (jobId !== undefined && jobId !== '') {
    const boundary = (await c.env.DB.prepare('SELECT last_gift_block_at FROM pets WHERE token_id = ?').bind(id).first<{ last_gift_block_at: number | null }>())?.last_gift_block_at ?? 0;
    const job = await c.env.DB.prepare('SELECT status, kind, result FROM jobs WHERE id = ? AND token_id = ? AND (owner_account = ? OR (owner_account IS NULL AND created_at >= ?))').bind(jobId, id, pet.owner_id, boundary).first<{ status: string; kind: string; result: string | null }>();
    if (job === null) return c.json({ code: 'no_job' }, 404);
    out.jobKind = job.kind;
    if (job.status === 'queued' || job.status === 'running' || job.result === null) {
      out.pending = true;
    } else {
      const result = JSON.parse(job.result) as { code?: string; thoughtId?: string; cut?: string | null; price?: string; reasked?: boolean; events?: string[]; turn?: string; paid?: boolean; until?: string; refusal?: { id: string; reason: string } };
      events.push(...(result.events ?? []));
      if (result.code !== undefined) out.code = result.code;
      if (result.refusal !== undefined) out.characterRefusal = result.refusal;
      if (result.code === 'society_refused' && result.until !== undefined) out.refusalUntil = result.until;
      // An advice whose worker's data failed (`Adapter call rule` › «data failed in advice»): whether the paying pet's food paid for it.
      if (result.code === 'data_failed') out.paid = result.paid === true;
      // The tab's own job lost the pet's own reply after the worker's answer: the turn «Try again» finishes. Only the
      // job's outcome carries it, so a reload shows the lost reply by the conversation and no button (`§8 › Показанный питомец`).
      if (result.code === 'own_lost' && result.turn !== undefined) out.ownLost = { turn: result.turn };
      // An advice whose price rose (`Advice flow` › «price rose»): the price now, as the page shows it.
      if ((result.code === 'price_rose' || result.code === 'memory_cleared') && result.price !== undefined) out.price = priceView(c.env, BigInt(result.price));
      if (result.thoughtId !== undefined) {
        const thought = await c.env.DB.prepare("SELECT id, kind, reply_text, erased_at, cut, reasked, price_yocto, price_usd_micros, worker_id, worker_name, skilled, data_labels FROM thoughts WHERE id = ?").bind(result.thoughtId).first<{
          id: string;
          kind: string;
          reply_text: string | null;
          erased_at: number | null;
          cut: string | null;
          reasked: number;
          price_yocto: string;
          price_usd_micros: number;
          worker_id: string | null;
          worker_name: string | null;
          skilled: number;
          data_labels: string | null;
        }>();
        if (thought !== null && thought.reply_text === null && thought.erased_at !== null) {
          // The answer came after the owner cleared the memory: it is not shown (`Memory deletion data` › «ответ в пути»).
          out.code = 'memory_cleared';
        } else if (thought !== null && thought.kind === 'advice') {
          // The friend's answer to the advice, in the friend's voice: whose it is, whether a skill shaped it, and the
          // fee the paying pet's fullness fell by, in the rate it was made at (`price` yocto, `priceCents`).
          const hire = await c.env.DB.prepare('SELECT fee_yocto, fee_usd_micros, status FROM hires WHERE answer_thought_id = ?').bind(thought.id).first<{ fee_yocto: string; fee_usd_micros: number; status: string }>();
          out.thought = {
            id: thought.id,
            kind: 'advice',
            text: thought.reply_text,
            cut: null,
            worker: { tokenId: thought.worker_id, name: thought.worker_name },
            skilled: thought.skilled === 1,
            ...(thought.data_labels === null ? {} : { dataLabels: JSON.parse(thought.data_labels) as string[] }),
            ...(hire?.status === 'dropped' ? { noHireFee: true, answerPrice: thought.price_yocto,
              answerPriceCents: Number((thought.price_usd_micros / 10_000).toPrecision(2)) }
              : hire !== null ? { price: hire.fee_yocto, priceCents: Number((hire.fee_usd_micros / 10_000).toPrecision(2)) } : {}),
          };
        } else if (thought !== null) {
          out.thought = {
            id: thought.id,
            text: thought.reply_text,
            cut: thought.cut,
            // The exact price of «Think hard» only; an ordinary thought has none (OD-1500).
            // `priceCents` is the same price in US cents (the rate it was made at), for the client's «Thought hard · {price}».
            ...(thought.kind === 'deep' ? { price: thought.price_yocto, priceCents: thought.price_usd_micros / 10_000 } : {}),
            ...(thought.reasked === 1 ? { reasked: true } : {}),
          };
        }
      }
    }
  }
  return c.json(out);
});

thoughtRoutes.get('/api/pets/:id/conversation', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  await readErrand(c.env.DB, owned.id, owned.pet.owner_id);
  const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
  // A hire turn (`Pet hire flow`): the owner's line is the decision thought's, and the pet's own reply stores it again,
  // so the own reply (and the reply of a declined offer) shows no line of its own when its turn has a question to a
  // worker. `has_own` says the turn's own reply has words: the price under a hire goes under it, else under the worker's.
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.created_at, t.origin_owner, COALESCE(t.origin_sent_at, t.created_at) AS order_at, t.kind, t.player_text, t.reply_text, t.cut, t.reasked, t.price_yocto, t.price_usd_micros, t.worker_id, t.worker_name, t.skilled, t.turn_id, t.form, t.sources, t.verdict, t.searches, t.data_missed, t.data_labels, t.hire_mode,
       EXISTS (SELECT 1 FROM thoughts q WHERE q.token_id = t.token_id AND q.turn_id = t.turn_id AND q.kind = 'hire_question') AS has_question,
       EXISTS (SELECT 1 FROM thoughts r WHERE r.token_id = t.token_id AND r.turn_id = t.turn_id AND r.kind IN ('reply', 'question') AND r.reply_text IS NOT NULL) AS has_own,
       h.fee_yocto, h.fee_usd_micros, h.status AS hire_status, h.worker_name AS hire_worker, h.mode AS recorded_hire_mode,
       r.id AS refusal_id, r.reason AS refusal_reason,
       (SELECT price_yocto FROM thoughts a WHERE a.id = h.answer_thought_id) AS answer_price_yocto,
       (SELECT price_usd_micros FROM thoughts a WHERE a.id = h.answer_thought_id) AS answer_price_usd_micros
     FROM thoughts t LEFT JOIN hires h ON h.hirer_id = t.token_id AND (h.answer_thought_id = t.id OR (t.turn_id IS NOT NULL AND h.turn_id = t.turn_id))
     LEFT JOIN will_refusals r ON t.kind = 'hire_event' AND t.reply_text = 'character_refused|' || r.id
       AND r.payer_token = t.token_id AND r.payer_generation = ?
     WHERE t.token_id = ? AND COALESCE(t.origin_sent_at, t.created_at) < ? AND (t.player_text IS NOT NULL OR t.reply_text IS NOT NULL) ORDER BY COALESCE(t.origin_sent_at, t.created_at) DESC, t.rowid DESC LIMIT ?`,
  )
    .bind(owned.pet.transfer_generation, owned.id, Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER, CONVERSATION_PAGE + 1)
    .all<{
      id: string;
      created_at: number;
      order_at: number;
      origin_owner: string | null;
      kind: string;
      player_text: string | null;
      reply_text: string | null;
      cut: string | null;
      reasked: number;
      price_yocto: string;
      price_usd_micros: number;
      worker_id: string | null;
      worker_name: string | null;
      skilled: number;
      turn_id: string | null;
      form: string | null;
      sources: string | null;
      verdict: string | null;
      searches: number | null;
      data_missed: string | null;
      data_labels: string | null;
      hire_mode: string | null;
      has_question: number;
      has_own: number;
      fee_yocto: string | null;
      fee_usd_micros: number | null;
      hire_status: string | null;
      refusal_id: string | null;
      refusal_reason: string | null;
      hire_worker: string | null;
      recorded_hire_mode: string | null;
      answer_price_yocto: string | null;
      answer_price_usd_micros: number | null;
    }>();
  const more = rows.results.length > CONVERSATION_PAGE;
  const page = rows.results.slice(0, CONVERSATION_PAGE).reverse();
  const giftRow = await c.env.DB.prepare('SELECT last_gift_block_at FROM pets WHERE token_id = ?').bind(owned.id).first<{ last_gift_block_at: number | null }>();
  const giftAt = giftRow?.last_gift_block_at ?? null;
  const lines = page.flatMap((t): Record<string, unknown>[] => {
    const previousOwner = giftAt !== null && (t.order_at < giftAt || (t.origin_owner !== null && t.origin_owner !== owned.pet.owner_id));
    const tag = previousOwner ? { previousOwner: true } : {};
    // What the hire cost, in the rate it was made at, or that the network did not take it: the page learns without a reload.
    const hire = (): Record<string, unknown> =>
      t.fee_yocto === null || t.fee_usd_micros === null
        ? {}
        : t.hire_status === 'dropped'
          ? { hire: { worker: t.hire_worker ?? '', noFee: true,
              answerPrice: t.answer_price_yocto, answerPriceCents: t.answer_price_usd_micros === null ? null
                : Number((t.answer_price_usd_micros / 10_000).toPrecision(2)) } }
          : { hire: { worker: t.hire_worker ?? '', price: t.fee_yocto, priceCents: Number((t.fee_usd_micros / 10_000).toPrecision(2)),
              ...(t.recorded_hire_mode === 'auto' || t.recorded_hire_mode === 'manual' ? { mode: t.recorded_hire_mode } : {}) } };
    const worker = { tokenId: t.worker_id, name: t.worker_name };
    // The data sources a worker's answer read: the line «{worker} looked this up through {labels}…» is drawn from them.
    const dataLabels = t.data_labels === null ? {} : { dataLabels: JSON.parse(t.data_labels) as string[] };
    // An errand is two lines: the job under «You» with its form, and the pet's report with what it cites and what it
    // cost; a paid errand with no report is the job and a line that says so (`Errand flow` › «came back empty»).
    if (t.kind === 'errand') {
      const job = t.player_text === null ? [] : [{ id: `${t.id}:you`, who: 'player', kicker: t.form, text: t.player_text, at: t.order_at, ...tag }];
      const priceCents = Number((t.price_usd_micros / 10_000).toPrecision(2));
      if (t.reply_text === null) return [...job, { id: t.id, who: 'error', code: 'errand_empty', priceCents, at: t.order_at, ...tag }];
      return [
        ...job,
        {
          id: t.id,
          who: 'pet',
          text: t.reply_text,
          at: t.order_at,
          ...tag,
          report: { form: t.form, sources: JSON.parse(t.sources ?? '[]'), verdict: t.verdict, searches: t.searches ?? 0, priceCents, missed: JSON.parse(t.data_missed ?? '[]') },
        },
      ];
    }
    const ownReply = (t.kind === 'reply' || t.kind === 'question') && t.has_question === 1;
    const player = t.player_text !== null && !ownReply ? [{ id: `${t.id}:you`, who: 'player', text: t.player_text, at: t.order_at, ...tag }] : [];
    if (t.reply_text === null) return player;
    switch (t.kind) {
      // The line of a transition is the game's: a centred line, not the pet's voice (`Growth flow`).
      case 'growth':
        return [...player, { id: t.id, who: 'event', text: t.reply_text, at: t.order_at, ...tag }];
      // The friend's pet's words, with its receipt at the worker's token id (`Receipt index data`).
      // A rejected fee names the exact answer cost; a settled advice keeps its existing line.
      case 'advice':
        return [...player, { id: t.id, who: 'worker', text: t.reply_text, at: t.order_at, worker,
          skilled: t.skilled === 1, ...dataLabels, ...(t.hire_status === 'dropped' ? hire() : {}), ...tag }];
      case 'hire_answer':
        return [...player, { id: t.id, who: 'worker', text: t.reply_text, at: t.order_at, worker, skilled: t.skilled === 1, ...dataLabels, ...(t.has_own === 1 ? {} : hire()), ...tag }];
      // What the pet wrote to the worker, its own thought (the client says «To {worker}: …»).
      case 'hire_question':
        return [...player, { id: t.id, who: 'pet', text: t.reply_text, at: t.order_at, cut: null, hireTo: t.worker_name ?? '', ...tag }];
      case 'hire_event':
        return [{ id: t.id, who: 'event', code: HIRE_EVENT_CODES[t.reply_text.split('|')[0]!] ?? 'hire_failed',
          ...(t.refusal_id !== null && t.refusal_reason !== null && !previousOwner ? { refusal: { id: t.refusal_id, reason: t.refusal_reason } } : {}),
          ...(t.reply_text.startsWith('society_refused|') ? { refusalUntil: t.reply_text.split('|')[1] } : {}),
          ...(t.hire_mode === 'auto' || t.hire_mode === 'manual' ? { hireMode: t.hire_mode } : {}),
          at: t.order_at, worker, ...tag }];
      default:
        return [
          ...player,
          { id: t.id, who: 'pet', text: t.reply_text, at: t.order_at, cut: t.cut, ...(t.kind === 'deep' ? { price: t.price_yocto, priceCents: t.price_usd_micros / 10_000 } : {}), ...(ownReply ? hire() : {}), ...tag },
        ];
    }
  });
  if (giftAt !== null && Number.isFinite(before) && before > giftAt && (page.length === 0 || page[0]!.order_at <= giftAt)) {
    const event = { id: `gift:${giftAt}`, who: 'event', code: 'gift', name: owned.pet.name, at: giftAt };
    const firstNew = lines.findIndex((line) => Number(line.at) >= giftAt && line.previousOwner !== true);
    lines.splice(firstNew < 0 ? lines.length : firstNew, 0, event);
  }
  return c.json({ lines, more, before: page.length > 0 ? page[0]!.order_at : null });
});
