import { env } from 'cloudflare:workers';
import { api } from './api';
import { NEAR_ACCOUNT, token } from './network';

export const EXPERIENCE_PET = '5';
export const EXPERIENCE_OWNER = NEAR_ACCOUNT(1);
export const EXPERIENCE_NEXT = NEAR_ACCOUNT(2);
export const EXPERIENCE_NOTE = 'a'.repeat(24);
export const experienceToken = (account = EXPERIENCE_OWNER) => token(`did:privy:experience-${account.slice(0, 8)}`, account);

/** A billed, public receipt and its private retained note; no AI call is needed for route tests. */
export async function savedExperience(id = EXPERIENCE_NOTE, at = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO thoughts (id, token_id, created_at, kind, form, model, price_yocto, price_usd_micros,
       payer, status, receipt_token_id, paying_token_id, debit_tx_hash, completed_errand)
     VALUES (?, ?, ?, 'errand', 'find', 'model', '100', 1, 'pet', 'billed', ?, ?, ?, 1)`,
  ).bind(id, EXPERIENCE_PET, at, EXPERIENCE_PET, EXPERIENCE_PET, 'tx-hash').run();
  await env.DB.prepare(
    `INSERT INTO experience_notes (source_thought_id, token_id, note_text, proposed_field,
       source_report_id, created_at, memory_epoch, owner_account, owner_generation, status)
     VALUES (?, ?, 'The Leonids peak in November.', 'the Leonids meteor shower', ?, ?, 0, ?, 0, 'active')`,
  ).bind(id, EXPERIENCE_PET, id, at, EXPERIENCE_OWNER).run();
}

export async function approveExperience(tk: string, approved: boolean, generation = 0, id = EXPERIENCE_NOTE) {
  return api(`/api/pets/${EXPERIENCE_PET}/experience/notes/${id}/approval`,
    { token: tk, method: 'PUT', body: { approved, generation } });
}

export async function publishExperience(tk: string, generation = 0, id = EXPERIENCE_NOTE) {
  return api(`/api/pets/${EXPERIENCE_PET}/experience/field`, { token: tk, body: { noteId: id, generation } });
}
