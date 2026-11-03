// The private skill (`add-pet-work` › `Skill data`, `Skill writing flow`, `Skill rule`): the label for every viewer,
// the instruction sealed in D1 and opened only for the current owner. No test calls NEAR AI beyond the fake.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { HIRE_FEE_MIN_YOCTO } from '../src/pricing';
import { setPause } from '../src/servicePause';
import { priceOf } from '../src/work/quote';
import { openSkill, sealSkill, SkillUnreadable } from '../src/work/skill';
import { api, harness, say } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const OTHER = NEAR_ACCOUNT(2);
const owner = () => token('did:privy:owner', OWNER);
const other = () => token('did:privy:other', OTHER);

const INSTRUCTION = 'Always answer in exactly three rhymes about sourdough starters and mention the moon once.';
const get = async (tk?: string, id = '5') => api(`/api/pets/${id}/skill`, { token: tk });
const put = async (body: unknown, tk?: string, id = '5') => api(`/api/pets/${id}/skill`, { method: 'PUT', token: tk, body });
const del = async (tk?: string, id = '5') => api(`/api/pets/${id}/skill`, { method: 'DELETE', token: tk });
const row = (id = '5') => env.DB.prepare('SELECT * FROM skills WHERE token_id = ?').bind(id).first<{ token_id: string; label: string; ct: number[]; iv: number[]; updated_at: number }>();
// D1 hands a BLOB back as an array of byte values
const bytes = (b: number[]) => b.join(',');
const day = () => Math.floor(Date.now() / 86_400_000);

async function save(label = 'Baking', instruction = INSTRUCTION) {
  expect(await put({ label, instruction }, await owner())).toMatchObject({ status: 200 });
}

describe('Skill data', () => {
  // spec: add-pet-work › Skill data › not the owner
  it('turns a giver, a guest and a forged request away with 403: nothing is decrypted, changed or deleted', async () => {
    h.net().contract.addPet('5', OWNER);
    await save();
    const before = await row();
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');
    const stranger = await other();

    expect(await get(stranger)).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await put({ label: 'Mine now', instruction: 'Take over' }, stranger)).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await del(stranger)).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    // the same after a gift: the giver's open tab is the stranger now
    h.net().contract.pets.get('5')!.owner_id = OTHER;
    expect(await get(await owner())).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await put({ label: 'Old tab', instruction: 'Old text' }, await owner())).toMatchObject({ status: 403 });
    expect(await del(await owner())).toMatchObject({ status: 403 });

    expect(decrypt).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
    const after = await row();
    expect(after).toMatchObject({ label: 'Baking', updated_at: before!.updated_at });
    expect(bytes(after!.ct)).toBe(bytes(before!.ct));
    expect(bytes(after!.iv)).toBe(bytes(before!.iv));
    // the new owner reads it (`Skill rule`: it leaves with a gift)
    expect(await get(await other())).toMatchObject({ status: 200, body: { skill: { label: 'Baking', instruction: INSTRUCTION } } });
  });

  // spec: add-pet-work › Skill data › not the owner
  it('turns away a call with no session before anything is read', async () => {
    h.net().contract.addPet('5', OWNER);
    expect((await get()).status).toBe(401);
    expect((await put({ label: 'A', instruction: 'B' })).status).toBe(401);
    expect((await del()).status).toBe(401);
    expect((await get(await owner(), '77')).status).toBe(404);
    expect(await row()).toBeNull();
  });

  // spec: add-pet-work › Skill data › chain can't be read
  it('serves, changes and deletes nothing while the owner can not be read from the contract: 503 on all three', async () => {
    h.net().contract.addPet('5', OWNER);
    await save();
    const before = await row();
    const tk = await owner();
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    h.net().contract.down = true;

    expect(await get(tk)).toMatchObject({ status: 503, body: { code: 'chain_unreachable' } });
    expect(await put({ label: 'New', instruction: 'New text' }, tk)).toMatchObject({ status: 503, body: { code: 'chain_unreachable' } });
    expect(await del(tk)).toMatchObject({ status: 503, body: { code: 'chain_unreachable' } });
    expect(decrypt).not.toHaveBeenCalled();
    expect(bytes((await row())!.ct)).toBe(bytes(before!.ct));
    expect((await row())!.label).toBe('Baking');
  });

  // spec: add-pet-work › Skill writing flow › label not accepted
  it('saves and encrypts nothing for a label over 40 characters, an instruction over 1,000, an empty one or a wrong type', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');
    const cases: unknown[] = [
      { label: 'x'.repeat(41), instruction: 'ok' },
      { label: 'Baking', instruction: 'y'.repeat(1001) },
      { label: '', instruction: 'ok' },
      { label: 'Baking', instruction: '' },
      { label: 'Baking' },
      { instruction: 'ok' },
      { label: 7, instruction: 'ok' },
      { label: 'Baking', instruction: ['ok'] },
      // code points, not UTF-16 units: 41 astral signs are over, whatever their length in bytes
      { label: '🥐'.repeat(41), instruction: 'ok' },
      null,
    ];
    for (const body of cases) expect(await put(body, tk), JSON.stringify(body)?.slice(0, 40)).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(encrypt).not.toHaveBeenCalled();
    expect(await row()).toBeNull();

    // the limits themselves pass: 40 and 1,000 code points
    expect(await put({ label: '🥐'.repeat(40), instruction: 'y'.repeat(1000) }, tk)).toMatchObject({ status: 200 });
    expect(await get(tk)).toMatchObject({ body: { skill: { label: '🥐'.repeat(40), instruction: 'y'.repeat(1000) } } });
  });

  // spec: add-pet-work › Skill rule › label on the pet's page
  it('gives the label to a visitor, a guest and the owner, and no instruction, length or ciphertext to any of them', async () => {
    h.net().contract.addPet('5', OWNER);
    h.net().contract.addPet('6', OWNER);
    const visitorBefore = await api('/api/pets/5');
    expect(visitorBefore.body.skill).toBeNull();
    await save('Baking');

    const [visitor, guest, ownerView] = [await api('/api/pets/5'), await api('/api/pets/5', { token: await other() }), await api('/api/pets/5', { token: await owner() })];
    for (const view of [visitor, guest, ownerView]) {
      expect(view.body.skill).toEqual({ label: 'Baking' });
      const text = JSON.stringify(view.body);
      expect(text).not.toContain(INSTRUCTION);
      expect(text).not.toMatch(/instruction|ciphertext|"ct"|"iv"|length/i);
    }
    // a pet with no skill has none, and a pet's label is not its neighbour's
    expect((await api('/api/pets/6')).body.skill).toBeNull();

    // read from D1 on every request, never from the shared copy of the Durable Object (≤ 15 s)
    await save('Pottery');
    expect((await api('/api/pets/5')).body.skill).toEqual({ label: 'Pottery' });
    // the label is the only thing the owner's own GET adds the instruction to
    expect((await get(await owner())).body).toEqual({ skill: { label: 'Pottery', instruction: INSTRUCTION } });
  });

  // spec: add-pet-work › Skill data › forgotten
  it('removes the row on «Forget this skill», drops the label from the pet and puts the price back to fixed', async () => {
    h.net().contract.addPet('5', OWNER);
    await save();
    const skilledPrice = await priceOf(env, '5', day());
    expect(skilledPrice.yocto).toBe(HIRE_FEE_MIN_YOCTO);
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?1, ?2, 3)').bind('5', day()).run();
    expect((await priceOf(env, '5', day())).yocto).toBeGreaterThan(HIRE_FEE_MIN_YOCTO);

    const tk = await owner();
    expect(await del(tk)).toMatchObject({ status: 200, body: { skill: null } });
    expect(await row()).toBeNull();
    expect((await get(tk)).body).toEqual({ skill: null });
    expect((await api('/api/pets/5')).body.skill).toBeNull();
    // fixed again, and the day's three answers still count toward the day's ten
    const fixed = await priceOf(env, '5', day());
    expect(fixed.yocto).toBe(HIRE_FEE_MIN_YOCTO);
    expect(fixed.count).toBe(3);
    // forgetting nothing is no error
    expect(await del(tk)).toMatchObject({ status: 200 });
    expect(h.logs().join('\n')).not.toContain(INSTRUCTION);
  });

  // spec: add-pet-work › Skill data › forgotten
  it('erases the skill in the batch of the memory clear and leaves the day\'s count of answers', async () => {
    h.net().contract.addPet('5', OWNER);
    h.net().contract.addPet('6', OWNER);
    await save();
    expect(await put({ label: 'Neighbour', instruction: 'Other text' }, await owner(), '6')).toMatchObject({ status: 200 });
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?1, ?2, 4)').bind('5', day()).run();

    const res = await api('/api/pets/5/memory/clear', { method: 'POST', token: await owner() });
    expect(res.status).toBe(200);
    expect(await row('5')).toBeNull();
    expect(await row('6')).not.toBeNull();
    expect((await api('/api/pets/5')).body.skill).toBeNull();
    expect((await priceOf(env, '5', day())).count).toBe(4);
  });

  // spec: add-pet-work › Skill data › instruction can't be read
  it('answers 500 skill_unreadable for the owner when the instruction does not open: a moved row, a foreign key, a changed byte', async () => {
    h.net().contract.addPet('5', OWNER);
    h.net().contract.addPet('6', OWNER);
    await save();
    // a row moved to another token id does not open: the token id is part of what the tag covers
    const sealed = await row();
    await env.DB.prepare('INSERT INTO skills (token_id, label, ct, iv, updated_at) VALUES (?1, ?2, ?3, ?4, 1)').bind('6', 'Moved', Uint8Array.from(sealed!.ct), Uint8Array.from(sealed!.iv)).run();
    const tk = await owner();
    const moved = await get(tk, '6');
    expect(moved).toMatchObject({ status: 500, body: { code: 'skill_unreadable' } });
    expect(JSON.stringify(moved.body)).not.toContain(INSTRUCTION);
    expect(h.logs()).toContain('skill_unreadable');

    // a key that is not the one it was sealed under
    const otherKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await expect(openSkill({ SKILL_KEY: otherKey }, '5', sealed!)).rejects.toBeInstanceOf(SkillUnreadable);
    // a key that is no key
    await expect(openSkill({ SKILL_KEY: 'not base64!!' }, '5', sealed!)).rejects.toBeInstanceOf(SkillUnreadable);
    await expect(openSkill({ SKILL_KEY: btoa('too short') }, '5', sealed!)).rejects.toBeInstanceOf(SkillUnreadable);
    // one flipped byte of the ciphertext
    const flipped = new Uint8Array(sealed!.ct.slice(0));
    flipped[0] = flipped[0]! ^ 1;
    await env.DB.prepare('UPDATE skills SET ct = ?1 WHERE token_id = ?2').bind(flipped, '5').run();
    expect(await get(tk)).toMatchObject({ status: 500, body: { code: 'skill_unreadable' } });
    // the label still shows: it is in the clear
    expect((await api('/api/pets/5')).body.skill).toEqual({ label: 'Baking' });
  });

  // spec: add-pet-work › Skill data › instruction can't be read
  it('seals with a fresh IV on every write: one text twice gives two ciphertexts, and the text is not in the row', async () => {
    h.net().contract.addPet('5', OWNER);
    await save();
    const first = await row();
    await save();
    const second = await row();
    expect(bytes(second!.iv)).not.toBe(bytes(first!.iv));
    expect(bytes(second!.ct)).not.toBe(bytes(first!.ct));
    expect(new Uint8Array(first!.iv)).toHaveLength(12);
    const stored = new TextDecoder().decode(Uint8Array.from(first!.ct)) + new TextDecoder().decode(Uint8Array.from(first!.iv));
    expect(stored).not.toContain('sourdough');
    // a separate seal of the same text for the same pet differs too
    const a = await sealSkill(env, '5', INSTRUCTION);
    const b = await sealSkill(env, '5', INSTRUCTION);
    expect(a.ct).not.toEqual(b.ct);
    expect(await openSkill(env, '5', { ct: a.ct, iv: a.iv })).toBe(INSTRUCTION);
  });
});

describe('Skill writing flow', () => {
  // spec: add-pet-work › Skill writing flow › skill saved
  it('stores both parts, replaces the old text with a new one and fires skill_saved with kind private; it costs nothing', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    const food = { ...h.net().contract.pets.get('5')! };
    expect(await put({ label: 'Baking', instruction: INSTRUCTION }, tk)).toEqual({ status: 200, body: { skill: { label: 'Baking' } } });
    expect(h.events()).toEqual([{ name: 'skill_saved', props: { kind: 'private' } }]);
    expect(await put({ label: 'Pastry', instruction: 'A new text.' }, tk)).toMatchObject({ status: 200 });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM skills').first<{ n: number }>())!.n).toBe(1);
    expect((await get(tk)).body).toEqual({ skill: { label: 'Pastry', instruction: 'A new text.' } });
    expect(h.logs()).toContain('skill_saved');
    expect(h.logs().join('\n')).not.toMatch(/Baking|Pastry|sourdough|A new text/);
    // no thought, no job, no food, no energy, no transaction
    expect(h.net().ai.calls).toEqual([]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>()).toEqual({ n: 0 });
    const pet = h.net().contract.pets.get('5')!;
    expect(pet.project_food).toBe(food.project_food);
    expect(pet.given_food).toBe(food.given_food);
  });

  // spec: add-pet-work › Skill writing flow › skill saved
  it('saves for a sleeping pet too: writing a skill needs no awake pet and no pause', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: '0', given_food: '0' });
    const tk = await owner();
    await setPause(env.DB, 'ai', Date.now());
    expect(await put({ label: 'Baking', instruction: INSTRUCTION }, tk)).toMatchObject({ status: 200 });
    expect((await get(tk)).body.skill).toMatchObject({ label: 'Baking' });
  });

  // spec: add-pet-work › Skill writing flow › label not accepted
  it('refuses a label with an insult word or no visible character: 400 bad_label, nothing saved, the old skill stays', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    await save();
    const before = await row();
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');
    // the list is the one names are held to: whole words, case aside, a case boundary too
    for (const label of ['Idiot', 'big FUCK', 'BigShit', 'Good at idiot-ing']) {
      expect(await put({ label, instruction: 'Fine text' }, tk), label).toMatchObject({ status: 400, body: { code: 'bad_label' } });
    }
    // nothing visible: spaces, zero-width and bidi marks
    for (const label of [' ', '   ', '​​', '‮ ', '⁠']) {
      expect(await put({ label, instruction: 'Fine text' }, tk), JSON.stringify(label)).toMatchObject({ status: 400, body: { code: 'bad_label' } });
    }
    expect(encrypt).not.toHaveBeenCalled();
    const after = await row();
    expect(bytes(after!.ct)).toBe(bytes(before!.ct));
    expect(after!.label).toBe('Baking');
    expect(h.events()).toEqual([{ name: 'skill_saved', props: { kind: 'private' } }]);
    // a word that only contains a list word is fine, as in a name
    expect(await put({ label: 'Shiitake picking', instruction: 'Fine text' }, tk)).toMatchObject({ status: 200 });
  });

  // spec: add-pet-work › Skill writing flow › label not accepted
  it('stores the label cleaned the way a name is: edges trimmed, invisible signs cut', async () => {
    h.net().contract.addPet('5', OWNER);
    expect(await put({ label: '  Bak​ing  ', instruction: INSTRUCTION }, await owner())).toMatchObject({ status: 200, body: { skill: { label: 'Baking' } } });
    expect((await row())!.label).toBe('Baking');
  });

  // spec: add-pet-work › Skill writing flow › skill forgotten
  it('forgets for the owner only and serves the same empty answer again', async () => {
    h.net().contract.addPet('5', OWNER);
    await save();
    expect(await del(await other())).toMatchObject({ status: 403 });
    expect(await row()).not.toBeNull();
    expect(await del(await owner())).toMatchObject({ status: 200, body: { skill: null } });
    expect(await row()).toBeNull();
  });
});

describe('Skill rule', () => {
  // spec: add-pet-work › Skill rule › not in everyday chat
  it('keeps the instruction and the label out of the request of the owner\'s own reply', async () => {
    h.net().contract.addPet('5', OWNER);
    await save('Sourdough guru', INSTRUCTION);
    const out = await say(await owner(), '5', 'Hello, how was your day?');
    expect(out.thought.text).toBeTruthy();
    const [call] = h.net().ai.calls;
    const request = JSON.stringify(call!.body);
    expect(request).not.toContain(INSTRUCTION);
    expect(request).not.toContain('Sourdough guru');
    expect(request).not.toMatch(/sourdough|rhymes/i);
    expect(new TextDecoder().decode(call!.reqBytes)).not.toMatch(/sourdough|rhymes/i);
  });
});
