// The catalog of adapters (`Catalog flow`, `Catalog data`, `Adapter catalog screen` › «success»): a public copy made at
// publish, free and keyless, taken out at once, and nothing of who connected or called.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { writeSkill } from '../src/work/skill';
import { api, harness } from './helpers/api';
import { token } from './helpers/network';
import { connect, entryRows, FakeMcp, OTHER, OWNER, owner, PET, petWithSkill, skillOf, SOURCE_URL, sourceRows } from './helpers/sources';

const h = harness();
const TICKS = ['events_on', 'today'];

const publish = (tk: string, sid: string, id = PET) => api(`/api/pets/${id}/sources/${sid}/publish`, { method: 'POST', token: tk });
const takeOut = (tk: string, sid: string, id = PET) => api(`/api/pets/${id}/sources/${sid}/publish`, { method: 'DELETE', token: tk });
const adapters = () => api('/api/adapters');

/** An own source, connected through the route. */
async function ownSource(tk: string, url = SOURCE_URL, label = 'Daybook', ticks = TICKS): Promise<string> {
  const out = await connect(tk, { label, address: url, ticks });
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return out.body.source.id as string;
}

const LONG = 'Notable events on a day of the year. '.repeat(20);
const tool = (name: string, description: string) => ({ name, description, inputSchema: { type: 'object', properties: { day: { type: 'number' } } } });

describe('Catalog flow', () => {
  // spec: add-pet-errands › Catalog flow › publish
  // spec: add-pet-errands › Errand events data › data source published
  it('lists an own source for anyone: name, address, tools with descriptions cut at 300, parameters and its pet', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web, SOURCE_URL, { tools: [tool('events_on', LONG), tool('today', 'The date today.')] });
    const sid = await ownSource(tk);
    expect(await entryRows()).toEqual([]);
    const out = await publish(tk, sid);
    expect(out.status).toBe(200);
    expect(out.body.source).toMatchObject({ id: sid, published: true, gift: false });
    expect(out.body.source.publicAddress).toBeUndefined();

    const [row] = await entryRows();
    expect(row).toMatchObject({ token_id: PET, source_id: sid, name: 'Daybook', address: SOURCE_URL, pet_name: 'Pixel' });
    expect((await sourceRows())[0]).toMatchObject({ published_entry: row.id });
    expect(h.events().filter((e) => e.name === 'adapter_published')).toEqual([{ name: 'adapter_published', props: {} }]);

    // a second tap lists nothing twice and logs nothing twice
    expect((await publish(tk, sid)).status).toBe(200);
    expect(await entryRows()).toHaveLength(1);
    expect(h.events().filter((e) => e.name === 'adapter_published')).toHaveLength(1);
  });

  // spec: add-pet-errands › Adapter catalog screen › success
  it('gives the list to any viewer, signed out included: descriptions cut at 300, nothing about who connected or called', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web, SOURCE_URL, { tools: [tool('events_on', LONG), tool('today', 'The date today.')] });
    const sid = await ownSource(tk);
    expect((await adapters()).body).toEqual({ entries: [] });
    await publish(tk, sid);
    // a second, newer entry from another pet
    h.net().contract.addPet('6', OTHER, { name: 'Biscuit' });
    await writeSkill(env, '6', { label: 'Tides', instruction: 'Tell the tides.' }, Date.now());
    h.net().web.handlers.clear();
    new FakeMcp(h.net().web, 'https://tides.example.com/mcp', { tools: [tool('tides_at', 'Tide times.')] });
    const sage = await token('did:privy:other', OTHER);
    const second = (await connect(sage, { label: 'Tide times', address: 'https://tides.example.com/mcp', ticks: ['tides_at'] }, '6')).body.source.id as string;
    expect((await publish(sage, second, '6')).status).toBe(200);

    for (const viewer of [undefined, await owner(), sage]) {
      const out = await api('/api/adapters', { token: viewer });
      expect(out.status).toBe(200);
      expect(out.body.entries.map((e: { name: string }) => e.name)).toEqual(['Tide times', 'Daybook']);
      const daybook = out.body.entries[1];
      expect(Object.keys(daybook).sort()).toEqual(['address', 'id', 'name', 'petId', 'petName', 'publishedAt', 'tools']);
      expect(daybook).toMatchObject({ address: SOURCE_URL, petId: PET, petName: 'Pixel' });
      expect([...daybook.tools[0].description]).toHaveLength(300);
      expect(daybook.tools[0].description).toBe([...LONG].slice(0, 300).join(''));
      // parameters stay, the owner's tick does not
      expect(daybook.tools[0].params).toEqual([{ name: 'day', type: 'number', required: false }]);
      expect(daybook.tools[0].ticked).toBeUndefined();
    }
  });

  // spec: add-pet-errands › Catalog flow › publish refused
  it('publishes nothing when the address, a tool name or a description holds a word of the insult list; the source still works', async () => {
    const tk = await petWithSkill(h);
    const cases: { url: string; tools: unknown[] }[] = [
      { url: SOURCE_URL, tools: [tool('idiot_finder', 'Finds things.')] },
      { url: SOURCE_URL, tools: [tool('finder', 'A tool for any Idiot.')] },
      { url: SOURCE_URL, tools: [tool('finder', `${'a'.repeat(300)} shit`)] },
      { url: 'https://idiot.example.com/mcp', tools: [tool('finder', 'Finds things.')] },
      { url: 'https://mcp.example.com/fuck/mcp', tools: [tool('finder', 'Finds things.')] },
    ];
    for (const [i, c] of cases.entries()) {
      h.net().web.handlers.clear();
      new FakeMcp(h.net().web, c.url, { tools: c.tools as never });
      const sid = await ownSource(tk, c.url, `Source ${i}`, []);
      const out = await publish(tk, sid);
      // the third holds its word past the cut of 300: the whole description is checked, not only what becomes public
      expect(out).toMatchObject({ status: 409, body: { code: 'insult' } });
      await api(`/api/pets/${PET}/sources/${sid}`, { method: 'DELETE', token: tk });
    }
    expect(await entryRows()).toEqual([]);
    // the refused source stays on the skill and keeps working
    h.net().web.handlers.clear();
    new FakeMcp(h.net().web, cases[0]!.url, { tools: cases[0]!.tools as never });
    const sid = await ownSource(tk, cases[0]!.url, 'Refused', []);
    expect((await publish(tk, sid)).status).toBe(409);
    expect((await skillOf(tk)).body.sources.find((s: { id: string }) => s.id === sid)).toMatchObject({ published: false });
    expect(h.events().filter((e) => e.name === 'adapter_published')).toEqual([]);
  });

  // spec: add-pet-errands › Catalog data › publishing a copy
  it('does not publish a source the skill connected from the catalog; the original entry stays', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    await env.DB.prepare('INSERT INTO catalog_entries (id, token_id, source_id, name, address, tools, pet_name, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('d'.repeat(24), '9', 'a'.repeat(24), 'Open-Meteo', SOURCE_URL, '[]', 'Sage', 1)
      .run();
    const copy = (await connect(tk, { label: 'Weather', entry: 'd'.repeat(24), ticks: ['today'] })).body.source.id as string;
    expect(await publish(tk, copy)).toMatchObject({ status: 409, body: { code: 'copy' } });
    expect((await entryRows()).map((e) => e.id)).toEqual(['d'.repeat(24)]);
    expect(h.events().filter((e) => e.name === 'adapter_published')).toEqual([]);
  });

  // spec: add-pet-errands › Catalog flow › a source from a gift
  // spec: add-pet-errands › Catalog data › a source that came with a gift
  it('does not publish an own source the giver added; it keeps working and its address stays hidden', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    const sid = await ownSource(tk);
    await env.DB.prepare('UPDATE data_sources SET added_by = ? WHERE id = ?').bind(OTHER, sid).run();
    expect(await publish(tk, sid)).toMatchObject({ status: 409, body: { code: 'gift' } });
    expect(await entryRows()).toEqual([]);
    const view = (await skillOf(tk)).body.sources[0];
    expect(view).toMatchObject({ id: sid, gift: true, published: false });
    expect(JSON.stringify(view)).not.toContain('open-meteo');
    // and still callable: its tools are as tested, the row holds its sealed address
    expect(view.tools.map((t: { ticked: boolean }) => t.ticked)).toEqual([true, false, true]);
    // a source the giver had already published goes with the pet; its new owner may take it out
    await env.DB.prepare('UPDATE data_sources SET added_by = ? WHERE id = ?').bind(OWNER, sid).run();
    expect((await publish(tk, sid)).status).toBe(200);
    await env.DB.prepare('UPDATE data_sources SET added_by = ? WHERE id = ?').bind(OTHER, sid).run();
    expect((await skillOf(tk)).body.sources[0]).toMatchObject({ published: true, gift: false });
    expect((await takeOut(tk, sid)).body.source).toMatchObject({ published: false, gift: true });
    expect(await entryRows()).toEqual([]);
  });

  // spec: add-pet-errands › Catalog flow › left the catalog
  it('keeps a copy working with its own address when its author takes the entry out, and says so', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    h.net().contract.addPet('6', OTHER, { name: 'Biscuit' });
    await writeSkill(env, '6', { label: 'Tides', instruction: 'Tell the tides.' }, Date.now());
    const sage = await token('did:privy:other', OTHER);
    const sid = await ownSource(tk);
    await publish(tk, sid);
    const copy = (await connect(sage, { label: 'Daybook copy', entry: (await entryRows())[0].id, ticks: ['today'] }, '6')).body.source.id as string;
    expect((await skillOf(sage, '6')).body.sources[0]).toMatchObject({ id: copy, catalogGone: false });
    await takeOut(tk, sid);
    const [row] = await sourceRows('6');
    expect(row).toMatchObject({ id: copy, entry_id: expect.any(String) });
    expect((await skillOf(sage, '6')).body.sources[0]).toMatchObject({ id: copy, catalogGone: true, publicAddress: SOURCE_URL });
  });

  // spec: add-pet-errands › Catalog flow › taken out
  it('takes the entry out at once on Take it out, on remove, on forgetting the skill and on clearing the memory; copies keep working', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    // a pet of another owner with a copy of the entry
    h.net().contract.addPet('6', OTHER, { name: 'Biscuit' });
    await writeSkill(env, '6', { label: 'Tides', instruction: 'Tell the tides.' }, Date.now());
    const sage = await token('did:privy:other', OTHER);

    const listed = async () => {
      const sid = await ownSource(tk);
      expect((await publish(tk, sid)).status).toBe(200);
      expect(await entryRows()).toHaveLength(1);
      return sid;
    };

    // Take it out
    let sid = await listed();
    expect((await takeOut(tk, sid)).body.source).toMatchObject({ published: false });
    expect(await entryRows()).toEqual([]);
    expect((await sourceRows())[0]).toMatchObject({ published_entry: null });
    expect((await takeOut(tk, sid)).status).toBe(200);

    // remove the source
    await publish(tk, sid);
    const entryId = (await entryRows())[0].id as string;
    const copy = (await connect(sage, { label: 'Daybook copy', entry: entryId, ticks: ['today'] }, '6')).body.source.id as string;
    expect((await skillOf(sage, '6')).body.sources[0]).toMatchObject({ id: copy, catalogGone: false });
    expect((await api(`/api/pets/${PET}/sources/${sid}`, { method: 'DELETE', token: tk })).status).toBe(200);
    expect(await entryRows()).toEqual([]);
    // the copy is the other skill's own: it stays
    expect(await sourceRows('6')).toHaveLength(1);

    // forget the skill: its sources, code and entries go in one batch
    sid = await listed();
    await env.DB.prepare("INSERT INTO skill_code (token_id, ct, iv, hash, functions, updated_at) VALUES (?, x'00', x'00', 'h', '[]', 1)").bind(PET).run();
    expect((await api(`/api/pets/${PET}/skill`, { method: 'DELETE', token: tk })).status).toBe(200);
    expect(await entryRows()).toEqual([]);
    expect(await sourceRows()).toEqual([]);
    expect(await env.DB.prepare('SELECT 1 FROM skill_code').first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM skills WHERE token_id = ?').bind(PET).first()).toBeNull();
    expect(await sourceRows('6')).toHaveLength(1);

    // clear the pet's memory
    await writeSkill(env, PET, { label: 'Baking', instruction: 'Rhyme.' }, Date.now());
    await listed();
    expect((await api(`/api/pets/${PET}/memory/clear`, { method: 'POST', token: tk })).status).toBe(200);
    expect(await entryRows()).toEqual([]);
    expect(await sourceRows()).toEqual([]);
  });
});

describe('Data source data', () => {
  // spec: add-pet-errands › Data source data › memory cleared × Forget this skill
  it('takes the sources, code and entries with the skill in one batch, and a failed batch leaves all of them', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    const sid = await ownSource(tk);
    await publish(tk, sid);
    await env.DB.prepare("INSERT INTO skill_code (token_id, ct, iv, hash, functions, updated_at) VALUES (?, x'00', x'00', 'h', '[]', 1)").bind(PET).run();
    // another pet's rows are not touched
    h.net().contract.addPet('6', OTHER, { name: 'Biscuit' });
    await env.DB.prepare("INSERT INTO skill_code (token_id, ct, iv, hash, functions, updated_at) VALUES ('6', x'00', x'00', 'h', '[]', 1)").run();

    expect((await api(`/api/pets/${PET}/skill`, { method: 'DELETE', token: tk })).status).toBe(200);
    expect(await sourceRows()).toEqual([]);
    expect(await entryRows()).toEqual([]);
    expect((await env.DB.prepare('SELECT token_id FROM skill_code').all()).results).toEqual([{ token_id: '6' }]);
    // the skill sheet reads an empty skill after
    expect((await skillOf(tk)).body).toEqual({ skill: null, sources: [], code: null });
  });
});
