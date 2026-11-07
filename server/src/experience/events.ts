import { JUDGE_DELETE_AT } from '../judge';

export type ExperienceEvent = 'experience_note_saved' | 'experience_note_approved' |
  'experience_field_published' | 'experience_record_opened' | 'pet_hired';

export interface OpaqueIds { tabId: string; playerId: string; petId: string }
export const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Event failures never undo the paid work or the owner's choice. No private value is accepted. */
export async function recordExperienceEvent(env: Pick<Env, 'EVENTS'>, name: ExperienceEvent,
  data: { approved?: boolean; experience?: boolean; ids?: OpaqueIds } = {}): Promise<void> {
  if (Date.now() >= JUDGE_DELETE_AT) return;
  try {
    await env.EVENTS.prepare(`INSERT INTO experience_events
      (id, at, name, approved, experience, tab_id, player_id, pet_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), Date.now(), name,
      data.approved === undefined ? null : Number(data.approved),
      data.experience === undefined ? null : Number(data.experience),
      data.ids?.tabId ?? null, data.ids?.playerId ?? null, data.ids?.petId ?? null).run();
  } catch { console.log('experience_event_write_failed'); }
}

