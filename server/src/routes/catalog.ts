// The catalog of adapters (`Catalog flow`, `Catalog data`): free and keyless, a public copy made at publish. Publishing
// and taking out are the owner's only, read from the contract with no cache; the list is anyone's, signed out included
// (the `gate`'s per-IP limit), and says nothing about who connected or called an entry.
import { Hono } from 'hono';
import { requireSession, type AppEnv } from '../http';
import { hasInsult } from '../name/insult';
import { openAddress, sourceRow, sourceViewOf, type StoredTool } from '../sources/store';
import { MAX_DESCRIPTION } from '../sources/limits';
import { randomId } from '../spend';
import { track } from '../track';
import { ownedPet } from './thoughts';

export const catalogRoutes = new Hono<AppEnv>();

/** A tool's description in the catalog is cut here, so whoever connects one reads a short text (`Adapter catalog screen`). */
export { MAX_DESCRIPTION } from '../sources/limits';
const SOURCE_ID = /^[0-9a-f]{24}$/;

const cut = (text: string): string => [...text].slice(0, MAX_DESCRIPTION).join('');

/** What the catalog keeps of a tool: its name, the description cut, its parameters; never the owner's tick. */
const entryTool = ({ ticked: _ticked, ...tool }: StoredTool) => ({ ...tool, description: cut(tool.description) });

interface EntryRow {
  id: string;
  token_id: string;
  name: string;
  address: string;
  tools: string;
  pet_name: string;
  published_at: number;
}

catalogRoutes.get('/api/adapters', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM catalog_entries ORDER BY published_at DESC, rowid DESC').all<EntryRow>();
  return c.json({
    entries: rows.results.map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      tools: JSON.parse(row.tools) as unknown[],
      petId: row.token_id,
      petName: row.pet_name,
      publishedAt: row.published_at,
    })),
  });
});

catalogRoutes.post('/api/pets/:id/sources/:sid/publish', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const sid = c.req.param('sid') ?? '';
  if (!SOURCE_ID.test(sid)) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const row = await sourceRow(c.env.DB, owned.id, sid);
  if (row === null) return c.json({ code: 'no_source' }, 404);
  // Only an own source (`Catalog data` › «publishing a copy») that the account owning the pet added («a source that
  // came with a gift»); one already listed answers as it stands.
  if (row.entry_id !== null) {
    console.log('catalog_publish:copy');
    return c.json({ code: 'copy' }, 409);
  }
  if (row.published_entry === null && row.added_by !== session.accountId) {
    console.log('catalog_publish:gift');
    return c.json({ code: 'gift' }, 409);
  }
  if (row.published_entry !== null) return c.json({ source: sourceViewOf(row, session.accountId) });

  // What would become public passes the check a pet's name does: every tool's name and description (as cut), and the
  // address's host and path.
  const address = await openAddress(c.env, row);
  const url = new URL(address);
  const stored = JSON.parse(row.tools) as StoredTool[];
  const tools = stored.map(entryTool);
  // The full description is checked as well as the cut one: a cut can end a word, and the owner's own text is what the
  // spec names.
  const words = [row.label, url.hostname, url.pathname, ...stored.flatMap((t) => [t.name, t.description]), ...tools.map((t) => t.description)];
  if (words.some((w) => hasInsult(w, c.env.INSULT_LIST))) {
    console.log('catalog_publish:insult');
    return c.json({ code: 'insult' }, 409);
  }

  const entryId = randomId();
  const now = Date.now();
  // Listed only while the source is still there and not listed: a remove or a second tap in another tab wins.
  const [listed] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO catalog_entries (id, token_id, source_id, name, address, tools, pet_name, published_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE EXISTS (SELECT 1 FROM data_sources WHERE id = ?3 AND token_id = ?2 AND published_entry IS NULL AND entry_id IS NULL)`,
    ).bind(entryId, owned.id, sid, row.label, address, JSON.stringify(tools), owned.pet.name, now),
    c.env.DB.prepare('UPDATE data_sources SET published_entry = ?1 WHERE id = ?2 AND token_id = ?3 AND published_entry IS NULL AND entry_id IS NULL AND EXISTS (SELECT 1 FROM catalog_entries WHERE id = ?1)').bind(
      entryId,
      sid,
      owned.id,
    ),
  ]);
  if (listed!.meta.changes === 0) return c.json({ code: 'no_source' }, 404);
  console.log('catalog_publish:ok');
  track('adapter_published');
  const next = await sourceRow(c.env.DB, owned.id, sid);
  return next === null ? c.json({ code: 'no_source' }, 404) : c.json({ source: sourceViewOf(next, session.accountId) });
});

// Take it out: the entry leaves the catalog at once; skills that connected it keep their own copy.
catalogRoutes.delete('/api/pets/:id/sources/:sid/publish', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const sid = c.req.param('sid') ?? '';
  if (!SOURCE_ID.test(sid)) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  if ((await sourceRow(c.env.DB, owned.id, sid)) === null) return c.json({ code: 'no_source' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM catalog_entries WHERE source_id = ?1 AND token_id = ?2').bind(sid, owned.id),
    c.env.DB.prepare('UPDATE data_sources SET published_entry = NULL WHERE id = ?1 AND token_id = ?2').bind(sid, owned.id),
  ]);
  const next = await sourceRow(c.env.DB, owned.id, sid);
  return next === null ? c.json({ code: 'no_source' }, 404) : c.json({ source: sourceViewOf(next, session.accountId) });
});
