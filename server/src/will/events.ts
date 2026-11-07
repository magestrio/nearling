import { OPAQUE_ID, type OpaqueIds } from '../experience/events';
import { JUDGE_DELETE_AT } from '../judge';

export type WillEvent = 'pet_wish_chosen' | 'pet_wish_saved' | 'pet_wish_canceled' |
  'outfit_bought' | 'pet_work_invited' | 'pet_work_invitation_accepted' | 'pet_hire_refused';
export type WillEventData = { id?: string; ids?: OpaqueIds; amount_usd?: number;
  via?: 'pet_wish'; reason?: 'character'; by?: 'player' | 'pet'; project_usd?: number };
const EVENT_ID = /^(?:[0-9a-f]{24}|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const KEYS = new Set(['id', 'ids', 'amount_usd', 'via', 'reason', 'by', 'project_usd']);

/** The same bounded EVENTS-D1 path as experience and society. A rejected payload is never logged. */
export async function recordWillEvent(env: Pick<Env, 'EVENTS'>, name: WillEvent,
  data: WillEventData = {}): Promise<number | null> {
  if (Date.now() >= JUDGE_DELETE_AT) return 0;
  if (Object.keys(data).some((key) => !KEYS.has(key)) ||
    (data.id !== undefined && !EVENT_ID.test(data.id)) ||
    (data.ids !== undefined && Object.values(data.ids).some((value) => !OPAQUE_ID.test(value)))) return null;
  const empty = data.amount_usd === undefined && data.via === undefined && data.reason === undefined &&
    data.by === undefined && data.project_usd === undefined;
  const valid = name === 'pet_wish_saved'
    ? typeof data.amount_usd === 'number' && Number.isFinite(data.amount_usd) && data.amount_usd >= 0 &&
      data.via === undefined && data.reason === undefined && data.by === undefined && data.project_usd === undefined
    : name === 'outfit_bought' ? data.via === 'pet_wish' && data.amount_usd === undefined && data.reason === undefined && data.by === undefined && data.project_usd === undefined
      : name === 'pet_hire_refused' ? data.reason === 'character' && (data.by === 'player' || data.by === 'pet') &&
        typeof data.project_usd === 'number' && Number.isFinite(data.project_usd) && data.project_usd >= 0 &&
        data.amount_usd === undefined && data.via === undefined
        : empty;
  if (!valid) return null;
  try {
    const result = await env.EVENTS.prepare(`INSERT OR IGNORE INTO will_events
      (id, at, name, amount_usd, via, reason, by_kind, project_usd, tab_id, player_id, pet_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(data.id ?? crypto.randomUUID(), Date.now(), name,
      data.amount_usd ?? null, data.via ?? null, data.reason ?? null, data.by ?? null, data.project_usd ?? null,
      data.ids?.tabId ?? null, data.ids?.playerId ?? null, data.ids?.petId ?? null).run();
    return result.meta.changes;
  } catch { console.log('will_event_write_failed'); return null; }
}
