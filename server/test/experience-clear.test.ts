import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { approveExperience, EXPERIENCE_NOTE, EXPERIENCE_OWNER, EXPERIENCE_PET,
  experienceToken, publishExperience, savedExperience } from './helpers/experience';
import { forgetStatements } from '../src/pet/forget';

const h = harness();

describe('Experience memory clear', () => {
  // spec: add-pet-experience › Experience clear flow › memory cleared
  it('deletes active notes, approval and field in one clear batch but keeps public counts and paid receipt', async () => {
    h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    h.net().contract.experienceCounts.set(EXPERIENCE_PET, { paid_hires: 1, completed_errands: 1 });
    await savedExperience();
    const tk = await experienceToken();
    await approveExperience(tk, true);
    await publishExperience(tk);
    await env.DB.prepare(
      `INSERT INTO receipt_links (code_hash, thought_id, paying_token_id, publisher, operation_id,
       published_at, transfer_generation) VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).bind('c'.repeat(64), EXPERIENCE_NOTE, EXPERIENCE_PET, EXPERIENCE_OWNER, 'clear-experience-001', Date.now()).run();
    expect((await api(`/api/pets/${EXPERIENCE_PET}/memory/clear`, { token: tk, body: {} })).status).toBe(200);
    expect(await env.DB.prepare('SELECT * FROM experience_notes').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM experience_field').first()).toBeNull();
    expect((await env.DB.prepare('SELECT revoked_at FROM receipt_links').first<{ revoked_at: number | null }>())?.revoked_at).not.toBeNull();
    const publicRead = await api(`/api/pets/${EXPERIENCE_PET}/work`);
    expect(publicRead.body.field).toBeNull();
    expect(publicRead.body.counts).toMatchObject({ paidHires: 1, completedErrands: 1 });
    expect(publicRead.body.receipts).toHaveLength(1);
    expect((await api(`/api/pets/${EXPERIENCE_PET}/experience`, { token: tk })).body.notes).toEqual([]);
  });

  // spec: add-pet-experience › Experience capture flow › eligible report × memory clear before debit
  it('prevents a staged report from restoring an erased note or field', async () => {
    h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    await savedExperience();
    await env.DB.prepare("UPDATE experience_notes SET status = 'staged'").run();
    await env.DB.batch(forgetStatements(env.DB, EXPERIENCE_PET, Date.now()));
    expect(await env.DB.prepare('SELECT * FROM experience_notes').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM experience_field').first()).toBeNull();
    expect((await env.DB.prepare('SELECT memory_epoch FROM pets WHERE token_id = ?').bind(EXPERIENCE_PET)
      .first<{ memory_epoch: number }>())?.memory_epoch).toBe(1);
  });
});
