import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { approveExperience, EXPERIENCE_NEXT, EXPERIENCE_NOTE, EXPERIENCE_OWNER, EXPERIENCE_PET,
  experienceToken, publishExperience, savedExperience } from './helpers/experience';

const h = harness();

describe('Public work record', () => {
  // spec: add-pet-experience › Public experience data › guest read
  it('serves chain counts and billed receipt pointers to a guest without note words', async () => {
    h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    h.net().contract.experienceCounts.set(EXPERIENCE_PET, { paid_hires: 2, completed_errands: 1 });
    await savedExperience();
    const tk = await experienceToken();
    await approveExperience(tk, true);
    await publishExperience(tk);
    const read = await api(`/api/pets/${EXPERIENCE_PET}/work`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ counts: { paidHires: 2, completedErrands: 1 },
      field: { wording: 'Worked on the Leonids meteor shower', sourceReportId: EXPERIENCE_NOTE },
      receipts: [{ thoughtId: EXPERIENCE_NOTE, tokenId: EXPERIENCE_PET, debitTxHash: 'tx-hash' }] });
    expect(JSON.stringify(read.body)).not.toContain('The Leonids peak in November.');
    expect(JSON.stringify(read.body)).not.toContain(EXPERIENCE_OWNER);
  });

  // spec: add-pet-experience › Work record screen › success
  it('includes a worker receipt only after its hire is recorded', async () => {
    h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    const answer = 'b'.repeat(24);
    await env.DB.prepare(`INSERT INTO thoughts (id, token_id, created_at, kind, model, price_yocto,
      price_usd_micros, payer, status, receipt_token_id, worker_id, debit_tx_hash)
      VALUES (?, '6', ?, 'advice', 'model', '100', 1, 'pet', 'billed', ?, ?, 'tx-hash')`)
      .bind(answer, Date.now(), EXPERIENCE_PET, EXPERIENCE_PET).run();
    expect((await api(`/api/pets/${EXPERIENCE_PET}/work`)).body.receipts).toEqual([]);
    await env.DB.prepare(`INSERT INTO hires (id, hirer_id, worker_id, worker_name, kind, fee_yocto,
      fee_usd_micros, answer_thought_id, status, created_at)
      VALUES (?, '6', ?, 'Pixel', 'player', '100', 1, ?, 'recorded', ?)`)
      .bind('hire-recorded', EXPERIENCE_PET, answer, Date.now()).run();
    expect((await api(`/api/pets/${EXPERIENCE_PET}/work`)).body.receipts).toMatchObject([{ thoughtId: answer }]);
  });

  // spec: add-pet-experience › Public experience data › field hidden on transfer
  it('hides the field after gift while permanent counts and receipts remain', async () => {
    const pet = h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    h.net().contract.experienceCounts.set(EXPERIENCE_PET, { paid_hires: 0, completed_errands: 1 });
    await savedExperience();
    const tk = await experienceToken();
    await approveExperience(tk, true);
    await publishExperience(tk);
    pet.owner_id = EXPERIENCE_NEXT;
    pet.transfer_generation = 1;
    const read = await api(`/api/pets/${EXPERIENCE_PET}/work`);
    expect(read.body.field).toBeNull();
    expect(read.body.counts.completedErrands).toBe(1);
    expect(read.body.receipts).toHaveLength(1);
  });

  // spec: add-pet-experience › Work record screen › unknown pet
  // spec: add-pet-experience › Work record screen › error
  it('distinguishes an unknown NFT from an unavailable chain read', async () => {
    expect((await api(`/api/pets/${EXPERIENCE_PET}/work`)).body.code).toBe('no_pet');
    h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    h.net().contract.down = true;
    const down = await api(`/api/pets/${EXPERIENCE_PET}/work`);
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('chain_unreachable');
  });

  // spec: add-pet-experience › Experience approval flow › publish field
  it('keeps a prior field if a stale or missing candidate cannot be published', async () => {
    h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    await savedExperience();
    const tk = await experienceToken();
    await approveExperience(tk, true);
    await publishExperience(tk);
    expect((await publishExperience(tk, 0, 'b'.repeat(24))).status).toBe(409);
    expect((await publishExperience(tk, 1)).status).toBe(409);
    h.net().contract.down = true;
    expect((await publishExperience(tk)).status).toBe(503);
    h.net().contract.down = false;
    expect((await api(`/api/pets/${EXPERIENCE_PET}/work`)).body.field.wording).toBe('Worked on the Leonids meteor shower');
  });

  // spec: add-pet-experience › Experience capture flow › seventh note
  it('hides a field whose retained source was replaced', async () => {
    h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    await savedExperience();
    const tk = await experienceToken();
    await approveExperience(tk, true);
    await publishExperience(tk);
    await env.DB.prepare('DELETE FROM experience_notes WHERE source_thought_id = ?').bind(EXPERIENCE_NOTE).run();
    const read = await api(`/api/pets/${EXPERIENCE_PET}/work`);
    expect(read.body.field).toBeNull();
    expect(read.body.receipts).toHaveLength(1);
  });
});
