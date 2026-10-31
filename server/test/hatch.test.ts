import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { assembleCharacter, longestAssemblyBytes, SLOTS } from '../src/character/presets';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const PLAYER = NEAR_ACCOUNT(10);

const asPlayer = async (sub = 'did:privy:player', account = PLAYER) => token(sub, account);
const hatch = async (name: unknown, tk?: string) => api('/api/hatch', { token: tk ?? (await asPlayer()), body: { name } });
const mintCalls = () => h.net().contract.sends.filter((s) => s.method === 'pet_mint');
const rpcFetched = () => h.net().fetched.filter((u) => u === env.NEAR_RPC_URL).length;

/** Everything in the game's D1 as one string, to look for words that must not be there. */
async function everythingInD1(): Promise<string> {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>();
  let out = '';
  for (const { name } of tables.results) out += JSON.stringify((await env.DB.prepare(`SELECT * FROM ${name}`).all()).results);
  return out;
}

describe('Birth flow', () => {
  // spec: add-pet › Birth flow › имя не принято
  it('refuses a name with a list word, or with nothing visible, and sends nothing to the network', async () => {
    for (const name of ['Idiot', 'IDIOT pie', 'Big_Idiot', 'BigIdiot', 'x-idiot', 'Idiot2', 'SHITface', '   ', '​‍', ' ​ ']) {
      const res = await hatch(name);
      expect(res.status, name).toBe(422);
      expect(res.body, name).toEqual({ code: 'name_rejected' });
    }
    expect(h.net().contract.reads).toEqual([]);
    expect(h.net().contract.sends).toEqual([]);
    expect(rpcFetched()).toBe(0);
    // D1 and the logs never see the name; the log says only the code.
    expect(await everythingInD1()).not.toMatch(/idiot|shit/i);
    expect(h.logs().join('\n')).not.toMatch(/idiot|shit/i);
    expect(new Set(h.logs())).toEqual(new Set(['name_rejected']));
    expect(h.events()).toEqual([]);
  });

  // spec: add-pet › Birth flow › имя не принято
  it('accepts a list word inside another word', async () => {
    const res = await hatch('Idiotic');
    expect(res.status).toBe(200);
    expect(mintCalls()).toHaveLength(1);
  });

  // spec: add-pet › Birth flow › имя не принято
  it('answers 400 to a raw name over 32 bytes or not a string, before anything else', async () => {
    expect((await hatch('a'.repeat(33))).status).toBe(400);
    expect((await hatch('👩‍🚀'.repeat(3))).status).toBe(400); // 33 bytes
    expect((await hatch(42)).status).toBe(400);
    expect((await api('/api/hatch', { token: await asPlayer(), body: {} })).status).toBe(400);
    expect((await hatch('a'.repeat(32))).status).toBe(200);
    expect(h.net().contract.reads.map((r) => r.method)).toEqual(['hatch_view']); // only the last request read the network
  });

  // spec: add-pet › Birth flow › вылупился
  it('mints to the player with the cleaned name and a character made of the presets, and records the birth', async () => {
    const res = await hatch(' Pixel ');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tokenId: '0' });
    const [call] = mintCalls();
    expect(call!.args.receiver).toBe(PLAYER);
    expect(call!.args.name).toBe('Pixel');
    const character = String(call!.args.character);
    expect(new TextEncoder().encode(character).length).toBeLessThanOrEqual(Number(env.MAX_CHARACTER_BYTES));
    // one fragment of each slot, in order, joined with one space
    let rest = character;
    for (const slot of SLOTS) {
      const fragment = slot.find((f) => rest.startsWith(f));
      expect(fragment, rest.slice(0, 40)).toBeDefined();
      rest = rest.slice(fragment!.length);
      if (slot !== SLOTS[SLOTS.length - 1]) {
        expect(rest.startsWith(' ')).toBe(true);
        rest = rest.slice(1);
      }
    }
    expect(rest).toBe('');
    // the transaction: the server's account, no deposit, the gas of design.md
    expect(call!.deposit).toBe('0');
    // what contract/tests/pet_mint.rs births a playtest's pets with
    expect(call!.gas).toBe('15000000000000');
    expect(call!.signer).toBe(env.SERVER_ACCOUNT_ID);
    // what the server records
    const pet = await env.DB.prepare('SELECT token_id, hatched_by, birth_tx FROM pets').first<{ token_id: string; hatched_by: string; birth_tx: string }>();
    expect(pet).toMatchObject({ token_id: '0', hatched_by: PLAYER });
    expect(pet!.birth_tx.length).toBeGreaterThan(30);
    expect(h.events()).toEqual([{ name: 'pet_born', props: {} }]);
    // the pet is the player's now
    expect((await api('/api/pets/0', { token: await asPlayer() })).body).toMatchObject({ viewer: 'owner', name: 'Pixel', hello: true });
  });

  // spec: add-pet › Birth flow › вылупился
  it('writes the starter food and the storage of the birth as the project\'s spend, at the rate of the day', async () => {
    await hatch('Pixel');
    const rows = (await env.DB.prepare('SELECT kind, usd_micros FROM project_spend ORDER BY kind').all<{ kind: string; usd_micros: number }>()).results;
    // 0.0020 NEAR x 4.59 = $0.00918; 0.01875 NEAR x 4.59 = $0.0860625, rounded up
    expect(rows).toEqual([
      { kind: 'starter_food', usd_micros: 9_180 },
      { kind: 'storage', usd_micros: 86_063 },
    ]);
  });

  // spec: add-pet › Birth flow › вылупился
  it('is "Full": the new pet has its starter food', async () => {
    await hatch('Pixel');
    const res = await api('/api/pets/0', { token: await asPlayer() });
    expect(res.body.fullness).toEqual({ state: 'full', level: 1 });
  });

  // spec: add-pet › Birth flow › не вылупился
  it('says "hatched" when the answer was lost but the network has the birth, and does not mint twice', async () => {
    h.net().contract.mode = 'executed-but-silent';
    const res = await hatch('Pixel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tokenId: '0' });
    expect(mintCalls()).toHaveLength(1);
    expect(h.net().contract.pets.size).toBe(1);
    expect(h.events()).toEqual([{ name: 'pet_born', props: {} }]);
  });

  // spec: add-pet › Birth flow › не вылупился
  it('says "not hatched" when the transaction never reached the network, and the player can try again', async () => {
    h.net().contract.mode = 'lost';
    const res = await hatch('Pixel');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ code: 'not_hatched' });
    expect(h.net().contract.pets.size).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pets').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM births_in_flight').first<{ n: number }>()).toEqual({ n: 0 });
    h.net().contract.mode = 'normal';
    expect((await hatch('Pixel')).status).toBe(200);
  });

  // spec: add-pet › Birth flow › не вылупился
  it('says "not hatched" when the contract refuses for a reason the server does not map, logging the code and not the name', async () => {
    h.net().contract.mintFails = 'character_too_long';
    const res = await hatch('Zorblax');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ code: 'not_hatched' });
    expect(h.logs()).toContain('mint_failed:character_too_long');
    expect(h.logs().join('\n')).not.toContain('Zorblax');
    expect(await everythingInD1()).not.toContain('Zorblax');
  });

  // spec: add-pet › Birth flow › не вылупился
  it('signs again with a fresh nonce when the first delivery is rejected for its nonce', async () => {
    h.net().contract.mode = 'nonce-once';
    const res = await hatch('Pixel');
    expect(res.status).toBe(200);
    expect(mintCalls()).toHaveLength(1);
  });

  // spec: add-pet › Birth flow › вылупился
  it('does not mint a second pet for a second tap while the first birth is in flight: it waits and answers the same', async () => {
    const chain = h.net().contract;
    await env.DB.prepare('INSERT INTO births_in_flight (account, started_at) VALUES (?, ?)').bind(PLAYER, Date.now()).run();
    const second = hatch('Pixel');
    // the first request finishes meanwhile: the pet is born and the row goes
    await new Promise((resolve) => setTimeout(resolve, 150));
    chain.mint(PLAYER, 'Pixel', 'c');
    await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ?').bind(PLAYER).run();
    const res = await second;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tokenId: '0' });
    expect(mintCalls()).toHaveLength(0);
  });

  // spec: add-pet › Birth flow › вылупился
  it('takes over a birth row that is too old to be alive', async () => {
    await env.DB.prepare('INSERT INTO births_in_flight (account, started_at) VALUES (?, ?)').bind(PLAYER, Date.now() - 61_000).run();
    expect((await hatch('Pixel')).status).toBe(200);
    expect(mintCalls()).toHaveLength(1);
  });

  // spec: add-pet › Birth flow › вылупился
  it('needs a session', async () => {
    const res = await api('/api/hatch', { body: { name: 'Pixel' } });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'signed_out' });
    expect(h.net().contract.sends).toEqual([]);
  });

  // spec: add-pet › Birth flow › не вылупился
  it('answers 503 and mints nothing when the network cannot be read', async () => {
    h.net().contract.down = true;
    const res = await hatch('Pixel');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ code: 'chain_unreachable' });
    const open = await api('/api/hatch', { token: await asPlayer() });
    expect(open.status).toBe(503);
  });
});

describe('Public pet data', () => {
  // spec: add-pet › Public pet data › имя с составным эмодзи
  it('sends a name with a composite emoji to the network byte for byte, with its joiner and selectors', async () => {
    const a = await hatch('👩‍🚀 Nova', await asPlayer('did:privy:a', NEAR_ACCOUNT(11)));
    const b = await hatch('🏳️‍🌈', await asPlayer('did:privy:b', NEAR_ACCOUNT(12)));
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    const c = await hatch(scotland, await asPlayer('did:privy:c', NEAR_ACCOUNT(13)));
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    const names = mintCalls().map((m) => m.args.name);
    expect(names).toEqual(['👩‍🚀 Nova', '🏳️‍🌈', scotland]);
    expect(names[0]).toContain('‍');
    expect(names[1]).toContain('️');
    // the notice, the chain and the explorer show the same string
    expect([...String(names[1])]).toEqual([...'🏳️‍🌈']);
  });

  // spec: add-pet › Public pet data › имя с составным эмодзи
  it('cuts the invisible characters between letters and the edges before it sends', async () => {
    await hatch('Pi​xe‮l­️', await asPlayer('did:privy:a', NEAR_ACCOUNT(11)));
    await hatch(' ​  Pixel', await asPlayer('did:privy:b', NEAR_ACCOUNT(12)));
    expect(mintCalls().map((m) => m.args.name)).toEqual(['Pixel', 'Pixel']);
  });
});

describe('Hatch screen', () => {
  // spec: add-pet › Hatch screen › error
  it.each([
    ['service', async () => { await env.DB.prepare("INSERT INTO service_pause (id, reason, since) VALUES (1, 'ai', 1)").run(); }],
    ['budget', async () => { await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros) VALUES (1, 'gas', 100000000)").run(); }],
    ['pool', async () => { h.net().contract.pool = BigInt(env.MAX_BIRTH_COST) - 1n; }],
  ] as const)('is closed for %s: the answer, the event with the reason, and no birth', async (reason, close) => {
    await close();
    // the screen's repeating look sees the same answer and counts as nobody's tap
    // (a player with no pet of their own: the answer carries `noPets`, add-account › Hatch screen › no exit)
    expect((await api('/api/hatch?look=1', { token: await asPlayer() })).body).toEqual({ open: false, reason, noPets: true });
    expect(h.events()).toEqual([]);
    const open = await api('/api/hatch', { token: await asPlayer() });
    expect(open.status).toBe(200);
    expect(open.body).toEqual({ open: false, reason, noPets: true });
    expect(h.events()).toEqual([{ name: 'birth_blocked', props: { reason } }]);
    const tap = await hatch('Pixel');
    expect(tap.status).toBe(409);
    expect(tap.body).toMatchObject({ code: 'closed', reason });
    expect(mintCalls()).toHaveLength(0);
  });

  // spec: add-pet › Hatch screen › error
  it('is open when the spend is a micro-dollar under the threshold and the pool is exactly the birth cost', async () => {
    await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros) VALUES (1, 'gas', 99999999)").run();
    h.net().contract.pool = BigInt(env.MAX_BIRTH_COST);
    expect((await api('/api/hatch', { token: await asPlayer() })).body).toEqual({ open: true });
  });

  // spec: add-pet › Hatch screen › error
  it('closes between the opening of the screen and the tap: the same answer on the tap, nothing minted', async () => {
    expect((await api('/api/hatch', { token: await asPlayer() })).body).toEqual({ open: true });
    h.net().contract.pool = 0n;
    const tap = await hatch('Pixel');
    expect(tap.status).toBe(409);
    expect(tap.body).toMatchObject({ code: 'closed', reason: 'pool' });
    expect(mintCalls()).toHaveLength(0);
    expect(h.events()).toEqual([{ name: 'birth_blocked', props: { reason: 'pool' } }]);
  });

  // spec: add-pet › Hatch screen › error
  it('says the same to a visitor without a session', async () => {
    h.net().contract.pool = 0n;
    const res = await api('/api/hatch');
    expect(res.body).toEqual({ open: false, reason: 'pool' });
  });

  // spec: add-pet › Hatch screen › рождения на сегодня закрыты
  it('is closed for the day when 50 pets were born, until the next 00:00 UTC', async () => {
    const chain = h.net().contract;
    chain.bornToday = 50;
    const open = await api('/api/hatch', { token: await asPlayer() });
    expect(open.body).toEqual({ open: false, reason: 'daily', until: new Date((chain.day + 1) * 86_400_000).toISOString(), noPets: true });
    expect(h.events()).toEqual([{ name: 'birth_blocked', props: { reason: 'daily' } }]);
    chain.bornToday = 49;
    expect((await api('/api/hatch', { token: await asPlayer() })).body).toEqual({ open: true });
  });

  // spec: add-pet › Hatch screen › error × several reasons at once
  it.each([
    ['budget and the day\'s 50', 'budget', async () => { await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros) VALUES (1, 'gas', 100000000)").run(); h.net().contract.bornToday = 50; }],
    ['the pool and the day\'s 50', 'pool', async () => { h.net().contract.pool = 0n; h.net().contract.bornToday = 50; }],
    ['the pause and budget', 'service', async () => { await env.DB.prepare("INSERT INTO service_pause (id, reason, since) VALUES (1, 'gas', 1)").run(); await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros) VALUES (1, 'gas', 100000000)").run(); }],
  ] as const)('with %s the longer cause is told, without a time', async (_label, reason, close) => {
    await close();
    const open = await api('/api/hatch', { token: await asPlayer() });
    expect(open.body).toEqual({ open: false, reason, noPets: true });
    expect(open.body).not.toHaveProperty('until');
    const visitor = await api('/api/hatch');
    expect(visitor.body).toEqual({ open: false, reason });
    expect((await hatch('Pixel')).body).toMatchObject({ code: 'closed', reason });
  });

  // spec: add-pet › Hatch screen › уже есть рождённый питомец
  it('tells a player who hatched and still owns the pet, with its name', async () => {
    const chain = h.net().contract;
    chain.addPet('3', PLAYER, { name: 'Biscuit' });
    chain.hatchedBy.set(PLAYER, '3');
    const res = await api('/api/hatch', { token: await asPlayer() });
    expect(res.body).toEqual({ open: true, already: { tokenId: '3', name: 'Biscuit' } });
    const tap = await hatch('Pixel');
    expect(tap.status).toBe(409);
    expect(tap.body).toEqual({ code: 'already' });
    expect(mintCalls()).toHaveLength(0);
    // the network has the pet and D1 had no row for it (a birth whose bookkeeping was lost): written now
    expect(await env.DB.prepare('SELECT hatched_by FROM pets WHERE token_id = ?').bind('3').first()).toEqual({ hatched_by: PLAYER });
  });

  // spec: add-pet › Hatch screen › уже есть рождённый питомец
  it('does not count pets given to the player: they can still hatch their own', async () => {
    const chain = h.net().contract;
    chain.addPet('3', PLAYER, { name: 'Gifted' }); // owned, but not hatched by this player
    const res = await api('/api/hatch', { token: await asPlayer() });
    expect(res.body).toEqual({ open: true });
    expect((await hatch('Pixel')).status).toBe(200);
  });

  // spec: add-pet › Hatch screen › уже есть рождённый питомец
  it('says nothing of "already" when the pet they hatched was given away', async () => {
    const chain = h.net().contract;
    chain.addPet('3', NEAR_ACCOUNT(99), { name: 'Away' });
    chain.hatchedBy.set(PLAYER, '3');
    expect((await api('/api/hatch', { token: await asPlayer() })).body).toEqual({ open: true });
  });

  // spec: add-pet › Hatch screen › no exit
  it('tells a signed-in player with no pet of their own that a closed hatching has no way out, also on a repeat look', async () => {
    h.net().contract.pool = 0n;
    for (const path of ['/api/hatch', '/api/hatch?look=1']) {
      const res = await api(path, { token: await asPlayer() });
      expect(res.body, path).toEqual({ open: false, reason: 'pool', noPets: true });
    }
    expect(h.net().contract.reads.filter((r) => r.method === 'nft_supply_for_owner').map((r) => r.args)).toEqual([{ account_id: PLAYER }, { account_id: PLAYER }]);
  });

  // spec: add-pet › Hatch screen › no exit
  it('counts what the player owns now: a pet given away leaves them with none, a pet given to them is one', async () => {
    const chain = h.net().contract;
    chain.pool = 0n;
    chain.addPet('3', NEAR_ACCOUNT(99), { name: 'Away' });
    chain.hatchedBy.set(PLAYER, '3'); // they hatched it, and it is somebody else's now
    expect((await api('/api/hatch', { token: await asPlayer() })).body).toHaveProperty('noPets', true);
    chain.addPet('4', PLAYER, { name: 'Gifted' });
    expect((await api('/api/hatch', { token: await asPlayer() })).body).toEqual({ open: false, reason: 'pool' });
  });

  // spec: add-pet › Hatch screen › no exit
  it('says nothing of it to a player with a pet or to a visitor, and does not ask the network for a visitor', async () => {
    const chain = h.net().contract;
    chain.pool = 0n;
    chain.addPet('3', PLAYER);
    chain.hatchedBy.set(PLAYER, '3');
    const owner = await api('/api/hatch', { token: await asPlayer() });
    expect(owner.body).toEqual({ open: false, reason: 'pool' });
    expect(owner.body).not.toHaveProperty('noPets');
    chain.reads.length = 0;
    const visitor = await api('/api/hatch');
    expect(visitor.body).toEqual({ open: false, reason: 'pool' });
    expect(chain.reads.map((r) => r.method)).not.toContain('nft_supply_for_owner');
    // open hatching: no count at all
    chain.pool = 1_000_000_000_000_000_000_000_000n;
    chain.reads.length = 0;
    expect((await api('/api/hatch', { token: await token('did:privy:other', NEAR_ACCOUNT(11)) })).body).toEqual({ open: true });
    expect(chain.reads.map((r) => r.method)).not.toContain('nft_supply_for_owner');
  });

  // spec: add-pet › Hatch screen › no exit
  it('answers 503 chain_unreachable when the count cannot be read, never a closed answer without it', async () => {
    h.net().contract.pool = 0n;
    // the read of the hatch record works, the count fails: only that method is down
    h.net().contract.failingViews.add('nft_supply_for_owner');
    const down = await api('/api/hatch', { token: await asPlayer() });
    expect(down).toEqual({ status: 503, body: { code: 'chain_unreachable' } });
  });

  // spec: add-pet › Hatch screen › error
  it('shows a closed hatching above "already hatched"', async () => {
    const chain = h.net().contract;
    chain.addPet('3', PLAYER);
    chain.hatchedBy.set(PLAYER, '3');
    chain.bornToday = 50;
    const res = await api('/api/hatch', { token: await asPlayer() });
    expect(res.body).toMatchObject({ open: false, reason: 'daily' });
    expect(res.body).not.toHaveProperty('already');
  });
});

describe('Pet mint contract (the character)', () => {
  // spec: add-pet › Pet mint contract › характер длиннее предела
  it('has presets whose longest assembly is MAX_CHARACTER_BYTES of the contract', () => {
    expect(longestAssemblyBytes()).toBe(Number(env.MAX_CHARACTER_BYTES));
    // every assembly the picker can make fits the contract's limit
    const longestPick = (n: number) => n - 1;
    const enc = new TextEncoder();
    expect(enc.encode(assembleCharacter(() => 0)).length).toBeLessThanOrEqual(Number(env.MAX_CHARACTER_BYTES));
    expect(enc.encode(assembleCharacter(longestPick)).length).toBeLessThanOrEqual(Number(env.MAX_CHARACTER_BYTES));
  });

  // spec: add-pet › Pet mint contract › характер длиннее предела
  it('has presets word for word as presets.md › Slots', () => {
    const fromFile = JSON.parse(env.PRESETS_MD) as string[][];
    expect(fromFile.map((slot) => slot.length)).toEqual([8, 8, 10, 8, 6]);
    expect(SLOTS.map((slot) => [...slot])).toEqual(fromFile);
    for (const fragment of SLOTS.flat()) expect(fragment).toMatch(/^[\x20-\x7e]+$/); // plain ASCII
  });
});
