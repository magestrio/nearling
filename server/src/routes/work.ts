// The routes of the pets' work for each other (`add-pet-work`). Each follows the order of the other owner routes
// (design.md › Worker): the request limit (`gate`) -> the input -> the owner from the contract, uncached
// (`ownedPet`) -> the check of the pet's state -> the write. Nothing here logs a word of a player.
import { Hono } from 'hono';
import { ChainUnreachable, petView, type PetRecord } from '../chain';
import { requireSession, TOKEN_ID, utcDay, type AppContext, type AppEnv } from '../http';
import { track } from '../track';
import { fullness, HIRE_FEE_MIN_YOCTO } from '../pricing';
import { cleanName, hasVisible } from '../name/clean';
import { hasInsult } from '../name/insult';
import { desk, enqueueAdvice, enqueueJob } from '../pet/desk';
import { foodState } from '../pet/view';
import { isPaused } from '../servicePause';
import { adviceFacts, lastExchange, readableSourceLabels } from '../work/advice';
import { hireModeOf } from '../work/mode';
import { lostTurn, offerJobOnItsWay, standingOffer } from '../work/offer';
import { priceView } from '../work/quote';
import { sourceViews } from '../sources/store';
import { deleteSkill, readSkill, SkillUnreadable, writeSkill } from '../work/skill';
import { ownedPet, run as runDesk } from './thoughts';

export const workRoutes = new Hono<AppEnv>();

// The owner switches how the pet hires (`Hire mode rule`). Only an awake pet has the switch
// (`add-pet` › Pet screen › «asleep (владелец)»); the new mode is read by the next turn, so a turn already
// running keeps the one it began with.
workRoutes.put('/api/pets/:id/hire-mode', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ mode?: unknown }>().catch(() => null);
  if (body === null || (body.mode !== 'auto' && body.mode !== 'manual')) return c.json({ code: 'bad_request' }, 400);
  const mode: 'auto' | 'manual' = body.mode;

  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const food = await foodState(c.env.DB, owned.id, owned.pet, Date.now());
  if (fullness(food.eff).state === 'asleep') return c.json({ code: 'asleep' }, 409);

  const before = await hireModeOf(c.env.DB, owned.id);
  await c.env.DB.prepare('INSERT INTO hire_modes (token_id, mode) VALUES (?1, ?2) ON CONFLICT (token_id) DO UPDATE SET mode = excluded.mode')
    .bind(owned.id, mode)
    .run();
  // The event is the switch, not a repeat of the mode the pet already has.
  if (before !== mode) track('hire_mode_changed', { mode });
  return c.json({ mode });
});

// The owner's answers to a Manual offer and «Try again» of a lost own reply (`Pet hire flow`). Each is the owner's
// only, read from the contract with no cache; on a pause the tap is not taken (nothing queued, held or spent); each
// queues a job of the pet's own desk. `409 no_offer` / `409 no_hire` are for a stale tab and a second tap: the
// client's buttons are gone from the same read, so it never shows them.
workRoutes.post('/api/pets/:id/offer/ask', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ price?: unknown }>().catch(() => null);
  if (body === null || typeof body.price !== 'string' || !/^\d{1,30}$/.test(body.price)) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  if (await isPaused(c.env.DB, 'thought')) return c.json({ code: 'paused' }, 409);
  if ((await standingOffer(c.env, owned.id, owned.pet)) === null || (await offerJobOnItsWay(c.env.DB, owned.id))) return c.json({ code: 'no_offer' }, 409);
  const job = await enqueueJob(c.env.DB, owned.id, { kind: 'hire', price: body.price });
  runDesk(c, owned.id);
  return c.json({ job }, 202);
});

workRoutes.post('/api/pets/:id/offer/decline', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  if (await isPaused(c.env.DB, 'thought')) return c.json({ code: 'paused' }, 409);
  if ((await standingOffer(c.env, owned.id, owned.pet)) === null || (await offerJobOnItsWay(c.env.DB, owned.id))) return c.json({ code: 'no_offer' }, 409);
  const job = await enqueueJob(c.env.DB, owned.id, { kind: 'decline' });
  runDesk(c, owned.id);
  return c.json({ job }, 202);
});

workRoutes.post('/api/pets/:id/hire/finish', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  if (await isPaused(c.env.DB, 'thought')) return c.json({ code: 'paused' }, 409);
  if ((await lostTurn(c.env.DB, owned.id)) === null || (await offerJobOnItsWay(c.env.DB, owned.id))) return c.json({ code: 'no_hire' }, 409);
  const job = await enqueueJob(c.env.DB, owned.id, { kind: 'finish' });
  runDesk(c, owned.id);
  return c.json({ job }, 202);
});

// The skill (`Skill data`, ADR-023): the owner's only, read from the contract with no cache; it costs no gas, no food
// and no energy, so no pause or awake check stands before it. A chain that can't be read is `503` on all three.
const MAX_QUESTION = 500;
const MAX_LABEL = 40;
const MAX_INSTRUCTION = 1000;
const unreadable = () => {
  console.log('skill_unreadable');
  return { code: 'skill_unreadable' } as const;
};

workRoutes.get('/api/pets/:id/skill', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  try {
    const skill = await readSkill(c.env, owned.id);
    // The sources by name and tools, never an address (`Data source data` › «the address after save»); the code only as
    // the functions it declares: its text has its own route.
    const sources = await sourceViews(c.env.DB, owned.id, session.accountId);
    const code = await c.env.DB.prepare('SELECT functions FROM skill_code WHERE token_id = ?').bind(owned.id).first<{ functions: string }>();
    return c.json({ skill, sources, code: code === null ? null : { functions: JSON.parse(code.functions) as unknown } });
  } catch (e) {
    if (e instanceof SkillUnreadable) return c.json(unreadable(), 500);
    throw e;
  }
});

workRoutes.put('/api/pets/:id/skill', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ label?: unknown; instruction?: unknown }>().catch(() => null);
  if (body === null || typeof body.label !== 'string' || typeof body.instruction !== 'string') return c.json({ code: 'bad_request' }, 400);
  // Code points, as the fields count them. Over the limit or empty: nothing is cleaned, sealed or saved.
  const labelLength = [...body.label].length;
  const instructionLength = [...body.instruction].length;
  if (labelLength < 1 || labelLength > MAX_LABEL || instructionLength < 1 || instructionLength > MAX_INSTRUCTION) return c.json({ code: 'bad_request' }, 400);
  // The label is public: the check names have (`Public pet data`), the cleaned text is what is stored.
  const label = cleanName(body.label);
  if (!hasVisible(label) || hasInsult(label, c.env.INSULT_LIST)) return c.json({ code: 'bad_label' }, 400);

  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  try {
    await writeSkill(c.env, owned.id, { label, instruction: body.instruction }, Date.now());
  } catch (e) {
    if (e instanceof SkillUnreadable) return c.json(unreadable(), 500);
    throw e;
  }
  console.log('skill_saved');
  track('skill_saved', { kind: 'private' });
  return c.json({ skill: { label } });
});

workRoutes.delete('/api/pets/:id/skill', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  await deleteSkill(c.env.DB, owned.id);
  return c.json({ skill: null });
});

// The advice a signed-in player asks of a friend's pet, paid by their own (`Advice flow`). `:id` is the WORKER, the pet
// asked; `payer` is the player's pet that pays. The payer is read from the contract with no cache and must be the
// session's (`403 not_payer`: nothing is sent, held or spent); the worker must be someone else's.
async function advicePair(c: AppContext, accountId: string, payerId: string): Promise<{ workerId: string; worker: PetRecord; payer: PetRecord } | Response> {
  const workerId = c.req.param('id') ?? '';
  if (!TOKEN_ID.test(workerId)) return c.json({ code: 'no_pet' }, 404);
  let payer: PetRecord | null;
  let worker: PetRecord | null;
  try {
    [payer, worker] = await Promise.all([petView(c.env, payerId), petView(c.env, workerId)]);
  } catch (e) {
    if (e instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw e;
  }
  if (payer === null || payer.owner_id !== accountId) return c.json({ code: 'not_payer' }, 403);
  if (worker === null) return c.json({ code: 'no_pet' }, 404);
  if (worker.owner_id === accountId) return c.json({ code: 'same_owner' }, 409);
  return { workerId, worker, payer };
}

const nextMidnight = (nowMs: number): string => new Date((utcDay(nowMs) + 1) * 86_400_000).toISOString();

workRoutes.get('/api/pets/:id/advice', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const payerId = c.req.query('payer') ?? '';
  if (!TOKEN_ID.test(payerId)) return c.json({ code: 'bad_request' }, 400);
  const pair = await advicePair(c, session.accountId, payerId);
  if (pair instanceof Response) return pair;

  const now = Date.now();
  const facts = await adviceFacts(c.env, { payerId, payer: pair.payer, workerId: pair.workerId, worker: pair.worker, now });
  const queued = await c.env.DB.prepare("SELECT id, payload FROM jobs WHERE token_id = ? AND kind = 'advice' AND status IN ('queued', 'running') ORDER BY created_at LIMIT 1")
    .bind(payerId)
    .first<{ id: string; payload: string | null }>();
  const asked = queued?.payload == null ? null : (JSON.parse(queued.payload) as { worker?: unknown; text?: unknown });
  const pending = queued !== null && asked !== null && asked.worker === pair.workerId && typeof asked.text === 'string' ? { job: queued.id, question: asked.text } : null;
  // The asker's last question to this worker, as their conversation still holds it (`Advice flow` › «page opened
  // again»): with the answer, whose fee the paying pet's fullness fell by — none when the hire was refused.
  const lastAsked = await lastExchange(c.env.DB, payerId, pair.workerId);
  const lastHire =
    lastAsked === null
      ? null
      : await c.env.DB.prepare("SELECT fee_yocto, fee_usd_micros FROM hires WHERE answer_thought_id = ? AND status <> 'dropped'").bind(lastAsked.id).first<{ fee_yocto: string; fee_usd_micros: number }>();
  return c.json({
    last:
      lastAsked === null
        ? null
        : {
            id: lastAsked.id,
            question: lastAsked.question,
            text: lastAsked.answer,
            skilled: lastAsked.skilled,
            ...(lastAsked.dataLabels.length > 0 ? { dataLabels: lastAsked.dataLabels } : {}),
            ...(lastHire !== null ? { price: lastHire.fee_yocto, priceCents: Number((lastHire.fee_usd_micros / 10_000).toPrecision(2)) } : {}),
          },
    price: priceView(c.env, facts.quote.yocto),
    skilled: facts.skilled,
    // The worker's data sources, named once: «Whoever runs {labels} sees what {name} looks up there…» is drawn from them.
    labels: await readableSourceLabels(c.env.DB, pair.workerId),
    workerAsleep: facts.workerAsleep,
    resting: facts.resting ? { until: nextMidnight(now) } : null,
    payer: { tokenId: payerId, name: pair.payer.name, state: facts.payer, until: facts.payer === 'tired' ? nextMidnight(now) : null },
    // A skilled worker above its starting price says when it falls back (`Advice flow` › «свой питомец не может заплатить»).
    dropsAt: facts.skilled && facts.quote.yocto > HIRE_FEE_MIN_YOCTO ? nextMidnight(now) : null,
    pending,
    // The services' pause stands over the other four conditions (`Advice flow` › «several at once»): the column reads it here, so
    // «Ask» comes back by itself when it lifts.
    paused: await isPaused(c.env.DB, 'thought'),
  });
});

workRoutes.post('/api/pets/:id/advice', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ payer?: unknown; text?: unknown; price?: unknown }>().catch(() => null);
  if (body === null || typeof body.payer !== 'string' || typeof body.text !== 'string' || typeof body.price !== 'string') return c.json({ code: 'bad_request' }, 400);
  // The question as a line of the player: up to 500 code points with a visible sign; the price is a yocto string, a ceiling.
  if (!TOKEN_ID.test(body.payer) || [...body.text].length > MAX_QUESTION || !hasVisible(body.text) || !/^\d{1,30}$/.test(body.price)) return c.json({ code: 'bad_request' }, 400);

  const pair = await advicePair(c, session.accountId, body.payer);
  if (pair instanceof Response) return pair;
  // On a pause the question is not taken: nothing queued, held or spent.
  if (await isPaused(c.env.DB, 'thought')) return c.json({ code: 'paused' }, 409);
  const job = await enqueueAdvice(c.env.DB, body.payer, { kind: 'advice', worker: pair.workerId, text: body.text, shown: body.price });
  if (job === null) return c.json({ code: 'pending' }, 409);
  const stub = desk(c.env, body.payer);
  c.executionCtx.waitUntil(stub.process(body.payer));
  c.executionCtx.waitUntil(stub.arm(body.payer));
  return c.json({ job }, 202);
});
