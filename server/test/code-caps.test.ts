// What bounds a skill's code before it loads (`add-pet-errands` › `Skill code flow`, `Skill code data`, ADR-025, OD-1850):
// 20 test runs a pet a UTC day, 330 code versions a UTC day across the game, and the project's spend for each version it loads.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { clean } from '../src/cron';
import { utcDay } from '../src/http';
import { api, harness } from './helpers/api';
import { CODE, sha256, spendRows, testRun, testsToday, versionRows } from './helpers/code';
import { OTHER, PET, other, owner, petWithSkill } from './helpers/sources';

const h = harness();
const today = () => utcDay(Date.now());
const edit = (n: number) => `${CODE}\n// edit ${n}`;
const MAX = 330;

/** The day's versions as the game has loaded them, `count` of them. */
async function seedVersions(count: number, day = today()) {
  await env.DB.prepare('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1) INSERT INTO code_versions (day, version) SELECT ?2, \'seed:\' || i FROM n')
    .bind(count, day)
    .run();
}

describe('Skill code flow', () => {
  // spec: add-pet-errands › Skill code flow › cap reached
  // spec: add-pet-errands › Skill code data › test runs used up
  it('the 21st test run of a pet loads and runs nothing and counts no new version; the 20 before it ran', async () => {
    const tk = await petWithSkill(h);
    for (let i = 0; i < 20; i += 1) expect((await testRun(tk, { code: CODE, fn: 'add', values: '1,2' })).body.outcome).toBe('ok');
    expect((await testsToday()).runs).toBe(20);
    const versions = (await versionRows()).length;
    // a new text would be a new version: it does not even load
    const out = await testRun(tk, { code: edit(1), fn: 'add', values: '1,2' });
    expect(out.status).toBe(429);
    expect(out.body).toEqual({ code: 'tests_used_up' });
    expect((await testsToday()).runs).toBe(20);
    expect(await versionRows()).toHaveLength(versions);
    // the same text neither: the cap is the pet's
    expect((await testRun(tk, { code: CODE, fn: 'add', values: '1,2' })).status).toBe(429);
    // GET tells how many are left, for «Test run» to be inactive with its line
    expect((await api(`/api/pets/${PET}/code`, { token: tk })).body.testsLeft).toBe(0);
    // no `skill_code_ran` for the refusal: nothing ran
    expect(h.events().filter((e) => e.name === 'skill_code_ran')).toHaveLength(20);
  }, 30_000);

  // spec: add-pet-errands › Skill code flow › cap reached × 00:00 UTC
  // spec: add-pet-errands › Skill code data › test runs used up
  it('at 00:00 UTC the count starts again', async () => {
    const tk = await petWithSkill(h);
    await env.DB.prepare('INSERT INTO code_tests (token_id, day, runs) VALUES (?, ?, 20)').bind(PET, today()).run();
    expect((await testRun(tk, { code: CODE, fn: 'add', values: '1,2' })).status).toBe(429);
    const midnight = (today() + 1) * 86_400_000;
    vi.setSystemTime(midnight - 1_000);
    expect((await testRun(await owner(), { code: CODE, fn: 'add', values: '1,2' })).status).toBe(429);
    vi.setSystemTime(midnight);
    const out = await testRun(await owner(), { code: CODE, fn: 'add', values: '1,2' });
    expect(out.body.outcome).toBe('ok');
    expect((await api(`/api/pets/${PET}/code`, { token: await owner() })).body.testsLeft).toBe(19);
  });

  // spec: add-pet-errands › Skill code flow › game's code cap reached
  // spec: add-pet-errands › Skill code data › game-wide versions used up
  // spec: add-pet-errands › Errand events data › code ran
  it('the 331st version of the day loads nothing, uses no test run of the pet and fails like a busy source: capped', async () => {
    const tk = await petWithSkill(h);
    await seedVersions(MAX);
    const before = await spendRows('code_version');
    const out = await testRun(tk, { code: CODE, fn: 'add', values: '1,2' });
    expect(out.status).toBe(429);
    expect(out.body).toEqual({ code: 'game_capped' });
    expect((await testsToday()).runs).toBe(0);
    expect(await versionRows()).toHaveLength(MAX);
    expect(await spendRows('code_version')).toHaveLength(before.length);
    expect(h.events().filter((e) => e.name === 'skill_code_ran')).toEqual([{ name: 'skill_code_ran', props: { outcome: 'capped', job: 'test' } }]);
    expect(h.logs()).toContain('code_capped');
    // an edit is a new version too
    expect((await testRun(tk, { code: edit(2), fn: 'add' })).body).toEqual({ code: 'game_capped' });
    // the 330th still fits: one fewer seeded
    await env.DB.prepare('DELETE FROM code_versions WHERE version = ?').bind('seed:1').run();
    expect((await testRun(tk, { code: CODE, fn: 'add', values: '1,2' })).body.outcome).toBe('ok');
    expect(await versionRows()).toHaveLength(MAX);
  });

  // spec: add-pet-errands › Skill code flow › game's code cap reached
  it('the next UTC day the game\'s count starts again', async () => {
    const tk = await petWithSkill(h);
    await seedVersions(MAX);
    expect((await testRun(tk, { code: CODE, fn: 'add' })).status).toBe(429);
    vi.setSystemTime((today() + 1) * 86_400_000);
    expect((await testRun(await owner(), { code: CODE, fn: 'add', values: '1,2' })).body.outcome).toBe('ok');
  });
});

describe('Skill code data', () => {
  // spec: add-pet-errands › Skill code data › test runs used up × the pet given away
  it('the count goes with the pet on a gift: the new owner finds the 20 spent, the giver is turned away', async () => {
    const tk = await petWithSkill(h);
    await env.DB.prepare('INSERT INTO code_tests (token_id, day, runs) VALUES (?, ?, 20)').bind(PET, today()).run();
    h.net().contract.pets.get(PET)!.owner_id = OTHER;
    const taker = await other();
    const out = await testRun(taker, { code: CODE, fn: 'add', values: '1,2' });
    expect(out.status).toBe(429);
    expect(out.body).toEqual({ code: 'tests_used_up' });
    expect((await api(`/api/pets/${PET}/code`, { token: taker })).body.testsLeft).toBe(0);
    expect((await testRun(tk, { code: CODE, fn: 'add', values: '1,2' })).status).toBe(403);
  });

  // spec: add-pet-errands › Skill code data › version already loaded today
  it('past the game\'s 330 a version already loaded today runs as usual, and bills nothing more', async () => {
    const tk = await petWithSkill(h);
    expect((await testRun(tk, { code: CODE, fn: 'add', values: '1,2' })).body.outcome).toBe('ok');
    await seedVersions(MAX - 1);
    expect(await versionRows()).toHaveLength(MAX);
    const billed = (await spendRows('code_version')).length;
    const again = await testRun(tk, { code: CODE, fn: 'add', values: '3,4' });
    expect(again.body.outcome).toBe('ok');
    expect(JSON.parse(again.body.output)).toEqual({ sum: 7 });
    expect(await versionRows()).toHaveLength(MAX);
    expect(await spendRows('code_version')).toHaveLength(billed);
  });

  // spec: add-pet-errands › Skill code data › a version billed
  it('each new version of a day is the project\'s $0.002, once, and the birth threshold reads it', async () => {
    const tk = await petWithSkill(h);
    expect((await testRun(tk, { code: CODE, fn: 'add', values: '1,2' })).body.outcome).toBe('ok');
    expect((await spendRows('code_version')).map((r) => r.usd_micros)).toEqual([2_000]);
    // the same version again: Cloudflare bills it no more today
    await testRun(tk, { code: CODE, fn: 'add', values: '1,2' });
    expect(await spendRows('code_version')).toHaveLength(1);
    // an edit is another version
    await testRun(tk, { code: edit(3), fn: 'add', values: '1,2' });
    expect((await spendRows('code_version')).map((r) => r.usd_micros)).toEqual([2_000, 2_000]);
    // the next UTC day the same text is billed again
    vi.setSystemTime((today() + 1) * 86_400_000);
    await testRun(await owner(), { code: CODE, fn: 'add', values: '1,2' });
    expect(await spendRows('code_version')).toHaveLength(3);
    // the version rows hold the id and nothing else of the code
    expect((await versionRows()).map((r) => r.version)).toContain(`${PET}:${await sha256(CODE)}`);
  });

  // spec: add-pet-errands › Skill code data › a version billed
  it('a version that tips the project\'s spend over the $100 threshold closes births', async () => {
    const tk = await petWithSkill(h);
    await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros) VALUES (1, 'gas', 99998000)").run();
    const visitor = await other();
    expect((await api('/api/hatch?look=1', { token: visitor })).body).toEqual({ open: true });
    await testRun(tk, { code: CODE, fn: 'add', values: '1,2' });
    expect((await api('/api/hatch?look=1', { token: visitor })).body).toEqual({ open: false, reason: 'budget', noPets: true });
  });

  // spec: add-pet-errands › Skill code data › a version billed
  it('the cron keeps the test runs of today and yesterday and the code versions of this month and the last', async () => {
    const now = Date.UTC(2036, 11, 15, 12);
    const day = utcDay(now);
    const firstOfLast = Math.floor(Date.UTC(2036, 10, 1) / 86_400_000);
    for (const d of [day - 2, day - 1, day]) await env.DB.prepare('INSERT INTO code_tests (token_id, day, runs) VALUES (?, ?, 1)').bind(PET, d).run();
    for (const d of [firstOfLast - 1, firstOfLast, day]) await env.DB.prepare('INSERT INTO code_versions (day, version) VALUES (?, ?)').bind(d, `v:${d}`).run();
    await clean(env, now);
    expect((await env.DB.prepare('SELECT day FROM code_tests ORDER BY day').all<{ day: number }>()).results.map((r) => r.day)).toEqual([day - 1, day]);
    expect((await versionRows()).map((r) => r.day)).toEqual([firstOfLast, day]);
  });
});
