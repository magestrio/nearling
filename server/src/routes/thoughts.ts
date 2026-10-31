// The owner's conversation: a line in (`POST …/thoughts`), the first greeting, the poll of the pet's
// state and of a job's outcome, and the earlier lines. Every route reads the owner from the contract
// on each request, without a cache (Conversation access data); a signed-in player who is not the
// owner is turned away before anything is read, queued or sent (`403 not_owner`).
import { Hono } from 'hono';
import { ChainUnreachable, petView, stageOf, type PetRecord } from '../chain';
import { requireSession, TOKEN_ID, type AppContext, type AppEnv } from '../http';
import { hasVisible } from '../name/clean';
import { desk, enqueueJob, jobOf } from '../pet/desk';
import { memoryEpoch } from '../pet/forget';
import { ownerFields, wakeState } from '../pet/view';
import { wakeIfFed } from '../pet/wake';
import { isPaused, pauseReason } from '../servicePause';

export const thoughtRoutes = new Hono<AppEnv>();

/** A player's line: up to 500 code points, with at least one visible character. */
const MAX_LINE_CODE_POINTS = 500;
const CONVERSATION_PAGE = 50;

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
  if (pet.owner_id !== session.accountId) return c.json({ code: 'not_owner' }, 403);
  return { pet, id };
}

/** The desk runs the queue now, and its alarm is the fallback. */
function run(c: AppContext, tokenId: string): void {
  const stub = desk(c.env, tokenId);
  c.executionCtx.waitUntil(stub.process(tokenId));
  c.executionCtx.waitUntil(stub.arm(tokenId));
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

  const job = await enqueueJob(c.env.DB, owned.id, { kind: 'reply', mode: body.mode, text: body.text });
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
  const job = await enqueueJob(c.env.DB, owned.id, jobOf({ id: last.id, kind: 'wake', mode: null, payload: last.payload }));
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
  let woke = friendOnItsWay === null && (await wakeIfFed(c.env, id, 'owner'));
  // A wake that a feeding flow made since this page loaded is told by the counter, once per page
  // (`?wakes=<n>` of the page; a page that sends none is told of no old wake).
  const wakesSeen = c.req.query('wakes');
  const wake = await wakeState(c.env.DB, id);
  let friend: string | undefined;
  if (wakesSeen !== undefined && /^\d{1,9}$/.test(wakesSeen) && Number(wakesSeen) < wake.wakes) {
    woke = true;
    if (wake.by !== null) friend = wake.by === '' ? 'A friend' : wake.by;
  }
  if (woke) events.push('woke');

  // A desk that died in a deploy runs nothing by itself: whoever looks at the pet starts it again.
  const waiting = await c.env.DB.prepare("SELECT 1 AS found FROM jobs WHERE token_id = ? AND status IN ('queued', 'running') LIMIT 1").bind(id).first();
  if (waiting !== null) c.executionCtx.waitUntil(desk(c.env, id).process(id));

  const fields = await ownerFields(c.env, id, pet, (await pauseReason(c.env.DB)) !== null);
  const out: Record<string, unknown> = { tokenId: id, name: pet.name, stage: stageOf(pet), ...fields, events, ...(friend !== undefined ? { friend } : {}) };
  const jobId = c.req.query('job');
  if (jobId !== undefined && jobId !== '') {
    const job = await c.env.DB.prepare('SELECT status, kind, result FROM jobs WHERE id = ? AND token_id = ?').bind(jobId, id).first<{ status: string; kind: string; result: string | null }>();
    if (job === null) return c.json({ code: 'no_job' }, 404);
    out.jobKind = job.kind;
    if (job.status === 'queued' || job.status === 'running' || job.result === null) {
      out.pending = true;
    } else {
      const result = JSON.parse(job.result) as { code?: string; thoughtId?: string; cut?: string | null; price?: string; reasked?: boolean; events?: string[] };
      events.push(...(result.events ?? []));
      if (result.code !== undefined) out.code = result.code;
      if (result.thoughtId !== undefined) {
        const thought = await c.env.DB.prepare("SELECT id, kind, reply_text, erased_at, cut, reasked, price_yocto, price_usd_micros FROM thoughts WHERE id = ?").bind(result.thoughtId).first<{
          id: string;
          kind: string;
          reply_text: string | null;
          erased_at: number | null;
          cut: string | null;
          reasked: number;
          price_yocto: string;
          price_usd_micros: number;
        }>();
        if (thought !== null && thought.reply_text === null && thought.erased_at !== null) {
          // The answer came after the owner cleared the memory: it is not shown (`Memory deletion data` › «ответ в пути»).
          out.code = 'memory_cleared';
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
  const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
  const rows = await c.env.DB.prepare(
    'SELECT id, created_at, kind, player_text, reply_text, cut, reasked, price_yocto, price_usd_micros FROM thoughts WHERE token_id = ? AND created_at < ? AND (player_text IS NOT NULL OR reply_text IS NOT NULL) ORDER BY created_at DESC, rowid DESC LIMIT ?',
  )
    .bind(owned.id, Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER, CONVERSATION_PAGE + 1)
    .all<{ id: string; created_at: number; kind: string; player_text: string | null; reply_text: string | null; cut: string | null; reasked: number; price_yocto: string; price_usd_micros: number }>();
  const more = rows.results.length > CONVERSATION_PAGE;
  const page = rows.results.slice(0, CONVERSATION_PAGE).reverse();
  const lines = page.flatMap((t) => [
    ...(t.player_text !== null ? [{ id: `${t.id}:you`, who: 'player', text: t.player_text, at: t.created_at }] : []),
    // The line of a transition is the game's: a centred line, not the pet's voice (`Growth flow`).
    ...(t.reply_text !== null && t.kind === 'growth' ? [{ id: t.id, who: 'event', text: t.reply_text, at: t.created_at }] : []),
    ...(t.reply_text !== null && t.kind !== 'growth'
      ? [{ id: t.id, who: 'pet', text: t.reply_text, at: t.created_at, cut: t.cut, ...(t.kind === 'deep' ? { price: t.price_yocto, priceCents: t.price_usd_micros / 10_000 } : {}) }]
      : []),
  ]);
  return c.json({ lines, more, before: page.length > 0 ? page[0]!.created_at : null });
});
