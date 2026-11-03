import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sendErrand as queueErrand } from '../src/errands/store';
import { api, harness, settle } from './helpers/api';
import { addPet, callsOf, errand, errandRow, OWNER, owner, PET, richPet, sendErrand, stateOf, thoughtsOf } from './helpers/errands';

const h = harness();
const clear = (tk: string) => api(`/api/pets/${PET}/memory/clear`, { token: tk, method: 'POST' });

describe('Errand flow', () => {
  // spec: add-pet-errands › Errand flow › failed errand after a reload × Clear memory
  it('erases a failed errand with the memory: form, job and reason gone', async () => {
    addPet(h);
    const tk = await owner();
    h.net().web.page('https://members.example.com/area', { status: 404 });
    await errand(tk, 'read', 'https://members.example.com/area');
    expect(await errandRow()).toMatchObject({ state: 'failed' });
    expect((await clear(tk)).status).toBe(200);
    expect(await errandRow()).toBeNull();
    expect((await stateOf(tk)).errand).toBeNull();
  });

  // spec: add-pet-errands › Errand flow › memory cleared on the way
  it('ends an errand whose job had not started: nothing was spent and no row is left', async () => {
    addPet(h);
    const tk = await owner();
    // a queued job nobody has run: the desk is not asked
    const queued = await queueErrand(env.DB, { tokenId: PET, owner: OWNER, form: 'read', job: 'A text about to be forgotten.', now: Date.now() });
    expect(queued).not.toBeNull();
    expect((await clear(tk)).status).toBe(200);
    expect(await errandRow()).toBeNull();
    expect((await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(queued!.job).first<{ status: string }>())?.status).toBe('failed');
    expect(h.net().ai.calls).toHaveLength(0);
  });

  // spec: add-pet-errands › Errand flow › memory cleared on the way
  // spec: add-pet-errands › Errand flow › memory cleared on the way × Clear memory in another tab
  it('stores no report when the memory was cleared while it was away, and the pet pays for the work', async () => {
    addPet(h);
    const tk = await owner();
    h.net().ai.push({
      content: 'The report that nobody may keep.',
      tokensIn: 900,
      tokensOut: 80,
      during: async () => {
        expect((await clear(tk)).status).toBe(200);
      },
    });
    const sent = await sendErrand(tk, 'read', 'A text read while the memory is cleared.');
    const out = await settle(tk, PET, sent.body.job);
    expect(out.code).toBe('memory_cleared');
    // the line «The errand still used {price} of food» has its price
    expect(out.price.cents).toBeGreaterThan(0);

    const [thought] = await thoughtsOf();
    // the receipt stays, debited as usual; the words, the job and the bytes are gone
    expect(thought).toMatchObject({ kind: 'errand', reply_text: null, player_text: null, status: 'unbilled' });
    expect(thought.erased_at).not.toBeNull();
    expect(BigInt(thought.price_yocto)).toBeGreaterThan(0n);
    const [call] = await callsOf(thought.id);
    expect(Array.from(call.req_bytes as ArrayLike<number>)).toEqual([]);
    expect(Array.from(call.res_bytes as ArrayLike<number>)).toEqual([]);
    expect(call.req_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await errandRow()).toMatchObject({ state: 'done', job: null });
    expect((await stateOf(tk)).errand).toEqual({ state: 'done', cleared: true, priceCents: out.price.cents });
    expect((await stateOf(tk)).errand).toBeNull();
    expect(h.events().some((e) => e.name === 'errand_reported')).toBe(true);
    expect(await env.DB.prepare('SELECT 1 FROM pet_spend').first()).toBeNull();
  });
});

describe('Errand flow › a search errand and the memory', () => {
  // spec: add-pet-errands › Errand flow › memory cleared on the way
  it('stores no report of a search errand cleared on the way: the words and the bytes of both calls go, the receipt stays', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 2 }, tokensIn: 13_000, tokensOut: 60 }, {
      content: 'A report that nobody may keep [1].',
      tokensIn: 900,
      tokensOut: 80,
      during: async () => {
        expect((await clear(tk)).status).toBe(200);
      },
    });
    const sent = await sendErrand(tk, 'find', 'When is the Leonids meteor shower?');
    const out = await settle(tk, PET, sent.body.job);
    expect(out.code).toBe('memory_cleared');
    expect(out.price.cents).toBeGreaterThan(0);
    const [thought] = (await thoughtsOf()).filter((t) => t.kind === 'errand');
    expect(thought).toMatchObject({ reply_text: null, player_text: null, status: 'unbilled', searches: 2 });
    expect(thought.erased_at).not.toBeNull();
    expect(BigInt(thought.price_yocto)).toBeGreaterThan(0n);
    const calls = await callsOf(thought.id);
    expect(calls.map((c: any) => c.label)).toEqual(['search', 'report']);
    for (const call of calls) {
      expect(Array.from(call.req_bytes as ArrayLike<number>)).toEqual([]);
      expect(Array.from(call.res_bytes as ArrayLike<number>)).toEqual([]);
      expect(call.req_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(await errandRow()).toMatchObject({ state: 'done', job: null });
    expect((await stateOf(tk)).errand).toEqual({ state: 'done', cleared: true, priceCents: out.price.cents });
    expect((await stateOf(tk)).errand).toBeNull();
  });
});

describe('Data source data', () => {
  const seed = async (token: string, n: number) => {
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO data_sources (id, token_id, added_by, label, addr_ct, addr_iv, public_address, entry_id, tools, published_entry, created_at, updated_at) VALUES (?1, ?2, 'a', 'Daybook', x'00', x'00', NULL, ?3, '[]', ?4, 1, 1)")
        .bind(`s${token}${n}`, token, n === 9 ? 'catalog-1' : null, n === 1 ? 'catalog-1' : null),
      env.DB.prepare("INSERT INTO skill_code (token_id, ct, iv, hash, functions, updated_at) VALUES (?, x'00', x'00', 'h', '{}', 1)").bind(token),
      env.DB.prepare('INSERT INTO code_tests (token_id, day, runs, passed_hash) VALUES (?, 1, 3, NULL)').bind(token),
    ]);
  };
  const count = async (table: string, token: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE token_id = ?`).bind(token).first<{ n: number }>())!.n;

  // spec: add-pet-errands › Data source data › memory cleared
  it('takes a pet\'s data sources, code and catalog entries with the memory, and keeps the day\'s test count', async () => {
    addPet(h);
    h.net().contract.addPet('6', OWNER);
    const tk = await owner();
    await seed(PET, 1);
    await seed('6', 9);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO catalog_entries (id, token_id, source_id, name, address, tools, pet_name, published_at) VALUES ('catalog-1', ?, 's51', 'Daybook', 'https://d.example.com/mcp', '[]', 'Pixel', 1)").bind(PET),
      env.DB.prepare("INSERT INTO code_versions (day, version) VALUES (1, '5:abc')"),
    ]);
    expect((await clear(tk)).status).toBe(200);
    for (const table of ['data_sources', 'skill_code', 'catalog_entries']) expect(await count(table, PET), table).toBe(0);
    expect(await count('code_tests', PET)).toBe(1);
    // another pet's copy of the published source stays (it holds its own sealed address), as do its code and the game's count
    expect(await count('data_sources', '6')).toBe(1);
    expect(await count('skill_code', '6')).toBe(1);
    expect(await count('code_tests', '6')).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM code_versions').first<{ n: number }>())!.n).toBe(1);
  });
});
