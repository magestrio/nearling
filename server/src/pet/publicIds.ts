// The public identity of one pet survives gifts and skill changes. Only this mapping is stored;
// the Hire board still derives its membership from skills at each read.
export async function publicPetId(db: D1Database, tokenId: string): Promise<string> {
  const opaque = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  await db.prepare('INSERT OR IGNORE INTO pet_public_ids (token_id, opaque_id) VALUES (?, ?)').bind(tokenId, opaque).run();
  const row = await db.prepare('SELECT opaque_id FROM pet_public_ids WHERE token_id = ?').bind(tokenId).first<{ opaque_id: string }>();
  if (row === null) throw new Error('public_pet_id_missing');
  return row.opaque_id;
}
