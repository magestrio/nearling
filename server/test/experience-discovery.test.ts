import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { findCandidates, type Candidate } from '../src/work/candidates';
import { hireLayer } from '../src/prompt';
import { harness, api } from './helpers/api';
import { approveExperience, experienceToken, publishExperience, savedExperience,
  EXPERIENCE_OWNER, EXPERIENCE_PET } from './helpers/experience';
import { addHirer, addWorker, hirerNow, PAYER, saveSkill } from './helpers/work';

const h = harness();

describe('public experience choice facts', () => {
  // spec: add-pet-experience › Experience discovery rule › board card
  it('adds only a checked field and counts to a board card while keeping its quote', async () => {
    h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    h.net().contract.experienceCounts.set(EXPERIENCE_PET, { paid_hires: 2, completed_errands: 1 });
    await saveSkill('Study meteor showers.', 'Astronomy', EXPERIENCE_PET);
    await savedExperience();
    const tk = await experienceToken();
    await approveExperience(tk, true);
    await publishExperience(tk);
    const before = await api('/api/hire');
    expect(before.status).toBe(200);
    const card = before.body.pets[0];
    expect(card.experience).toMatchObject({ field: 'Worked on the Leonids meteor shower', paidHires: 2, completedErrands: 1 });
    const quote = card.price;
    const pet = h.net().contract.pets.get(EXPERIENCE_PET)!;
    pet.owner_id = 'b'.repeat(64);
    pet.transfer_generation = 1;
    // The guest snapshot can be 15 seconds old. The checked field must still disappear at its next fresh read.
    const after = await api('/api/hire');
    expect(after.body.pets[0].price).toEqual(quote);
    expect(after.body.pets[0].experience.field).toBeNull();
    expect(after.body.pets[0].experience.completedErrands).toBe(1);
    expect(JSON.stringify(after.body)).not.toContain('The Leonids peak in November.');
  });

  // spec: add-pet-experience › Experience discovery rule › acquainted candidate
  it('uses public labels in the candidate layer without private note text or a changed fee', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    h.net().contract.pets.get(PAYER)!.work_known = ['6'];
    h.net().contract.experienceCounts.set('6', { paid_hires: 3, completed_errands: 2 });
    await saveSkill('Study the stars.', 'Astronomy', '6');
    const initial = await findCandidates(env, await hirerNow(), 'manual', Date.now());
    expect(initial).toHaveLength(1);
    const price = (initial[0] as Candidate).price;
    const later = await findCandidates(env, await hirerNow(), 'manual', Date.now());
    expect(later[0]!.price).toBe(price);
    expect(later[0]!.experience).toMatchObject({ paidHires: 3, completedErrands: 2 });
    const layer = hireLayer(later);
    expect(layer).toContain('paid hires: 3; completed errands: 2');
    expect(layer).not.toContain('Study the stars.');
    expect(layer).not.toContain('owner_id');
  });
});
