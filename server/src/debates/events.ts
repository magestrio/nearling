import { OPAQUE_ID } from '../experience/events';
import { utcDay } from '../http';
import { JUDGE_DELETE_AT } from '../judge';
import { publicPetId } from '../pet/publicIds';

const HEX_ID = /^[0-9a-f]{64}$/;
const ENDS = new Set(['complete', 'refused', 'stopped', 'unavailable']);
type Name = 'debate_invited' | 'debate_accepted' | 'debate_started' | 'debate_line_delivered' | 'debate_ended';

export interface DebateSignal {
  name: Name;
  id: string;
  firstPet: string;
  secondPet: string;
  openerPet?: string;
  speakerPet?: string;
  order?: number;
  priceUsd?: number;
  costUsd?: number;
  reason?: string;
  at?: number;
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A random-tailed public id is hashed before it enters playtest data. */
export function opaqueDebateId(id: string): Promise<string> {
  return digest(`nearling:debate:${id}`);
}

/** A stable id lets a retried transition repair a lost EVENTS write without a second count. */
export async function recordDebateEvent(env: Pick<Env, 'DB' | 'EVENTS'>, event: DebateSignal): Promise<void> {
  if (Date.now() >= JUDGE_DELETE_AT || !HEX_ID.test(event.id) ||
    !/^\d{1,20}$/.test(event.firstPet) || !/^\d{1,20}$/.test(event.secondPet) || event.firstPet === event.secondPet) return;
  const side = event.name === 'debate_invited' ? 'first' : event.name === 'debate_accepted' ? 'second'
    : event.name === 'debate_started' ? event.openerPet === event.firstPet ? 'first' : event.openerPet === event.secondPet ? 'second' : null
      : event.name === 'debate_line_delivered' ? event.speakerPet === event.firstPet ? 'first' : event.speakerPet === event.secondPet ? 'second' : null : null;
  if ((event.name !== 'debate_ended' && side === null) ||
    (event.name === 'debate_line_delivered' && (!Number.isInteger(event.order) || event.order! < 1 || event.order! > 4 ||
      !Number.isFinite(event.priceUsd) || event.priceUsd! < 0 || !Number.isFinite(event.costUsd) || event.costUsd! < 0)) ||
    (event.name === 'debate_ended' && !ENDS.has(event.reason ?? ''))) return;
  try {
    const [first, second, debate] = await Promise.all([
      publicPetId(env.DB, event.firstPet), publicPetId(env.DB, event.secondPet), opaqueDebateId(event.id),
    ]);
    const id = await digest(`${event.name}:${event.id}:${event.order ?? ''}`);
    const at = event.at ?? Date.now();
    await env.EVENTS.prepare(`INSERT OR IGNORE INTO debate_events
      (id, at, name, debate_id, first_pet_id, second_pet_id, day, side, round, price_usd, cost_usd, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, at, event.name, debate, first, second,
      event.name === 'debate_invited' || event.name === 'debate_accepted' || event.name === 'debate_started' ? utcDay(at) : null,
      side, event.name === 'debate_line_delivered' ? Math.ceil(event.order! / 2) : null,
      event.name === 'debate_line_delivered' ? event.priceUsd : null,
      event.name === 'debate_line_delivered' ? event.costUsd : null,
      event.name === 'debate_ended' ? event.reason : null).run();
  } catch { console.log('debate_event_write_failed'); }
}

/** Browser signals use the same counter trigger as showcase and society diary views. */
export async function recordDebateOpen(env: Pick<Env, 'EVENTS'>, data: {
  eventId: string; tabId: string; debateId: string; name: 'debate_link_opened' | 'debate_receipt_opened'; ip: string;
}): Promise<void> {
  if (Date.now() >= JUDGE_DELETE_AT || !OPAQUE_ID.test(data.eventId) || !OPAQUE_ID.test(data.tabId) ||
    !HEX_ID.test(data.debateId)) return;
  try {
    const now = Date.now();
    const prerequisite = data.name === 'debate_link_opened' ? 'debate_accepted' : 'debate_line_delivered';
    const published = await env.EVENTS.prepare('SELECT 1 AS found FROM debate_events WHERE debate_id = ? AND name = ? LIMIT 1')
      .bind(data.debateId, prerequisite).first();
    if (published === null) return;
    const ipKey = await digest(data.ip);
    await env.EVENTS.prepare(`INSERT INTO debate_event_attempt
      (id, at, name, debate_id, tab_id, ip_key, minute_bucket, day_bucket)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(data.eventId, now, data.name, data.debateId, data.tabId,
      ipKey, Math.floor(now / 60_000), utcDay(now)).run();
  } catch { console.log('debate_event_write_failed'); }
}
