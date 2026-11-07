import { track } from '../track';
import { recordSocietyEvent } from './events';
import { applySettledReaction, type Reaction } from './relations';

interface Pending {
  id: string;
  hirer_id: string;
  worker_id: string;
  society_reaction: Reaction;
  society_payer_epoch: number;
  society_worker_epoch: number;
  day: number;
}

function eventId(hireId: string, subject: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${hireId}:${subject}`)).then((hash) => {
    const hex = [...new Uint8Array(hash)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  });
}

/** The game and playtest D1s cannot share a transaction: the stable opaque event id makes a retry safe. */
async function sendPendingEvents(env: Env): Promise<void> {
  const rows = await env.DB.prepare(`SELECT hire_id, token_id, kind, state FROM society_encounters
    WHERE event_recorded = 0 AND state IS NOT NULL ORDER BY day, rowid LIMIT 30`)
    .all<{ hire_id: string; token_id: string; kind: string; state: 'neutral' | 'liked' | 'strained' }>();
  for (const row of rows.results) {
    const cause = row.kind === 'quarrel' ? 'rude' : 'paid_help';
    const written = await recordSocietyEvent(env, 'pet_relationship_changed',
      { id: await eventId(row.hire_id, row.token_id), cause, state: row.state });
    if (written === null) continue;
    await env.DB.prepare('UPDATE society_encounters SET event_recorded = 1 WHERE hire_id = ? AND token_id = ? AND event_recorded = 0')
      .bind(row.hire_id, row.token_id).run();
    if (written > 0) track('pet_relationship_changed', { cause, state: row.state });
  }
}

/** Reconciles a chain-accepted hire even if the Worker died between D1 settlement and this write. */
export async function settleSocietyPending(env: Env): Promise<void> {
  const rows = await env.DB.prepare(`SELECT h.id, h.hirer_id, h.worker_id, h.society_reaction,
      h.society_payer_epoch, h.society_worker_epoch, h.record_day AS day
    FROM hires h
    WHERE h.status = 'recorded' AND h.record_day IS NOT NULL AND h.society_reaction IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM society_processed_hires p WHERE p.hire_id = h.id)
    ORDER BY h.created_at, h.rowid LIMIT 20`).all<Pending>();
  for (const row of rows.results) {
    const at = Date.now();
    await applySettledReaction(env.DB, row.id, row.hirer_id, row.worker_id,
      row.society_reaction, at, { payerEpoch: row.society_payer_epoch, workerEpoch: row.society_worker_epoch }, row.day);
  }
  await sendPendingEvents(env);
}
