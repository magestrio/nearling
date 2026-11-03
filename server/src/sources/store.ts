// A skill's data sources in D1 (`Data source data`): up to 3 a pet, the address sealed under the skills key with the token
// id and the row id as additional data, the tools as tested with their ticks. The address leaves this module only
// as the plaintext the Worker itself calls (`addressOf`); a view never carries it, except the public address of a
// copy from the catalog.
import { openText, sealText } from '../work/skill';
import type { Tool } from './types';

export const MAX_SOURCES = 3;

/** A tool as stored and as the sheet draws it: as tested, with whether the owner ticked it. */
export interface StoredTool extends Tool {
  ticked: boolean;
}

interface SourceRow {
  id: string;
  token_id: string;
  added_by: string | null;
  label: string;
  addr_ct: ArrayLike<number> | ArrayBuffer;
  addr_iv: ArrayLike<number> | ArrayBuffer;
  public_address: string | null;
  entry_id: string | null;
  tools: string;
  published_entry: string | null;
  created_at: number;
  updated_at: number;
}

/** What `GET …/skill` carries for a source. `publicAddress` only for a copy from the catalog; `gift`: an own source the
 * giver added, which can't be published (`Catalog flow` › «a source from a gift»). */
export interface SourceView {
  id: string;
  label: string;
  tools: StoredTool[];
  publicAddress?: string;
  published: boolean;
  catalogGone: boolean;
  gift: boolean;
}

const aadOf = (tokenId: string, id: string): string => `${tokenId}:${id}`;

/** The tools as tested with the owner's ticks; a tick of a tool that can't be ticked is dropped by the caller first. */
export const withTicks = (tools: Tool[], ticks: Set<string>): StoredTool[] => tools.map((t) => ({ ...t, ticked: t.tickable && ticks.has(t.name) }));

function viewOf(row: SourceRow & { gone: number }, ownerId: string): SourceView {
  const copy = row.entry_id !== null;
  return {
    id: row.id,
    label: row.label,
    tools: JSON.parse(row.tools) as StoredTool[],
    ...(row.public_address !== null ? { publicAddress: row.public_address } : {}),
    published: row.published_entry !== null,
    catalogGone: copy && row.gone === 1,
    gift: !copy && row.published_entry === null && row.added_by !== ownerId,
  };
}

const SELECT = `SELECT s.*, (s.entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catalog_entries e WHERE e.id = s.entry_id)) AS gone FROM data_sources s`;

/** The pet's sources for `ownerId`, the account that owns it now, oldest first. */
export async function sourceViews(db: D1Database, tokenId: string, ownerId: string): Promise<SourceView[]> {
  const rows = await db.prepare(`${SELECT} WHERE s.token_id = ? ORDER BY s.created_at, s.rowid`).bind(tokenId).all<SourceRow & { gone: number }>();
  return rows.results.map((row) => viewOf(row, ownerId));
}

export async function sourceCount(db: D1Database, tokenId: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM data_sources WHERE token_id = ?').bind(tokenId).first<{ n: number }>())?.n ?? 0;
}

export async function sourceRow(db: D1Database, tokenId: string, id: string): Promise<(SourceRow & { gone: number }) | null> {
  return db.prepare(`${SELECT} WHERE s.token_id = ?1 AND s.id = ?2`).bind(tokenId, id).first<SourceRow & { gone: number }>();
}

export const sourceViewOf = viewOf;

/** The address of a stored source, in memory; the Worker calls it, no one else sees it. */
export async function openAddress(env: Pick<Env, 'SKILL_KEY'>, row: Pick<SourceRow, 'token_id' | 'id' | 'addr_ct' | 'addr_iv'>): Promise<string> {
  return openText(env, aadOf(row.token_id, row.id), { ct: row.addr_ct, iv: row.addr_iv });
}

export interface NewSource {
  id: string;
  tokenId: string;
  addedBy: string;
  label: string;
  address: string;
  /** The entry's public address and id for a copy; none for an own source. */
  copyOf: { entryId: string; publicAddress: string } | null;
  tools: StoredTool[];
  now: number;
}

/** Inserts the source only if the skill is still saved and the pet still holds fewer than 3: one statement, so a
 * skill forgotten in another tab during the test call, or a fourth source from a second tab, is not stored. Gives the
 * id, or `null` when nothing was inserted. */
export async function insertSource(env: Pick<Env, 'DB' | 'SKILL_KEY'>, s: NewSource): Promise<string | null> {
  const sealed = await sealText(env, aadOf(s.tokenId, s.id), s.address);
  const row = await env.DB.prepare(
    `INSERT INTO data_sources (id, token_id, added_by, label, addr_ct, addr_iv, public_address, entry_id, tools, published_entry, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?10
     WHERE (SELECT COUNT(*) FROM data_sources WHERE token_id = ?2) < ${MAX_SOURCES} AND EXISTS (SELECT 1 FROM skills WHERE token_id = ?2)
     RETURNING id`,
  )
    .bind(s.id, s.tokenId, s.addedBy, s.label, sealed.ct, sealed.iv, s.copyOf?.publicAddress ?? null, s.copyOf?.entryId ?? null, JSON.stringify(s.tools), s.now)
    .first<{ id: string }>();
  return row?.id ?? null;
}
