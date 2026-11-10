import { JUDGE_DELETE_AT } from '../judge';

const OPAQUE = /^[0-9a-f]{32,64}$/;
const TAB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable private player identity for coded playtest events, never the account or Privy DID. */
export async function opaquePlayerId(sub: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type Birth = { name: 'pet_born'; petId: string; repeat: boolean; playerId: string | null };
type Board = { name: 'hire_board_opened' | 'hire_board_pet_opened'; tabId: string; playerId: string | null;
  petId?: string; device: 'desktop' | 'phone'; hasOwnedPet?: boolean };

/** The same best-effort, coded EVENTS-D1 path used by experience, society and will. */
export async function recordHatchEvent(env: Pick<Env, 'EVENTS'>, event: Birth | Board): Promise<void> {
  if (Date.now() >= JUDGE_DELETE_AT) return;
  if ((event.petId !== undefined && !OPAQUE.test(event.petId)) ||
    (event.playerId !== null && !OPAQUE.test(event.playerId)) ||
    (event.name !== 'pet_born' && !TAB.test(event.tabId))) return;
  const id = event.name === 'pet_born' ? event.petId : crypto.randomUUID();
  try {
    await env.EVENTS.prepare(`INSERT OR IGNORE INTO hatch_again_events
      (id, at, name, tab_id, player_id, pet_id, device, repeat, has_owned_pet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, Date.now(), event.name,
        event.name === 'pet_born' ? null : event.tabId, event.playerId,
        event.name === 'hire_board_opened' ? null : event.petId,
        event.name === 'pet_born' ? null : event.device,
        event.name === 'pet_born' ? Number(event.repeat) : null,
        event.name === 'pet_born' ? null : event.hasOwnedPet === undefined ? null : Number(event.hasOwnedPet)).run();
  } catch { console.log('hatch_event_write_failed'); }
}
