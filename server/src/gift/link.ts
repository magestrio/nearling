// One bearer link per pet. Every transition is a conditional D1 write: two tabs can race,
// but only the first acceptance or cancellation changes the row.
export interface GiftLink {
  token_id: string;
  code: string;
  giver_account: string;
  status: 'waiting' | 'accepted' | 'transferred' | 'cancelled';
  accepted_account: string | null;
  accepted_name: string | null;
  version: number;
  created_at: number;
  accepted_at: number | null;
  transferred_at: number | null;
}

function freshCode(): string {
  // 192 random bits, rendered without URL-unsafe characters.
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const linkForToken = (db: D1Database, tokenId: string): Promise<GiftLink | null> =>
  db.prepare('SELECT * FROM gift_links WHERE token_id = ?').bind(tokenId).first<GiftLink>();

export const linkForCode = (db: D1Database, code: string): Promise<GiftLink | null> =>
  db.prepare('SELECT * FROM gift_links WHERE code = ?').bind(code).first<GiftLink>();

export async function createLink(db: D1Database, tokenId: string, giver: string, now: number): Promise<GiftLink> {
  const code = freshCode();
  const written = await db.prepare(
    `INSERT INTO gift_links (token_id, code, giver_account, status, created_at)
     VALUES (?1, ?2, ?3, 'waiting', ?4)
     ON CONFLICT (token_id) DO UPDATE SET
       code = excluded.code, giver_account = excluded.giver_account, status = 'waiting',
       accepted_account = NULL, accepted_name = NULL, accepted_at = NULL, transferred_at = NULL,
       created_at = excluded.created_at, version = gift_links.version + 1
     WHERE (gift_links.status IN ('cancelled', 'transferred') OR gift_links.giver_account <> excluded.giver_account)
       AND NOT EXISTS (SELECT 1 FROM gift_flights WHERE token_id = excluded.token_id AND state IN ('prepared', 'sending', 'unknown'))
     RETURNING *`,
  ).bind(tokenId, code, giver, now).first<GiftLink>();
  // A simultaneous create lost the conditional insert; both tabs get the same live code.
  if (written !== null) return written;
  const current = await linkForToken(db, tokenId);
  if (current === null || current.giver_account !== giver || current.status === 'cancelled') throw new Error('gift_create_race');
  return current;
}

export async function acceptLink(db: D1Database, code: string, account: string, name: string | null, now: number): Promise<GiftLink | null> {
  const accepted = await db.prepare(
    `UPDATE gift_links SET status = 'accepted', accepted_account = ?2, accepted_name = ?3,
       accepted_at = ?4, version = version + 1
     WHERE code = ?1 AND status = 'waiting' AND giver_account <> ?2 RETURNING *`,
  ).bind(code, account, name, now).first<GiftLink>();
  if (accepted !== null) return accepted;
  const existing = await linkForCode(db, code);
  return existing?.status === 'accepted' && existing.accepted_account === account ? existing : null;
}

export async function cancelLink(db: D1Database, tokenId: string, giver: string): Promise<GiftLink | null> {
  return db.prepare(
    `UPDATE gift_links SET status = 'cancelled', accepted_account = NULL, accepted_name = NULL,
       accepted_at = NULL, version = version + 1
     WHERE token_id = ?1 AND giver_account = ?2 AND status IN ('waiting', 'accepted')
       AND NOT EXISTS (SELECT 1 FROM gift_flights WHERE token_id = ?1 AND state IN ('prepared', 'sending', 'unknown'))
     RETURNING *`,
  ).bind(tokenId, giver).first<GiftLink>();
}

/** A direct chain transfer removes the bearer link. A gift transfer already in flight is
 * reconciled by its flight instead, so a read cannot erase its accepted recipient. */
export async function invalidateMovedLink(db: D1Database, link: GiftLink): Promise<void> {
  await db.prepare(
    `UPDATE gift_links SET status = 'cancelled', accepted_account = NULL, accepted_name = NULL,
       accepted_at = NULL, version = version + 1
     WHERE token_id = ?1 AND code = ?2 AND version = ?3
       AND NOT EXISTS (SELECT 1 FROM gift_flights WHERE token_id = ?1 AND state IN ('prepared', 'sending', 'unknown'))`,
  ).bind(link.token_id, link.code, link.version).run();
}
