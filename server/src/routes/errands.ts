// The owner's errand: the quote the sheet shows before «Send» and the send itself (`Errand sheet screen`,
// `Errand flow`). Both read the owner from the contract with no cache (`Errand access data`); the errand then
// runs on the pet's desk (`errands/run.ts`) with the tab open or closed.
import { Hono } from 'hono';
import { requireSession, type AppEnv } from '../http';
import { hasVisible } from '../name/clean';
import { blocksOf } from '../errands/blocks';
import { FORMS, allowanceFor, readCoefficients, searchQuote, typicalRead, view, type ErrandForm } from '../errands/price';
import { readErrand, sendErrand } from '../errands/store';
import { track } from '../track';
import { ownedPet, run } from './thoughts';

export const errandRoutes = new Hono<AppEnv>();

/** The job's limits in code points: a link or text to read, or a question or claim (`Errand sheet screen`). */
export const MAX_READ_CODE_POINTS = 30_000;
export const MAX_SEARCH_CODE_POINTS = 500;

const formOf = (raw: unknown): ErrandForm | null => (typeof raw === 'string' && (FORMS as readonly string[]).includes(raw) ? (raw as ErrandForm) : null);

errandRoutes.get('/api/pets/:id/errand', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const form = formOf(c.req.query('form') ?? 'read');
  if (form === null) return c.json({ code: 'bad_request' }, 400);
  const session = requireSession(c);
  if (session instanceof Response) return session;
  // A failed errand of an earlier owner goes with the gift; this read is where the server sees it.
  await readErrand(c.env.DB, owned.id, owned.pet.owner_id);

  const { block, food, hasData } = await blocksOf(c.env, owned.id, owned.pet, form, Date.now());
  const quote = searchQuote(c.env, food.room, hasData);
  const labels = await c.env.DB.prepare('SELECT label FROM data_sources WHERE token_id = ? ORDER BY created_at, rowid').bind(owned.id).all<{ label: string }>();
  return c.json({
    form,
    paused: block?.reason === 'paused',
    read: { typical: view(typicalRead(c.env)), ...readCoefficients(c.env) },
    search: { upTo: view(quote.upTo), full: quote.full, short: !quote.full, searches: quote.searches, allowance: allowanceFor(c.env, hasData) },
    block,
    labels: labels.results.map((r) => r.label),
  });
});

errandRoutes.post('/api/pets/:id/errand', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ form?: unknown; job?: unknown }>().catch(() => null);
  const form = formOf(body?.form);
  if (body === null || form === null || typeof body.job !== 'string') return c.json({ code: 'bad_request' }, 400);
  const limit = form === 'read' ? MAX_READ_CODE_POINTS : MAX_SEARCH_CODE_POINTS;
  if ([...body.job].length > limit || !hasVisible(body.job)) return c.json({ code: 'bad_request' }, 400);

  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;

  // The blocks are read again now: a page that is stale, or another tab's spend, must not start what it cannot pay.
  const { block } = await blocksOf(c.env, owned.id, owned.pet, form, Date.now());
  if (block !== null) return c.json({ code: 'blocked', block }, 409);

  const sent = await sendErrand(c.env.DB, { tokenId: owned.id, owner: owned.pet.owner_id, form, job: body.job, now: Date.now() });
  if (sent === null) return c.json({ code: 'away' }, 409);
  track('errand_given', { form });
  run(c, owned.id);
  return c.json({ job: sent.job }, 202);
});
