// A skill's data sources (`Adapter connect flow`, `Data source data`, ADR-024): the test call, connect, edit, remove.
// Each route is the owner's only, read from the contract with no cache (`ownedPet`); connecting costs no gas, no food and
// no energy, so no pause or awake check stands before it. The address is typed once and stays on the server: no
// response, log line or event below carries it.
import { Hono } from 'hono';
import { requireSession, type AppContext, type AppEnv } from '../http';
import { cleanName, hasVisible } from '../name/clean';
import { hasInsult } from '../name/insult';
import { McpError, addressOf, listTools } from '../sources/mcp';
import { MAX_SOURCES, insertSource, openAddress, sourceCount, sourceRow, sourceViewOf, withTicks, type StoredTool } from '../sources/store';
import { toolsFor, toolsOf, type Tool } from '../sources/types';
import { randomId } from '../spend';
import { track } from '../track';
import { ownedPet } from './thoughts';

export const sourceRoutes = new Hono<AppEnv>();

const MAX_LABEL = 40;
/** A bound on the field, not on the web: a longer text is not an address (`bad_request`). */
const MAX_ADDRESS = 2_048;
const SOURCE_ID = /^[0-9a-f]{24}$/;

/** The test call of an address: its tools by the type rule, or `null` when it didn't work (the shape, a key, a timeout,
 * a refusal, no tools). One log code, never the address. */
export async function testAddress(text: string): Promise<Tool[] | null> {
  const address = addressOf(text);
  if (address === null) {
    console.log('source_check:shape');
    return null;
  }
  try {
    const tools = toolsFor(address, toolsOf(await listTools(address)));
    console.log(tools.length > 0 ? 'source_check:ok' : 'source_check:no_tools');
    return tools.length > 0 ? tools : null;
  } catch (e) {
    console.log(`source_check:${e instanceof McpError ? e.failure : 'down'}`);
    return null;
  }
}

/** The label by the rule of a skill's: 1–40 code points, a visible sign, no word of the insult list. */
function labelOf(raw: unknown, list: string): { label: string } | 'bad_request' | 'bad_label' {
  if (typeof raw !== 'string') return 'bad_request';
  const length = [...raw].length;
  if (length < 1 || length > MAX_LABEL) return 'bad_request';
  const label = cleanName(raw);
  return !hasVisible(label) || hasInsult(label, list) ? 'bad_label' : { label };
}

const ticksOf = (raw: unknown): Set<string> | null =>
  Array.isArray(raw) && raw.length <= 200 && raw.every((t): t is string => typeof t === 'string') ? new Set(raw) : null;

/** Every tick is a tool of the source that the type rule lets through. */
const ticksFit = (tools: Tool[], ticks: Set<string>): boolean => [...ticks].every((name) => tools.some((t) => t.name === name && t.tickable));

const failed = (c: AppContext) => c.json({ code: 'address_failed' }, 422);

// «Check address»: the shape and the test call; nothing is stored.
sourceRoutes.post('/api/pets/:id/sources/check', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ address?: unknown }>().catch(() => null);
  if (body === null || typeof body.address !== 'string' || body.address.length > MAX_ADDRESS) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const tools = await testAddress(body.address);
  if (tools === null) return failed(c);
  return c.json({ tools });
});

// Connect: the label, an own address or a catalog entry, the ticks. The test call runs again here.
sourceRoutes.post('/api/pets/:id/sources', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ label?: unknown; address?: unknown; entry?: unknown; ticks?: unknown }>().catch(() => null);
  if (body === null) return c.json({ code: 'bad_request' }, 400);
  const label = labelOf(body.label, c.env.INSULT_LIST);
  if (label === 'bad_request') return c.json({ code: 'bad_request' }, 400);
  if (label === 'bad_label') return c.json({ code: 'bad_label' }, 400);
  const ticks = ticksOf(body.ticks);
  const own = typeof body.address === 'string' && body.address.length <= MAX_ADDRESS;
  const catalog = typeof body.entry === 'string' && SOURCE_ID.test(body.entry);
  if (ticks === null || own === catalog || (body.address !== undefined && !own) || (body.entry !== undefined && !catalog)) return c.json({ code: 'bad_request' }, 400);

  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  // A skill first (`Adapter connect flow` › «no skill yet»), and room for one more («a fourth source»).
  if ((await c.env.DB.prepare('SELECT 1 AS found FROM skills WHERE token_id = ?').bind(owned.id).first()) === null) return c.json({ code: 'no_skill' }, 409);
  if ((await sourceCount(c.env.DB, owned.id)) >= MAX_SOURCES) return c.json({ code: 'full' }, 409);

  let address = String(body.address ?? '');
  let copyOf: { entryId: string; publicAddress: string } | null = null;
  if (catalog) {
    const entry = await c.env.DB.prepare('SELECT id, address FROM catalog_entries WHERE id = ?').bind(body.entry).first<{ id: string; address: string }>();
    if (entry === null) return c.json({ code: 'no_entry' }, 404);
    address = entry.address;
    copyOf = { entryId: entry.id, publicAddress: entry.address };
  }
  const tools = await testAddress(address);
  if (tools === null) return failed(c);
  if (!ticksFit(tools, ticks!)) return c.json({ code: 'bad_request' }, 400);
  const stillOwned = await ownedPet(c);
  if (stillOwned instanceof Response) return stillOwned;

  const id = randomId();
  const stored = await insertSource(c.env, {
    id,
    tokenId: owned.id,
    addedBy: session.accountId,
    label: label.label,
    address,
    copyOf,
    tools: withTicks(tools, ticks!),
    now: Date.now(),
  });
  if (stored === null) {
    // The skill was forgotten, or a second tab filled the last place, while the address was tested.
    const skill = await c.env.DB.prepare('SELECT 1 AS found FROM skills WHERE token_id = ?').bind(owned.id).first();
    return c.json({ code: skill === null ? 'no_skill' : 'full' }, 409);
  }
  track('adapter_added', { from: copyOf === null ? 'own' : 'catalog' });
  const row = await sourceRow(c.env.DB, owned.id, id);
  return c.json({ source: sourceViewOf(row!, session.accountId) });
});

// Edit: the name and the ticks; the stored address is tested again and the tools are read as they are now.
sourceRoutes.put('/api/pets/:id/sources/:sid', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ label?: unknown; ticks?: unknown }>().catch(() => null);
  if (body === null) return c.json({ code: 'bad_request' }, 400);
  const label = labelOf(body.label, c.env.INSULT_LIST);
  if (label === 'bad_request') return c.json({ code: 'bad_request' }, 400);
  if (label === 'bad_label') return c.json({ code: 'bad_label' }, 400);
  const ticks = ticksOf(body.ticks);
  const sid = c.req.param('sid') ?? '';
  if (ticks === null || !SOURCE_ID.test(sid)) return c.json({ code: 'bad_request' }, 400);

  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const row = await sourceRow(c.env.DB, owned.id, sid);
  if (row === null) return c.json({ code: 'no_source' }, 404);
  const tools = await testAddress(await openAddress(c.env, row));
  if (tools === null) return failed(c);
  if (!ticksFit(tools, ticks)) return c.json({ code: 'bad_request' }, 400);
  const stillOwned = await ownedPet(c);
  if (stillOwned instanceof Response) return stillOwned;

  await c.env.DB.prepare('UPDATE data_sources SET label = ?3, tools = ?4, updated_at = ?5 WHERE token_id = ?1 AND id = ?2')
    .bind(owned.id, sid, label.label, JSON.stringify(withTicks(tools, ticks) satisfies StoredTool[]), Date.now())
    .run();
  // removed in another tab while the address was tested
  const next = await sourceRow(c.env.DB, owned.id, sid);
  return next === null ? c.json({ code: 'no_source' }, 404) : c.json({ source: sourceViewOf(next, session.accountId) });
});

// Remove: the source and its own entry in the catalog leave in one batch (`Catalog flow` › «taken out»).
sourceRoutes.delete('/api/pets/:id/sources/:sid', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const sid = c.req.param('sid') ?? '';
  if (!SOURCE_ID.test(sid)) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  if ((await sourceRow(c.env.DB, owned.id, sid)) === null) return c.json({ code: 'no_source' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM catalog_entries WHERE source_id = ?1 AND token_id = ?2').bind(sid, owned.id),
    c.env.DB.prepare('DELETE FROM data_sources WHERE id = ?1 AND token_id = ?2').bind(sid, owned.id),
  ]);
  return c.json({ removed: true });
});
