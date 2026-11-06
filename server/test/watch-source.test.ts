import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { observeWatch, sameObservation } from '../src/watch/source';
import { storePaidObservation } from '../src/watch/observation';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();

describe('Watch source data and observation data', () => {
  // spec: add-pet-errands › Watch source data › topic checked
  it('sends only the public target to one search and reads named public pages', async () => {
    const url = 'https://science.example.com/meteor';
    h.net().ai.push({ stream: { outputs: [`[1] Meteor shower\n${url}\nPeak in November`] } });
    h.net().web.page(url, { body: '<html><header>Clock 10:00</header><main><time>11:00</time><p>The peak is in November.</p></main><footer>Ad</footer></html>' });
    const read = await observeWatch(env, 'topic', 'Leonids meteor shower');
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.observation.sourceUrls).toEqual([url]);
    expect(read.observation.namedContent).toContain('The peak is in November.');
    expect(read.observation.namedContent).not.toMatch(/Clock|Ad/);
    expect(h.net().ai.calls).toHaveLength(1);
    expect(h.net().ai.calls[0]!.body.messages).toEqual([
      { role: 'system', content: expect.any(String) },
      { role: 'user', content: 'Leonids meteor shower' },
    ]);
    expect(JSON.stringify(h.net().ai.calls[0]!.body)).not.toContain(NEAR_ACCOUNT(1));
  });

  // spec: add-pet-errands › Watch source data › topic checked × incidental text inside cited main
  it('keeps the named fact stable when unrelated main content changes', async () => {
    const url = 'https://science.example.com/meteor';
    h.net().ai.push({ stream: { outputs: [`[1] Leonids meteor shower\n${url}\nPeak in November`] } });
    h.net().web.page(url, { body: '<main><p>The peak is in November.</p><p>Our office has a new address.</p><p>Ad: Winter sale.</p></main>' });
    const first = await observeWatch(env, 'topic', 'Leonids meteor shower');
    h.net().ai.push({ stream: { outputs: [`[1] Leonids meteor shower\n${url}\nPeak in November`] } });
    h.net().web.page(url, { body: '<main><p>The peak is in November.</p><p>Our office has a new phone number.</p><p>Ad: Spring sale.</p></main>' });
    const second = await observeWatch(env, 'topic', 'Leonids meteor shower');
    expect(first.kind).toBe('ok'); expect(second.kind).toBe('ok');
    if (first.kind !== 'ok' || second.kind !== 'ok') return;
    expect(first.observation.namedContent).toContain('The peak is in November.');
    expect(first.observation.namedContent).not.toContain('office');
    expect(sameObservation(first.observation, second.observation)).toBe(true);
  });

  // spec: add-pet-errands › Watch source data › release checked
  it('compares GitHub release object fields, never a bare tag', async () => {
    const url = 'https://api.github.com/repos/example/project/releases?per_page=10';
    h.net().web.page(url, { headers: { 'content-type': 'application/json' }, body: JSON.stringify([
      { id: 23, tag_name: 'v1', name: 'Version 1', body: 'Old', assets: [], draft: false, published_at: '2036-10-01T00:00:00Z' },
      { id: 24, tag_name: 'v2', name: 'Version 2', body: 'Fixes', assets: [{ id: 11 }, { id: 10 }], draft: false, prerelease: true, published_at: '2036-11-01T00:00:00Z' },
    ]) });
    const read = await observeWatch(env, 'release', 'https://github.com/example/project/releases');
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(JSON.parse(read.observation.namedContent)).toEqual({ id: 24, tag: 'v2', name: 'Version 2', body: 'Fixes', assets: [10, 11] });
    h.net().web.page(url, { headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ ref: 'refs/tags/v3' }]) });
    expect((await observeWatch(env, 'release', 'https://github.com/example/project/releases')).kind).toBe('unreadable');
  });

  // spec: add-pet-errands › Watch source data › release checked
  it('finds the repository for a named release through its search result', async () => {
    const apiUrl = 'https://api.github.com/repos/rust-lang/rust/releases?per_page=10';
    h.net().ai.push({ stream: { outputs: ['[1] Rust release\nhttps://github.com/rust-lang/rust/releases/tag/1.90.0\nPublished'] } });
    h.net().web.page(apiUrl, { headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ id: 42, tag_name: '1.90.0', name: 'Rust 1.90.0', body: 'Release notes', assets: [], draft: false, published_at: '2036-11-01T00:00:00Z' }]) });
    const read = await observeWatch(env, 'release', 'Rust compiler releases');
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.observation.sourceUrls).toEqual([apiUrl]);
  });

  // spec: add-pet-errands › Watch source data › account checked
  it('reads only named public NEAR account fields through RPC', async () => {
    const account = NEAR_ACCOUNT(9);
    h.net().contract.balances.set(account, 42n);
    const read = await observeWatch(env, 'account', account);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(JSON.parse(read.observation.namedContent)).toMatchObject({ amount: '42', locked: '0', storage_usage: 100 });
    expect(h.net().contract.viewed).toContain(account);
  });

  // spec: add-pet-errands › Watch source data › page address blocked
  it('never fetches a private page or a redirected private address', async () => {
    const before = h.net().ai.calls.length;
    expect((await observeWatch(env, 'page', 'http://127.0.0.1/private')).kind).toBe('blocked');
    expect(h.net().ai.calls).toHaveLength(before);
    const page = 'https://public.example.com/article';
    h.net().web.redirect(page, 'http://169.254.169.254/latest/meta-data');
    const read = await observeWatch(env, 'page', page);
    expect(read.kind).toBe('blocked');
    expect(h.net().fetched).not.toContain('http://169.254.169.254/latest/meta-data');
  });

  // spec: add-pet-errands › Watch observation data › comparison has no prior observation
  // spec: add-pet-errands › Watch observation data › comparison has no prior observation × incidental page furniture
  it('returns a fresh named observation without mutating the stored baseline', async () => {
    const url = 'https://news.example.com/topic';
    h.net().web.page(url, { body: '<main><p>Same fact.</p></main><footer>10:00</footer>' });
    const first = await observeWatch(env, 'page', url);
    h.net().web.page(url, { body: '<header>11:00</header><main><p>Same fact.</p></main>' });
    const second = await observeWatch(env, 'page', url);
    expect(first.kind).toBe('ok'); expect(second.kind).toBe('ok');
    if (first.kind !== 'ok' || second.kind !== 'ok') return;
    expect(sameObservation(first.observation, second.observation)).toBe(true);
    expect(sameObservation({ namedContent: 'https://first.example/fact\nSame fact.', sourceUrls: [] },
      { namedContent: 'https://second.example/fact\nSame fact.', sourceUrls: [] })).toBe(true);
    expect(await env.DB.prepare('SELECT 1 FROM watch_observations').first()).toBeNull();
    await env.DB.prepare("INSERT INTO watch_targets (token_id, kind, target, saved_hour_utc, owner_generation, updated_at) VALUES ('5', 'page', ?, 10, 0, 1)").bind(url).run();
    await env.DB.prepare("INSERT INTO watch_checks (token_id, day, revision, status, price_yocto, receipt_id, started_at) VALUES ('5', 1, 1, 'paid', '100', 'receipt-one', 1)").run();
    expect(await storePaidObservation(env.DB, '5', 1, 1, first.observation)).toBe(true);
    expect(await env.DB.prepare('SELECT named_content, source_urls FROM watch_observations WHERE token_id = ?').bind('5').first()).toEqual({ named_content: first.observation.namedContent, source_urls: JSON.stringify([url]) });
    expect((await env.DB.prepare('SELECT latest_receipt_id FROM watch_targets WHERE token_id = ?').bind('5').first<{ latest_receipt_id: string }>())?.latest_receipt_id).toBe('receipt-one');
    expect(await env.DB.prepare("SELECT 1 FROM thoughts WHERE kind = 'diary'").first()).toBeNull();
  });

  // spec: add-pet-errands › Watch observation data › named source unreadable
  it('does not invent an observation when a named page cannot be read', async () => {
    await env.DB.prepare("INSERT INTO watch_targets (token_id, kind, target, saved_hour_utc, owner_generation, updated_at) VALUES ('5', 'page', 'https://missing.example.com/article', 10, 0, 1)").run();
    await env.DB.prepare("INSERT INTO watch_observations (token_id, revision, named_content, source_urls, observed_day) VALUES ('5', 1, 'old fact', '[]', 1)").run();
    const read = await observeWatch(env, 'page', 'https://missing.example.com/article');
    expect(read.kind).toBe('unreadable');
    expect((await env.DB.prepare('SELECT named_content FROM watch_observations').first<{ named_content: string }>())?.named_content).toBe('old fact');
  });
});
