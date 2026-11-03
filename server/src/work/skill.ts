// The private skill of a pet (`Skill data`, ADR-023 › Storage A): the label in the clear, the instruction sealed with
// AES-256-GCM under the Worker's secret `SKILL_KEY` (base64 of 32 bytes). Every write takes a fresh 96-bit IV, and the
// token id is the additional data, so a row moved to another pet does not open. The instruction is opened in memory
// only, for the owner's Skill sheet and for a worker's request; it is never logged, queued or put in an event.

const IV_BYTES = 12;
const KEY_BYTES = 32;

/** The instruction can't be read: the key is missing, lost or wrong, or the row was changed. */
export class SkillUnreadable extends Error {}

export interface Skill {
  label: string;
  instruction: string;
}

/** A BLOB as D1 hands it back: workerd gives an array of byte values, not an ArrayBuffer. */
type Bytes = ArrayBuffer | ArrayLike<number>;

interface SkillRow {
  label: string;
  ct: Bytes;
  iv: Bytes;
}

const bytesOf = (blob: Bytes): Uint8Array => (blob instanceof ArrayBuffer ? new Uint8Array(blob) : Uint8Array.from(blob));

/** The key, imported on each use: a secret read by its binding name, nothing kept in module scope. */
async function keyOf(env: Pick<Env, 'SKILL_KEY'>): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(env.SKILL_KEY), (ch) => ch.charCodeAt(0));
  } catch {
    throw new SkillUnreadable('the skill key is not base64');
  }
  if (raw.length !== KEY_BYTES) throw new SkillUnreadable('the skill key is not 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const aadOf = (aad: string): Uint8Array => new TextEncoder().encode(aad);

/** A text sealed under the skills key with `aad` as additional data and an IV made for this write alone. The skill's
 * instruction (`aad` = the token id), a data source's address (the token id and the row id) and the skill's code (the
 * token id and «code») all go through here (ADR-023, ADR-024, ADR-025): a row moved to another pet or table does not open. */
export async function sealText(env: Pick<Env, 'SKILL_KEY'>, aad: string, text: string): Promise<{ ct: Uint8Array; iv: Uint8Array }> {
  const key = await keyOf(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(aad) }, key, new TextEncoder().encode(text));
  return { ct: new Uint8Array(ct), iv };
}

/** A sealed text, in memory. A wrong key, another `aad` or a changed byte fails the tag. */
export async function openText(env: Pick<Env, 'SKILL_KEY'>, aad: string, row: Pick<SkillRow, 'ct' | 'iv'>): Promise<string> {
  const key = await keyOf(env);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytesOf(row.iv), additionalData: aadOf(aad) }, key, bytesOf(row.ct));
    return new TextDecoder().decode(plain);
  } catch {
    throw new SkillUnreadable('the sealed text does not open');
  }
}

/** The instruction sealed for `tokenId`. */
export const sealSkill = (env: Pick<Env, 'SKILL_KEY'>, tokenId: string, instruction: string) => sealText(env, tokenId, instruction);

/** The instruction of a row, in memory. */
export const openSkill = (env: Pick<Env, 'SKILL_KEY'>, tokenId: string, row: Pick<SkillRow, 'ct' | 'iv'>) => openText(env, tokenId, row);

/** The label for any viewer: one row, no instruction, no ciphertext. */
export async function skillLabel(db: D1Database, tokenId: string): Promise<{ label: string } | null> {
  const row = await db.prepare('SELECT label FROM skills WHERE token_id = ?').bind(tokenId).first<{ label: string }>();
  return row === null ? null : { label: row.label };
}

/** The skill of a pet, opened. `null` with none; `SkillUnreadable` when the row does not open. */
export async function readSkill(env: Pick<Env, 'DB' | 'SKILL_KEY'>, tokenId: string): Promise<Skill | null> {
  const row = await env.DB.prepare('SELECT label, ct, iv FROM skills WHERE token_id = ?').bind(tokenId).first<SkillRow>();
  if (row === null) return null;
  return { label: row.label, instruction: await openSkill(env, tokenId, row) };
}

/** Seals and stores the skill; a new text replaces the old one. Nothing is stored when sealing fails. */
export async function writeSkill(env: Pick<Env, 'DB' | 'SKILL_KEY'>, tokenId: string, skill: Skill, now: number): Promise<void> {
  const sealed = await sealSkill(env, tokenId, skill.instruction);
  await env.DB.prepare(
    'INSERT INTO skills (token_id, label, ct, iv, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (token_id) DO UPDATE SET label = excluded.label, ct = excluded.ct, iv = excluded.iv, updated_at = excluded.updated_at',
  )
    .bind(tokenId, skill.label, sealed.ct, sealed.iv, now)
    .run();
}

/** The skill goes with its data sources, its code and the pet's entries in the catalog, in one batch (`Skill writing
 * flow` › «skill forgotten», `Data source data` › «memory cleared»). Copies of an entry in other pets' skills stay. */
export async function deleteSkill(db: D1Database, tokenId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM skills WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM data_sources WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM catalog_entries WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM skill_code WHERE token_id = ?').bind(tokenId),
  ]);
}
