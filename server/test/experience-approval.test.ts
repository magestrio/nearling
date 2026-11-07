import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { approveExperience, EXPERIENCE_NEXT, EXPERIENCE_NOTE, EXPERIENCE_OWNER, EXPERIENCE_PET,
  experienceToken, publishExperience, savedExperience } from './helpers/experience';

const h = harness();

describe('Experience owner approval', () => {
  // spec: add-pet-experience › Experience approval flow › approve note
  // spec: add-pet-experience › Experience approval flow › approve note × second tap / response lost
  it('reads private notes only for the fresh owner and approves a retained paid note idempotently', async () => {
    h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    await savedExperience();
    const tk = await experienceToken();
    expect((await api(`/api/pets/${EXPERIENCE_PET}/experience`)).status).toBe(401);
    expect((await api(`/api/pets/${EXPERIENCE_PET}/experience`, { token: await experienceToken(EXPERIENCE_NEXT) })).status).toBe(403);
    const before = await api(`/api/pets/${EXPERIENCE_PET}/experience`, { token: tk });
    expect(before.body.notes).toMatchObject([{ id: EXPERIENCE_NOTE, approved: false,
      text: 'The Leonids peak in November.', proposedField: 'Worked on the Leonids meteor shower', sourceForm: 'find' }]);
    expect((await approveExperience(tk, true)).status).toBe(200);
    expect((await approveExperience(tk, true)).status).toBe(200);
    expect((await env.DB.prepare('SELECT approved_generation FROM experience_notes').first<any>()).approved_generation).toBe(0);
    expect((await api(`/api/pets/${EXPERIENCE_PET}/experience`, { token: tk })).body.notes[0].approved).toBe(true);
  });

  // spec: add-pet-experience › Experience approval flow › revoke note
  // spec: add-pet-experience › Experience approval flow › publish field
  it('publishes the stored wording only with approval, then hides a revoked source', async () => {
    h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    await savedExperience();
    const tk = await experienceToken();
    expect((await publishExperience(tk)).status).toBe(409);
    await approveExperience(tk, true);
    expect((await publishExperience(tk)).status).toBe(200);
    expect((await publishExperience(tk)).status).toBe(200);
    const field = await env.DB.prepare('SELECT wording FROM experience_field').first<{ wording: string }>();
    expect(field?.wording).toBe('Worked on the Leonids meteor shower');
    expect((await approveExperience(tk, false)).status).toBe(200);
    expect((await approveExperience(tk, false)).status).toBe(200);
    expect(await env.DB.prepare('SELECT * FROM experience_field').first()).toBeNull();
    expect((await api(`/api/pets/${EXPERIENCE_PET}/work`)).body.field).toBeNull();
  });

  // spec: add-pet-experience › Experience approval flow › lost ownership
  // spec: add-pet-experience › Experience transfer flow › gift confirmed
  // spec: add-pet-experience › Experience approval flow › approve note × gift / direct NFT transfer
  it('makes old approval and field inert on a gift, and refuses a stale sheet even after a gift back', async () => {
    const pet = h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    await savedExperience();
    const old = await experienceToken();
    await approveExperience(old, true);
    await publishExperience(old);
    pet.owner_id = EXPERIENCE_NEXT;
    pet.transfer_generation = 1;
    expect((await api(`/api/pets/${EXPERIENCE_PET}/experience`, { token: old })).status).toBe(403);
    expect((await approveExperience(old, false)).status).toBe(403);
    expect((await publishExperience(old)).status).toBe(403);
    expect((await api(`/api/pets/${EXPERIENCE_PET}/work`)).body.field).toBeNull();
    const next = await experienceToken(EXPERIENCE_NEXT);
    expect((await api(`/api/pets/${EXPERIENCE_PET}/experience`, { token: next })).body.notes[0].approved).toBe(false);
    expect((await approveExperience(next, true, 0)).status).toBe(409);
    expect((await approveExperience(next, true, 1)).status).toBe(200);
    expect((await publishExperience(next, 1)).status).toBe(200);
    pet.owner_id = EXPERIENCE_OWNER;
    pet.transfer_generation = 2;
    expect((await publishExperience(old, 0)).status).toBe(409);
    expect((await api(`/api/pets/${EXPERIENCE_PET}/work`)).body.field).toBeNull();
  });
});
