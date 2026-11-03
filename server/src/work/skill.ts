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

const aadOf = (tokenId: string): Uint8Array => new TextEncoder().encode(tokenId);

/** The instruction sealed for `tokenId`, with an IV made for this write alone. */
export async function sealSkill(env: Pick<Env, 'SKILL_KEY'>, tokenId: string, instruction: string): Promise<{ ct: Uint8Array; iv: Uint8Array }> {
  const key = await keyOf(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(tokenId) }, key, new TextEncoder().encode(instruction));
  return { ct: new Uint8Array(ct), iv };
}

/** The instruction of a row, in memory. A wrong key, another token id or a changed byte fails the tag. */
export async function openSkill(env: Pick<Env, 'SKILL_KEY'>, tokenId: string, row: Pick<SkillRow, 'ct' | 'iv'>): Promise<string> {
  const key = await keyOf(env);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytesOf(row.iv), additionalData: aadOf(tokenId) }, key, bytesOf(row.ct));
    return new TextDecoder().decode(plain);
  } catch {
    throw new SkillUnreadable('the skill does not open');
  }
}

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

export async function deleteSkill(db: D1Database, tokenId: string): Promise<void> {
  await db.prepare('DELETE FROM skills WHERE token_id = ?').bind(tokenId).run();
}
