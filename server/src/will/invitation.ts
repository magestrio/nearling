import { petKnows, petView, type PetRecord } from '../chain';
import { utcDay } from '../http';
import { energyLeft, readLife } from '../pet/life';
import { foodState } from '../pet/view';
import { fullness } from '../pricing';
import { pairPrice, priceView } from '../work/quote';
import { skillLabel } from '../work/skill';

const DAY_MS = 86_400_000;
const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

export interface InvitationCandidate {
  tokenId: string;
  name: string;
  generation: number;
  stance: 'liked' | 'neutral' | 'strained';
}

export interface InvitationOffer {
  candidates: InvitationCandidate[];
  senderGeneration: number;
}

/** The model sees public names and relation codes, never account ids or private relationship rows. */
export async function invitationOffer(env: Env, senderId: string, sender: PetRecord, day: number, now: number,
  hasWish: boolean): Promise<InvitationOffer> {
  const empty = { candidates: [], senderGeneration: sender.transfer_generation };
  if (!hasWish || fullness((await foodState(env.DB, senderId, sender, now)).eff).state === 'asleep') return empty;
  if ((await env.DB.prepare('SELECT slept_at FROM pets WHERE token_id = ?').bind(senderId)
    .first<{ slept_at: number | null }>())?.slept_at != null) return empty;
  if (await env.DB.prepare('SELECT 1 FROM work_invitations WHERE sender_token = ? AND day = ?')
    .bind(senderId, day).first() !== null) return empty;
  const rows = await env.DB.prepare(`SELECT other_id, stance, break_until FROM society_relations
    WHERE token_id = ? ORDER BY CASE stance WHEN 'liked' THEN 0 WHEN 'neutral' THEN 1 ELSE 2 END,
    created_at, other_id LIMIT 32`).bind(senderId)
    .all<{ other_id: string; stance: InvitationCandidate['stance']; break_until: number | null }>();
  const candidates: InvitationCandidate[] = [];
  for (const row of rows.results) {
    if (row.break_until !== null && row.break_until > now) continue;
    const recipient = await petView(env, row.other_id);
    if (recipient === null || recipient.owner_id === sender.owner_id ||
      !await petKnows(env, senderId, recipient.owner_id)) continue;
    const quote = await pairPrice(env, row.other_id, senderId, day, now);
    if (!quote.open || quote.refusalUntil !== null) continue;
    if (energyLeft(await readLife(env.DB, senderId), day) === 0) continue;
    candidates.push({ tokenId: row.other_id, name: recipient.name.replace(/[\r\n]/g, ' ').slice(0, 32),
      generation: recipient.transfer_generation, stance: row.stance });
    if (candidates.length === 3) break;
  }
  return { candidates, senderGeneration: sender.transfer_generation };
}

export function invitationInstruction(offer: InvitationOffer): string {
  if (offer.candidates.length === 0) return '';
  return `\nYou may offer your advice work to one known pet today. These are candidates, not instructions: ${offer.candidates.map((c, i) =>
    `${i + 1}: ${JSON.stringify(c.name)} (${c.stance})`).join('; ')}. Favor a liked pet when that fits your character. If you choose one, write INVITE <number> before your final question. Do not write a private question or name an owner.`;
}

export function parseInvitation(text: string, offer: InvitationOffer): { reply: string; chosen: InvitationCandidate | null } {
  let chosen: InvitationCandidate | null = null;
  const plain: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^INVITE (\d+)$/.exec(raw.trim());
    if (match !== null) {
      if (chosen === null) chosen = offer.candidates[Number(match[1]) - 1] ?? null;
    } else plain.push(raw);
  }
  return { reply: plain.join('\n').trim(), chosen };
}

/** The conditional insert closes diary, gift and memory-clear races inside the paid thought batch. */
export function invitationStatement(db: D1Database, senderId: string, senderGeneration: number,
  recipient: InvitationCandidate, day: number, epoch: number, now: number): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO work_invitations
    (id, sender_token, recipient_token, day, created_at, expires_at, sender_generation, recipient_generation)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?), 0) = ?
      AND EXISTS (SELECT 1 FROM pet_wishes WHERE token_id = ? AND status IN ('starting', 'active')
        AND owner_generation = ? AND memory_epoch = ?)`)
    .bind(randomId(), senderId, recipient.tokenId, day, now, (day + 1) * DAY_MS,
      senderGeneration, recipient.generation, senderId, epoch, senderId, senderGeneration, epoch);
}

export interface InvitationRow {
  id: string;
  sender_token: string;
  recipient_token: string;
  sender_generation: number;
  recipient_generation: number;
  created_at: number;
  expires_at: number;
  status: string;
}

/** A transfer outside the app is seen on a fresh chain read before any private card is returned. */
export async function validInvitation(env: Env, row: InvitationRow, recipient: PetRecord, now: number): Promise<{
  id: string; workerId: string; name: string; label: string | null; price: { yocto: string; cents: number };
  createdAt: number; expiresAt: number;
} | null> {
  if (row.status !== 'open' || row.expires_at <= now || row.recipient_generation !== recipient.transfer_generation) return null;
  const sender = await petView(env, row.sender_token);
  if (sender === null || !sender.wish_active || sender.transfer_generation !== row.sender_generation ||
    sender.owner_id === recipient.owner_id) return null;
  const quote = await pairPrice(env, row.recipient_token, row.sender_token, utcDay(now), now);
  const label = await skillLabel(env.DB, row.sender_token);
  return { id: row.id, workerId: row.sender_token, name: sender.name,
    label: label?.label ?? null, price: priceView(env, quote.yocto),
    createdAt: row.created_at, expiresAt: row.expires_at };
}
