import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
// A Durable Object keeps an IP's count for the whole minute, across tests: each test that names an
// IP names one of its own.
const ip = (n: number) => `192.0.2.${n}`;

const reads = () => h.net().contract.reads.length;

describe('Guest view data', () => {
  // spec: add-pet › Guest view data › предел на IP
  it('takes 120 requests a minute from one IP without a session and turns the 121st away without reading the network or writing an event', async () => {
    // Each id is a pet of its own, so each of the first 120 requests really reads the network.
    for (let i = 0; i < 120; i += 1) {
      const res = await api(`/api/pets/${i}`, { ip: ip(41) });
      expect(res.status).toBe(404);
    }
    expect(reads()).toBe(120);
    const over = await api('/api/pets/500', { ip: ip(41) });
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ code: 'rate_limited' });
    expect(reads()).toBe(120);
    expect(h.events()).toEqual([]);
  });

  // spec: add-pet › Guest view data › предел на IP
  it('takes requests from the IP again from the next minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2036-11-01T10:00:10Z'));
    for (let i = 0; i < 121; i += 1) await api(`/api/pets/${i}`, { ip: ip(42) });
    expect((await api('/api/pets/1', { ip: ip(42) })).status).toBe(429);
    vi.setSystemTime(new Date('2036-11-01T10:01:00Z'));
    expect((await api('/api/pets/1', { ip: ip(42) })).status).toBe(404);
  });

  // spec: add-pet › Guest view data › предел на IP
  it('counts each IP on its own', async () => {
    for (let i = 0; i < 121; i += 1) await api(`/api/pets/${i}`, { ip: ip(43) });
    expect((await api('/api/pets/1', { ip: ip(99) })).status).toBe(404);
  });

  // spec: add-pet › Guest view data › предел на IP
  it('keeps the IP out of D1 and out of the logs', async () => {
    for (let i = 0; i < 125; i += 1) await api(`/api/pets/${i}`, { ip: ip(44) });
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>();
    for (const { name } of tables.results) {
      const rows = await env.DB.prepare(`SELECT * FROM ${name}`).all();
      expect(JSON.stringify(rows.results)).not.toContain(ip(44));
    }
    const events = await env.EVENTS.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>();
    for (const { name } of events.results) {
      const rows = await env.EVENTS.prepare(`SELECT * FROM ${name}`).all();
      expect(JSON.stringify(rows.results)).not.toContain(ip(44));
    }
    expect(h.logs().join('\n')).not.toContain(ip(44));
  });
});

describe('Session request limit data', () => {
  // spec: add-pet › Session request limit data › предел на сессию
  it('takes 120 requests a minute from all tokens of one player and turns the 121st away without reading the network, reserving anything or writing an event', async () => {
    h.net().contract.addPet('9', NEAR_ACCOUNT(1));
    // Three tokens of the same player (three sessions): one count.
    const tokens = [await token('did:privy:p1', NEAR_ACCOUNT(1)), await token('did:privy:p1', NEAR_ACCOUNT(1)), await token('did:privy:p1', NEAR_ACCOUNT(1))];
    for (let i = 0; i < 120; i += 1) {
      const res = await api('/api/pets/9', { token: tokens[i % 3] });
      expect(res.status).toBe(200);
    }
    const readsBefore = reads();
    const over = await api('/api/pets/9', { token: tokens[0] });
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ code: 'rate_limited' });
    expect(reads()).toBe(readsBefore);
    expect(h.events()).toEqual([]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM pet_spend').first<{ n: number }>())!.n).toBe(0);
  });

  // spec: add-pet › Session request limit data › предел на сессию
  // 123 sequential requests traverse the full Worker harness; allow for contention during the full verification run.
  it('does not count a player\'s requests against their IP, nor another player against them', { timeout: 30_000 }, async () => {
    h.net().contract.addPet('7001', NEAR_ACCOUNT(1));
    const mine = await token('did:privy:p1', NEAR_ACCOUNT(1));
    for (let i = 0; i < 121; i += 1) await api('/api/pets/7001', { token: mine, ip: ip(46) });
    // The same IP, no session: its own count, untouched by the player's 121 requests.
    expect((await api('/api/pets/7001', { ip: ip(46) })).status).toBe(200);
    // Another player is not limited by the first.
    expect((await api('/api/pets/7001', { token: await token('did:privy:p2', NEAR_ACCOUNT(2)), ip: ip(46) })).status).toBe(200);
  });

  // spec: add-pet › Session request limit data › предел на сессию
  // 123 requests one after another, each through the whole app: the default 5 s is too short when the full run loads the machine
  it('counts from the next minute again', { timeout: 30_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2036-11-01T10:00:10Z'));
    h.net().contract.addPet('9', NEAR_ACCOUNT(1));
    const mine = await token('did:privy:p1', NEAR_ACCOUNT(1));
    for (let i = 0; i < 121; i += 1) await api('/api/pets/9', { token: mine });
    expect((await api('/api/pets/9', { token: mine })).status).toBe(429);
    vi.setSystemTime(new Date('2036-11-01T10:01:00Z'));
    expect((await api('/api/pets/9', { token: mine })).status).toBe(200);
  });
});
