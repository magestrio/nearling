// Who may touch a skill's data sources, and where the address goes (`Data source data` › «not the owner», «the address
// after save»). Every route here is the current owner's, read from the contract with no cache.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { connect, FakeMcp, OTHER, OWNER, other, owner, PET, petWithSkill, skillOf, SOURCE_URL, sourceRows } from './helpers/sources';

const h = harness();
const TICKS = ['events_on', 'today'];

/** Every route that reads or changes a source, a catalog entry or the code, as a forged request would send it. */
function routes(sid: string): { method: string; path: string; body?: unknown }[] {
  return [
    { method: 'GET', path: `/api/pets/${PET}/skill` },
    { method: 'POST', path: `/api/pets/${PET}/sources/check`, body: { address: SOURCE_URL } },
    { method: 'POST', path: `/api/pets/${PET}/sources`, body: { label: 'Mine', address: SOURCE_URL, ticks: TICKS } },
    { method: 'PUT', path: `/api/pets/${PET}/sources/${sid}`, body: { label: 'Mine', ticks: TICKS } },
    { method: 'DELETE', path: `/api/pets/${PET}/sources/${sid}` },
    { method: 'POST', path: `/api/pets/${PET}/sources/${sid}/publish` },
    { method: 'DELETE', path: `/api/pets/${PET}/sources/${sid}/publish` },
  ];
}

describe('Data source data', () => {
  // spec: add-pet-errands › Data source data › not the owner
  it('turns a viewer, a hirer, a giver after a transfer and a forged request away: nothing runs, changes or is called', async () => {
    const tk = await petWithSkill(h);
    const mcp = new FakeMcp(h.net().web);
    const sid = (await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS })).body.source.id as string;
    const calls = mcp.requests.length;
    const before = JSON.stringify(await sourceRows());

    // a viewer or a hirer is an account that is not the owner; a stranger with no session is signed out
    for (const route of routes(sid)) {
      const stranger = await api(route.path, { method: route.method, token: await other(), body: route.body });
      expect(stranger, `${route.method} ${route.path}`).toMatchObject({ status: 403, body: { code: 'not_owner' } });
      expect((await api(route.path, { method: route.method, body: route.body })).status, `${route.method} ${route.path}`).toBe(401);
    }
    // the giver's open tab after a transfer: the contract says the pet is the other's now
    h.net().contract.pets.get(PET)!.owner_id = OTHER;
    for (const route of routes(sid)) {
      const giver = await api(route.path, { method: route.method, token: await owner(), body: route.body });
      expect(giver, `${route.method} ${route.path}`).toMatchObject({ status: 403, body: { code: 'not_owner' } });
      expect(JSON.stringify(giver.body)).not.toContain('events_on');
    }
    // nothing ran, nothing was called, nothing changed
    expect(mcp.requests).toHaveLength(calls);
    expect(JSON.stringify(await sourceRows())).toBe(before);
    expect(h.events().filter((e) => e.name === 'adapter_published')).toEqual([]);
  });

  // spec: add-pet-errands › Data source data › not the owner
  it('does not find a source of another pet under this pet', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    const sid = (await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS })).body.source.id as string;
    h.net().contract.addPet('6', OWNER, { name: 'Biscuit' });
    for (const route of routes(sid).filter((r) => r.path.includes(sid))) {
      const res = await api(route.path.replace(`/pets/${PET}/`, '/pets/6/'), { method: route.method, token: tk, body: route.body });
      expect(res, `${route.method} ${route.path}`).toMatchObject({ status: 404, body: { code: 'no_source' } });
    }
    expect(await sourceRows()).toHaveLength(1);
  });

  // spec: add-pet-errands › Data source data › the address after save
  it('never gives an own address back: not in a response, a log line or an event', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    const saved = await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: TICKS });
    const sid = saved.body.source.id as string;
    const bodies = [saved.body, (await skillOf(tk)).body];
    bodies.push((await api(`/api/pets/${PET}/sources/${sid}`, { method: 'PUT', token: tk, body: { label: 'Daybook', ticks: TICKS } })).body);
    bodies.push((await api(`/api/pets/${PET}/sources/${sid}/publish`, { method: 'POST', token: tk })).body);
    bodies.push((await api('/api/adapters')).body);
    expect(bodies[0].source.publicAddress).toBeUndefined();
    expect(JSON.stringify(bodies.slice(0, 4))).not.toContain('open-meteo');
    // the pet's own page reads: the state, the conversation and the pet itself hold no address either
    for (const path of [`/api/pets/${PET}`, `/api/pets/${PET}/state`, `/api/pets/${PET}/conversation`]) {
      expect(JSON.stringify((await api(path, { token: tk })).body), path).not.toContain('open-meteo');
    }
    expect(h.logs().join('\n')).not.toContain('open-meteo');
    expect(JSON.stringify(h.events())).not.toContain('open-meteo');
    // the column holds the ciphertext only
    expect(JSON.stringify(await env.DB.prepare('SELECT addr_ct, addr_iv, public_address FROM data_sources').first())).not.toContain('open-meteo');
  });

  // spec: add-pet-errands › Data source data › the address after save
  it('shows a copy from the catalog by the entry\'s public address', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    await env.DB.prepare('INSERT INTO catalog_entries (id, token_id, source_id, name, address, tools, pet_name, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('d'.repeat(24), '9', 'a'.repeat(24), 'Open-Meteo', SOURCE_URL, '[]', 'Sage', Date.now())
      .run();
    await connect(tk, { label: 'Weather', entry: 'd'.repeat(24), ticks: ['today'] });
    expect((await skillOf(tk)).body.sources[0].publicAddress).toBe(SOURCE_URL);
  });
});
