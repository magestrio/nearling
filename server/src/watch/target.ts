// One public watch target per pet. The contract's transfer generation is read on every owner
// operation; a transfer pauses the saved target before the new owner may resume it.
import type { PetRecord } from '../chain';
import { utcDay } from '../http';

export type WatchKind = 'topic' | 'release' | 'account' | 'page';
export interface WatchRow {
  token_id: string;
  kind: WatchKind;
  target: string;
  revision: number;
  saved_hour_utc: number;
  paused: number;
  owner_generation: number;
  last_started_day: number | null;
  latest_result: string | null;
  latest_price_yocto: string | null;
  latest_receipt_id: string | null;
  updated_at: number;
}

export const watchRow = (db: D1Database, id: string) =>
  db.prepare('SELECT * FROM watch_targets WHERE token_id = ?').bind(id).first<WatchRow>();

export function targetKind(target: string): WatchKind {
  if (/^https?:\/\//i.test(target)) return /github\.com\/[^/]+\/[^/]+\/releases(?:\/tag\/[\w.-]+)?\/?(?:\?.*)?$/i.test(target) ? 'release' : 'page';
  if (/^(?:[a-z0-9_-]+\.)*(?:near|testnet)$/i.test(target) || /^[0-9a-f]{64}$/i.test(target)) return 'account';
  if (/^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+(?:\/releases)?$/i.test(target) || /\breleases?\b/i.test(target)) return 'release';
  return 'topic';
}

export function validTarget(raw: unknown): { target: string; kind: WatchKind } | 'blank' | 'too_long' {
  if (typeof raw !== 'string') return 'blank';
  // The public copy and its 500-character limit count Unicode code points, like errand fields.
  if ([...raw].length > 500) return 'too_long';
  const target = raw.trim();
  return target === '' ? 'blank' : { target, kind: targetKind(target) };
}

export async function syncedWatch(db: D1Database, id: string, pet: PetRecord): Promise<WatchRow | null> {
  const row = await watchRow(db, id);
  if (row === null || row.owner_generation >= pet.transfer_generation) return row;
  await db.prepare('UPDATE watch_targets SET paused = 1, owner_generation = ?, updated_at = ? WHERE token_id = ? AND owner_generation = ?')
    .bind(pet.transfer_generation, Date.now(), id, row.owner_generation).run();
  return watchRow(db, id);
}

export function nextCheck(row: WatchRow, nowMs: number, usedToday = false): string | null {
  if (row.paused) return null;
  const today = utcDay(nowMs);
  const hourAt = today * 86_400_000 + row.saved_hour_utc * 3_600_000;
  return new Date(row.last_started_day === today || usedToday || nowMs >= hourAt ? hourAt + 86_400_000 : hourAt).toISOString();
}

export async function ownerWatch(db: D1Database, row: WatchRow | null, nowMs: number): Promise<object> {
  if (row === null) return { target: null };
  const today = await db.prepare('SELECT revision, status, skip_reason FROM watch_checks WHERE token_id = ? AND day = ?')
    .bind(row.token_id, utcDay(nowMs)).first<{ revision: number; status: string; skip_reason: string | null }>();
  // Why today's check was skipped, while that is still about this target: a replaced target starts a new comparison.
  const pause = today?.status === 'skipped' && today.revision === row.revision ? today.skip_reason : null;
  return { target: row.target, kind: row.kind, savedHourUtc: row.saved_hour_utc,
    paused: row.paused === 1, pause, nextCheck: nextCheck(row, nowMs, today !== null),
    lastStartedDay: row.last_started_day, latestResult: row.latest_result,
    latestPriceYocto: row.latest_price_yocto, latestReceiptId: row.latest_receipt_id };
}
