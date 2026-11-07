import { OPAQUE_ID, type OpaqueIds } from '../experience/events';
import { JUDGE_DELETE_AT } from '../judge';
import type { Stance } from './relations';

type Event = 'pet_relationship_changed' | 'pet_hire_refused' | 'society_diary_seen';
type Data = { cause?: 'paid_help' | 'rude'; state?: Stance; by?: 'player' | 'pet';
  reason?: 'relationship'; ids?: OpaqueIds; id?: string; ip?: string };

/** Only enum/boolean outcome data enters the private event database. */
export async function recordSocietyEvent(env: Pick<Env, 'EVENTS'>, name: Event, data: Data = {}): Promise<number | null> {
  if (Date.now() >= JUDGE_DELETE_AT) return 0;
  if (data.ids !== undefined && Object.values(data.ids).some((id) => !OPAQUE_ID.test(id))) return null;
  if (data.id !== undefined && !OPAQUE_ID.test(data.id)) return null;
  const valid = name === 'pet_relationship_changed'
    ? (data.cause === 'paid_help' || data.cause === 'rude') &&
      (data.state === 'neutral' || data.state === 'liked' || data.state === 'strained')
    : name === 'pet_hire_refused' ? (data.by === 'player' || data.by === 'pet') && data.reason === 'relationship'
      : name === 'society_diary_seen' && data.id !== undefined && data.ids !== undefined && data.ip !== undefined;
  if (!valid) return null;
  try {
    if (name === 'society_diary_seen') {
      const now = Date.now();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.ip!)));
      const ipKey = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      const result = await env.EVENTS.prepare(`INSERT INTO society_diary_event_attempt
        (id, at, tab_id, player_id, pet_id, ip_key, minute_bucket, day_bucket)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(data.id!, now, data.ids!.tabId, data.ids!.playerId, data.ids!.petId,
          ipKey, Math.floor(now / 60_000), Math.floor(now / 86_400_000)).run();
      return result.meta.changes;
    }
    const result = await env.EVENTS.prepare(`INSERT OR IGNORE INTO society_events
      (id, at, name, cause, state, by_kind, reason, tab_id, player_id, pet_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(data.id ?? crypto.randomUUID(), Date.now(), name,
      data.cause ?? null, data.state ?? null, data.by ?? null, data.reason ?? null,
      data.ids?.tabId ?? null, data.ids?.playerId ?? null, data.ids?.petId ?? null).run();
    return result.meta.changes;
  } catch { console.log('society_event_write_failed'); return null; }
}
