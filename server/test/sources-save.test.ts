// Connecting a data source to a skill (`Adapter connect flow` › «saved», «a fourth source», «no skill yet», «removed»,
// `Adapter sheet screen` › «a connected source», `Data source data`): free, the owner's only, the test call again at
// save, the address sealed on the server.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { openAddress } from '../src/sources/store';
import { api, harness } from './helpers/api';
import { connect, DAYBOOK, entryRows, FakeMcp, OTHER, OWNER, owner, PET, petWithSkill, skillOf, SOURCE_URL, sourceRows } from './helpers/sources';

const h = harness();

const edit = (tk: string, sid: string, body: unknown, id = PET) => api(`/api/pets/${id}/sources/${sid}`, { method: 'PUT', token: tk, body });
const remove = (tk: string, sid: string, id = PET) => api(`/api/pets/${id}/sources/${sid}`, { method: 'DELETE', token: tk });
const TICKS = ['events_on', 'today'];

/** An entry of the catalog, as publishing would have left it. */
async function entry(address = SOURCE_URL, id = 'e1e1e1e1e1e1e1e1e1e1e1e1') {
  await env.DB.prepare('INSERT INTO catalog_entries (id, token_id, source_id, name, address, tools, pet_name, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, '9', 'a'.repeat(24), 'Open-Meteo', address, JSON.stringify([]), 'Sage', Date.now())
    .run();
  return id;
}

describe('Adapter connect flow', () => {
  // spec: add-pet-errands › Adapter connect flow › saved
  // spec: add-pet-errands › Errand events data › data source added
  it('saves an own source after a second test call: sealed address, ticks, no food and no transaction, event adapter_added', async () => {
    const tk = await petWithSkill(h);
    const mcp = new FakeMcp(h.net().web);
    const out = await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS });
    expect(out.status).toBe(200);
    expect(out.body.source).toMatchObject({ label: 'Daybook', published: false, catalogGone: false, gift: false });
    expect(out.body.source.publicAddress).toBeUndefined();
    expect(out.body.source.tools.map((t: { name: string; ticked: boolean }) => [t.name, t.ticked])).toEqual([
      ['events_on', true],
      ['search', false],
      ['today', true],
    ]);
    // the test call ran at save
    expect(mcp.requests.map((r) => r.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);

    const [row] = await sourceRows();
    expect(row).toMatchObject({ token_id: PET, label: 'Daybook', added_by: OWNER, public_address: null, entry_id: null, published_entry: null });
    // sealed: the row holds no address text, and it opens with the token id and the row id only
    expect(JSON.stringify(row)).not.toContain('open-meteo');
    expect(await openAddress(env, row)).toBe(SOURCE_URL);
    await expect(openAddress(env, { ...row, token_id: '6' })).rejects.toThrow();
    expect(h.events().filter((e) => e.name === 'adapter_added')).toEqual([{ name: 'adapter_added', props: { from: 'own' } }]);
    // connecting is free: no model call, no spend, no food
    expect(h.net().ai.calls).toHaveLength(0);
    expect(await env.DB.prepare('SELECT 1 FROM pet_spend').first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM thoughts').first()).toBeNull();
  });

  // spec: add-pet-errands › Adapter connect flow › saved
  it('saves a copy of a catalog entry: its public address shows, the address is sealed as an own one', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    const id = await entry();
    const out = await connect(tk, { label: 'Weather', entry: id, ticks: ['today'] });
    expect(out.status).toBe(200);
    expect(out.body.source).toMatchObject({ label: 'Weather', publicAddress: SOURCE_URL, catalogGone: false, published: false, gift: false });
    const [row] = await sourceRows();
    expect(row).toMatchObject({ entry_id: id, public_address: SOURCE_URL });
    expect(await openAddress(env, row)).toBe(SOURCE_URL);
    expect(h.events().filter((e) => e.name === 'adapter_added')).toEqual([{ name: 'adapter_added', props: { from: 'catalog' } }]);
    // an entry that is not there
    expect(await connect(tk, { label: 'Gone', entry: 'f'.repeat(24), ticks: [] })).toMatchObject({ status: 404, body: { code: 'no_entry' } });
  });

  // spec: add-pet-errands › Adapter connect flow › saved
  it('saves only ticks of tools that can be ticked, and the name by the label rule', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    const ok = { address: SOURCE_URL, ticks: TICKS };
    // the free-text tool and a tool the server doesn't have
    expect((await connect(tk, { label: 'Daybook', ...ok, ticks: ['search'] })).status).toBe(400);
    expect((await connect(tk, { label: 'Daybook', ...ok, ticks: ['nothing'] })).status).toBe(400);
    expect((await connect(tk, { label: 'Daybook', ...ok, ticks: 'today' })).status).toBe(400);
    // «Let's pick different words.» is the sheet's line for bad_label
    expect(await connect(tk, { label: 'Daybook of an idiot', ...ok })).toMatchObject({ status: 400, body: { code: 'bad_label' } });
    expect(await connect(tk, { label: '   ', ...ok })).toMatchObject({ status: 400, body: { code: 'bad_label' } });
    expect((await connect(tk, { label: '', ...ok })).status).toBe(400);
    expect((await connect(tk, { label: 'x'.repeat(41), ...ok })).status).toBe(400);
    expect((await connect(tk, { label: 'x'.repeat(40), ...ok })).status).toBe(200);
    // an address and an entry together, or neither
    expect((await connect(tk, { label: 'Both', ...ok, entry: 'e'.repeat(24) })).status).toBe(400);
    expect((await connect(tk, { label: 'Neither', ticks: [] })).status).toBe(400);
    expect(await sourceRows()).toHaveLength(1);
  });

  // spec: add-pet-errands › Adapter connect flow › address didn't answer
  it('saves nothing when the second test call fails', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web, SOURCE_URL, { status: 401 });
    expect(await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS })).toMatchObject({ status: 422, body: { code: 'address_failed' } });
    expect(await connect(tk, { label: 'Daybook', address: `${SOURCE_URL}?key=1`, ticks: TICKS })).toMatchObject({ status: 422 });
    expect(await sourceRows()).toEqual([]);
    expect(h.events().filter((e) => e.name === 'adapter_added')).toEqual([]);
  });

  // spec: add-pet-errands › Adapter connect flow › a fourth source
  it('holds 3 sources: the fourth is refused before any call', async () => {
    const tk = await petWithSkill(h);
    const mcp = new FakeMcp(h.net().web);
    for (const label of ['One', 'Two', 'Three']) expect((await connect(tk, { label, address: SOURCE_URL, ticks: TICKS })).status).toBe(200);
    const calls = mcp.requests.length;
    expect(await connect(tk, { label: 'Four', address: SOURCE_URL, ticks: TICKS })).toMatchObject({ status: 409, body: { code: 'full' } });
    expect(mcp.requests).toHaveLength(calls);
    expect(await sourceRows()).toHaveLength(3);
    expect((await skillOf(tk)).body.sources).toHaveLength(3);
  });

  // spec: add-pet-errands › Adapter connect flow › a fourth source
  it('holds the bound at the insert when a second tab fills the last places while the address is tested', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web, SOURCE_URL, {
      during: async (method) => {
        if (method !== 'tools/list') return;
        for (const n of [1, 2, 3]) {
          await env.DB.prepare("INSERT INTO data_sources (id, token_id, label, addr_ct, addr_iv, tools, created_at, updated_at) VALUES (?, ?, ?, x'00', x'00', '[]', 1, 1)")
            .bind(String(n).repeat(24), PET, `Other ${n}`)
            .run();
        }
      },
    });
    expect(await connect(tk, { label: 'Late', address: SOURCE_URL, ticks: TICKS })).toMatchObject({ status: 409, body: { code: 'full' } });
    expect(await sourceRows()).toHaveLength(3);
  });

  // spec: add-pet-errands › Adapter connect flow › no skill yet
  it('refuses a source for a pet with no saved skill, without a call', async () => {
    h.net().contract.addPet(PET, OWNER, { name: 'Pixel' });
    const mcp = new FakeMcp(h.net().web);
    const tk = await owner();
    expect(await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS })).toMatchObject({ status: 409, body: { code: 'no_skill' } });
    expect(mcp.requests).toEqual([]);
    expect(await sourceRows()).toEqual([]);
  });

  // spec: add-pet-errands › Adapter connect flow › no skill yet × the skill forgotten in another tab
  it('stores nothing when the skill is forgotten in another tab while the address is tested', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web, SOURCE_URL, {
      during: async (method) => {
        if (method === 'tools/list') await api(`/api/pets/${PET}/skill`, { method: 'DELETE', token: tk });
      },
    });
    expect(await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS })).toMatchObject({ status: 409, body: { code: 'no_skill' } });
    expect(await sourceRows()).toEqual([]);
    expect(h.events().filter((e) => e.name === 'adapter_added')).toEqual([]);
  });

  // spec: add-pet-errands › Data source data › not the owner
  it('does not connect a source when the pet is gifted during the address test', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web, SOURCE_URL, {
      during: async (method) => { if (method === 'tools/list') h.net().contract.pets.get(PET)!.owner_id = OTHER; },
    });
    expect(await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS })).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await sourceRows()).toEqual([]);
    expect(h.events().filter((e) => e.name === 'adapter_added')).toEqual([]);
  });

  // spec: add-pet-errands › Data source data › not the owner
  it('does not edit a source when the pet is gifted during its address test', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    const sid = (await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS })).body.source.id as string;
    h.net().web.handlers.clear();
    new FakeMcp(h.net().web, SOURCE_URL, {
      during: async (method) => { if (method === 'tools/list') h.net().contract.pets.get(PET)!.owner_id = OTHER; },
    });
    expect(await edit(tk, sid, { label: 'Changed', ticks: ['today'] })).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect((await sourceRows())[0]).toMatchObject({ label: 'Daybook' });
  });

  // spec: add-pet-errands › Adapter connect flow › removed
  it('removes a source at once, with its own entry in the catalog; the pet stops using it', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    const sid = (await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS })).body.source.id as string;
    // published, with a copy of the entry in another pet's skill
    await env.DB.prepare('INSERT INTO catalog_entries (id, token_id, source_id, name, address, tools, pet_name, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('c'.repeat(24), PET, sid, 'Daybook', SOURCE_URL, '[]', 'Pixel', Date.now())
      .run();
    await env.DB.prepare('UPDATE data_sources SET published_entry = ? WHERE id = ?').bind('c'.repeat(24), sid).run();

    expect(await remove(tk, sid)).toMatchObject({ status: 200, body: { removed: true } });
    expect(await sourceRows()).toEqual([]);
    expect(await entryRows()).toEqual([]);
    expect((await skillOf(tk)).body.sources).toEqual([]);
    // a second tab's remove is not found, and a malformed id is a bad request
    expect(await remove(tk, sid)).toMatchObject({ status: 404, body: { code: 'no_source' } });
    expect((await remove(tk, 'not-an-id')).status).toBe(400);
  });
});

describe('Adapter sheet screen', () => {
  // spec: add-pet-errands › Adapter sheet screen › a connected source
  it('gives a connected source by its name and tools, never its address, and edits its name and ticks', async () => {
    const tk = await petWithSkill(h);
    const mcp = new FakeMcp(h.net().web);
    const sid = (await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS })).body.source.id as string;

    const skill = await skillOf(tk);
    expect(skill.status).toBe(200);
    expect(skill.body.skill).toMatchObject({ label: 'Baking' });
    expect(skill.body.code).toBeNull();
    expect(skill.body.sources).toHaveLength(1);
    expect(skill.body.sources[0]).toMatchObject({ id: sid, label: 'Daybook', published: false, catalogGone: false });
    expect(skill.body.sources[0].tools[0]).toMatchObject({ name: 'events_on', description: 'Notable events on a day of the year.', ticked: true });
    expect(JSON.stringify(skill.body.sources)).not.toContain('open-meteo');

    // Save adapter again: the name and the ticks, the stored address tested once more
    const before = mcp.requests.length;
    const saved = await edit(tk, sid, { label: 'Daybook 2', ticks: ['today'] });
    expect(saved.status).toBe(200);
    expect(saved.body.source.label).toBe('Daybook 2');
    expect(saved.body.source.tools.filter((t: { ticked: boolean }) => t.ticked).map((t: { name: string }) => t.name)).toEqual(['today']);
    expect(mcp.requests.length - before).toBe(3);
    expect(JSON.stringify(saved.body)).not.toContain('open-meteo');
    expect((await sourceRows())[0]).toMatchObject({ label: 'Daybook 2' });
    // an edit that the source no longer answers keeps the row as it was
    h.net().web.handlers.clear();
    new FakeMcp(h.net().web, SOURCE_URL, { status: 500 });
    expect(await edit(tk, sid, { label: 'Changed', ticks: [] })).toMatchObject({ status: 422, body: { code: 'address_failed' } });
    expect((await sourceRows())[0]).toMatchObject({ label: 'Daybook 2' });
    // a tool the source dropped can't stay ticked
    h.net().web.handlers.clear();
    new FakeMcp(h.net().web, SOURCE_URL, { tools: [DAYBOOK[2]!] });
    expect((await edit(tk, sid, { label: 'Daybook 2', ticks: ['events_on'] })).status).toBe(400);
    expect((await edit(tk, sid, { label: 'Daybook 2', ticks: ['today'] })).body.source.tools.map((t: { name: string }) => t.name)).toEqual(['today']);
    expect(await edit(tk, 'f'.repeat(24), { label: 'x', ticks: [] })).toMatchObject({ status: 404, body: { code: 'no_source' } });
  });

  // spec: add-pet-errands › Adapter sheet screen › a connected source
  it('says a copy left the catalog when its entry is gone, and draws the source of a gift as a gift', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    const id = await entry();
    const copy = (await connect(tk, { label: 'Weather', entry: id, ticks: ['today'] })).body.source.id as string;
    expect((await skillOf(tk)).body.sources[0]).toMatchObject({ id: copy, catalogGone: false });
    await env.DB.prepare('DELETE FROM catalog_entries WHERE id = ?').bind(id).run();
    expect((await skillOf(tk)).body.sources[0]).toMatchObject({ id: copy, catalogGone: true, publicAddress: SOURCE_URL });

    // an own source the giver added: the new owner sees it as a gift
    const own = (await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS })).body.source.id as string;
    await env.DB.prepare('UPDATE data_sources SET added_by = ? WHERE id = ?').bind(OTHER, own).run();
    const view = (await skillOf(tk)).body.sources.find((s: { id: string }) => s.id === own);
    expect(view).toMatchObject({ gift: true, published: false });
  });
});
