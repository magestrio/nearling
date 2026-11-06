// The code exists only in a response or URL. D1 stores its SHA-256; the random on-chain job
// hash is enough to derive the same code for the current owner after a lost response.
import type { PetRecord } from '../chain';

export interface SharedErrandRow {
  token_id: string;
  code_hash: string;
  job_hash: string;
  owner_account: string;
  owner_generation: number;
  memory_epoch: number;
  form: 'find' | 'check';
  job: string;
  allowance_yocto: string;
  state: 'opening' | 'funding' | 'running' | 'reported' | 'failed' | 'closed';
  report: string | null;
  sources: string | null;
  receipt_id: string | null;
  open_tx_hash: string | null;
  open_signed_bytes: ArrayBuffer | number[] | null;
  open_rebroadcast_at: number | null;
  created_at: number;
  updated_at: number;
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function randomJobHash(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashCode(code: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))));
}

export async function codeForJob(env: Pick<Env, 'SKILL_KEY'>, jobHash: string): Promise<string> {
  const key = Uint8Array.from(atob(env.SKILL_KEY), (char) => char.charCodeAt(0));
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const input = new TextEncoder().encode(`nearling-shared-errand-link:v1:${jobHash}`);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', imported, input)));
}

export function sharedUrl(tokenId: string, code: string): string {
  return `/pet/${tokenId}/errand/${code}`;
}

export const sharedForToken = (db: D1Database, tokenId: string): Promise<SharedErrandRow | null> =>
  db.prepare('SELECT * FROM shared_errands WHERE token_id = ?').bind(tokenId).first<SharedErrandRow>();

export const sharedForCode = (db: D1Database, tokenId: string, codeHash: string): Promise<SharedErrandRow | null> =>
  db.prepare('SELECT * FROM shared_errands WHERE token_id = ? AND code_hash = ?').bind(tokenId, codeHash).first<SharedErrandRow>();

/** A gift, clear, or chain closure revokes the code and every sponsor in one D1 statement. */
export async function eraseShared(db: D1Database, row: SharedErrandRow): Promise<void> {
  await db.prepare('DELETE FROM shared_errands WHERE token_id = ? AND job_hash = ?').bind(row.token_id, row.job_hash).run();
}

/** Chain ownership, generation, hash and memory epoch are checked before any private field is served. */
export function linkIsCurrent(row: SharedErrandRow, pet: PetRecord, epoch: number): boolean {
  return row.owner_account === pet.owner_id && row.owner_generation === pet.transfer_generation
    && row.memory_epoch === epoch && (pet.shared_job?.hash === row.job_hash ||
      (row.receipt_id !== null && (row.state === 'reported' || row.state === 'failed') && pet.shared_job == null));
}
