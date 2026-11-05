import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanJudgeCodes, hashJudgeCode, issueJudgeCodes, JUDGE_DELETE_AT, JUDGE_EXPIRES_AT } from '../src/judge';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import policy from '../src/showcasePolicy.json';

const h = harness();
const MONTH = '2026-11';
const START = Date.parse('2026-11-17T12:00:00.000Z');

beforeEach(async () => {
  vi.setSystemTime(START);
  for (const table of ['judge_redemptions', 'judge_codes', 'sign_in_refusals', 'players']) await env.DB.exec(`DELETE FROM ${table}`);
});

async function seedPlayers(n: number): Promise<void> {
  if (n === 0) return;
  await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?1)
    INSERT INTO players (sub, account_id, month, created_at)
    SELECT 'did:privy:seed-' || i, ?2, ?3, 1 FROM n`).bind(n, NEAR_ACCOUNT(1), MONTH).run();
}

const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const newcomer = (i: number) => token(`did:privy:judge-${i}`, NEAR_ACCOUNT(100 + i), { noPlayer: true });
const exchange = (tk: string, code?: string) => api('/api/session', { token: tk, body: { fresh: true, from: 'link', ...(code === undefined ? {} : { judgeCode: code }) } });
const check = (code: string) => api('/api/judge/check', { body: { code } });

describe('Judge admission data', () => {
  // spec: add-showcase › Judge admission data › private code checked
  it('issues exactly ten random 128-bit codes privately, stores hashes, and checks without reserving', async () => {
    const codes = await issueJudgeCodes(env.DB, START);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((code) => /^[0-9a-f]{32}$/.test(code))).toBe(true);
    const rows = await env.DB.prepare('SELECT hash, expires_at FROM judge_codes').all<{ hash: string; expires_at: number }>();
    expect(rows.results).toHaveLength(10);
    expect(rows.results.map((r) => r.hash)).toContain(await hashJudgeCode(codes[0]));
    expect(rows.results.every((r) => r.expires_at === JUDGE_EXPIRES_AT)).toBe(true);
    expect(await env.DB.prepare('SELECT code_limit, uses_per_code, admitted_limit, counted_limit FROM judge_admission_policy WHERE id = 1').first())
      .toEqual({ code_limit: policy.judgeCodes, uses_per_code: policy.redemptionsPerCode,
        admitted_limit: policy.judgeAdmission, counted_limit: policy.countedSignIns });
    expect(await api('/api/showcase/policy')).toEqual({ status: 200, body: { judgeExpiresAt: policy.judgeExpiresAt } });
    expect(JSON.stringify(rows.results)).not.toContain(codes[0]);
    expect(await check(codes[0])).toEqual({ status: 200, body: { ok: true } });
    expect(await count('judge_redemptions')).toBe(0);
    expect(await count('players')).toBe(0);
    expect(h.net().fetched).toEqual([]);
    expect(h.logs()).toEqual([]);
    await expect(issueJudgeCodes(env.DB, START)).rejects.toThrow('judge_codes_already_issued');
    await expect(env.DB.prepare('INSERT INTO judge_codes (hash, issued_at, expires_at) VALUES (?, ?, ?)')
      .bind('a'.repeat(64), START, JUDGE_EXPIRES_AT).run()).rejects.toThrow('judge_issue_limit');
    expect(await count('judge_codes')).toBe(10);
  });

  // spec: add-showcase › Judge admission data › admitted Google return
  it('enforces one redemption per identity and month in the D1 schema', async () => {
    const [first, second] = await issueJudgeCodes(env.DB, START);
    const firstHash = await hashJudgeCode(first);
    const secondHash = await hashJudgeCode(second);
    await env.DB.prepare('INSERT INTO judge_redemptions (code_hash, sub, month, redeemed_at) VALUES (?, ?, ?, ?)')
      .bind(firstHash, 'did:privy:same', MONTH, START).run();
    await expect(env.DB.prepare('INSERT INTO judge_redemptions (code_hash, sub, month, redeemed_at) VALUES (?, ?, ?, ?)')
      .bind(secondHash, 'did:privy:same', MONTH, START).run()).rejects.toThrow('UNIQUE constraint failed');
    expect(await count('judge_redemptions')).toBe(1);
  });

  // spec: add-showcase › Judge admission data › concurrent return takes last place
  it('has the SQL admission guard read its policy row', async () => {
    const [first, second] = await issueJudgeCodes(env.DB, START);
    const firstHash = await hashJudgeCode(first);
    const secondHash = await hashJudgeCode(second);
    await env.DB.prepare('UPDATE judge_admission_policy SET uses_per_code = 1').run();
    await env.DB.prepare('INSERT INTO judge_redemptions (code_hash, sub, month, redeemed_at) VALUES (?, ?, ?, ?)')
      .bind(firstHash, 'did:privy:policy-first', MONTH, START).run();
    await expect(env.DB.prepare('INSERT INTO judge_redemptions (code_hash, sub, month, redeemed_at) VALUES (?, ?, ?, ?)')
      .bind(firstHash, 'did:privy:policy-second', MONTH, START).run()).rejects.toThrow('judge_exhausted');
    await seedPlayers(1);
    await env.DB.prepare('UPDATE judge_admission_policy SET admitted_limit = 1').run();
    await expect(env.DB.prepare('INSERT INTO judge_redemptions (code_hash, sub, month, redeemed_at) VALUES (?, ?, ?, ?)')
      .bind(secondHash, 'did:privy:policy-second', MONTH, START).run()).rejects.toThrow('judge_admission_full');
    await env.DB.prepare('UPDATE judge_admission_policy SET admitted_limit = 480, counted_limit = 1').run();
    await expect(env.DB.prepare('INSERT INTO judge_redemptions (code_hash, sub, month, redeemed_at) VALUES (?, ?, ?, ?)')
      .bind(secondHash, 'did:privy:policy-second', MONTH, START).run()).rejects.toThrow('judge_ceiling');
  });

  // spec: add-showcase › Judge admission flow › invalid code
  // spec: add-showcase › Judge admission flow › expired code
  it('distinguishes unissued and expired codes without Google or reservations', async () => {
    const [code] = await issueJudgeCodes(env.DB, START);
    expect(await check('f'.repeat(32))).toEqual({ status: 403, body: { code: 'judge_invalid' } });
    vi.setSystemTime(JUDGE_EXPIRES_AT);
    expect(await check(code)).toEqual({ status: 403, body: { code: 'judge_expired' } });
    expect(await count('judge_redemptions')).toBe(0);
    expect(h.net().fetched).toEqual([]);
  });

  // spec: add-showcase › Judge admission data › admitted Google return
  // spec: add-showcase › Judge admission flow › second identity
  it('redeems two distinct verified identities once each and preserves existing-player entry', async () => {
    await seedPlayers(460);
    const [code] = await issueJudgeCodes(env.DB, START);
    const first = await newcomer(1);
    expect(await exchange(first, code)).toEqual({ status: 200, body: { ok: true } });
    expect(await exchange(first, code)).toEqual({ status: 200, body: { ok: true } });
    expect(await exchange(await newcomer(2), code)).toEqual({ status: 200, body: { ok: true } });
    expect(await count('judge_redemptions')).toBe(2);
    expect(await count('players')).toBe(462);
    expect(await check(code)).toEqual({ status: 403, body: { code: 'judge_exhausted' } });
    expect(await exchange(await newcomer(3), code)).toEqual({ status: 403, body: { code: 'judge_exhausted' } });
    expect(await count('sign_in_refusals')).toBe(1);
    expect(JSON.stringify(h.logs())).not.toContain(code);
    expect(JSON.stringify(h.events())).not.toContain(code);
  });

  // spec: add-showcase › Judge admission data › concurrent return takes last place
  it('admits exactly one of two simultaneous Google returns for the last code place', async () => {
    await seedPlayers(460);
    const [code] = await issueJudgeCodes(env.DB, START);
    expect((await exchange(await newcomer(1), code)).status).toBe(200);
    const [a, b] = await Promise.all([exchange(await newcomer(2), code), exchange(await newcomer(3), code)]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect([a.body, b.body]).toContainEqual({ code: 'judge_exhausted' });
    expect(await count('judge_redemptions')).toBe(2);
    expect(await count('players')).toBe(462);
  });

  // spec: add-showcase › Judge admission flow › ordinary entry closed
  it('closes ordinary entry at 460 and keeps the judge path open through 479', async () => {
    await seedPlayers(459);
    expect((await api('/api/sign-in')).body.state).toBe('open');
    expect((await exchange(await newcomer(1))).status).toBe(200);
    expect((await api('/api/sign-in')).body.state).toBe('closed_new');
    const [code] = await issueJudgeCodes(env.DB, START);
    expect((await exchange(await newcomer(2), code)).status).toBe(200);
  });

  // spec: add-showcase › Judge admission data › total admission exhausted
  it('enforces 480 admitted accounts even with an unspent code', async () => {
    await seedPlayers(479);
    const [code] = await issueJudgeCodes(env.DB, START);
    expect((await check(code)).status).toBe(200);
    expect((await exchange(await newcomer(1), code)).status).toBe(200);
    expect(await check(code)).toEqual({ status: 403, body: { code: 'mau' } });
    expect((await exchange(await newcomer(2), code)).body).toMatchObject({ code: 'sign_in_refused', reason: 'mau' });
    expect(await count('judge_redemptions')).toBe(1);
  });

  // spec: add-showcase › Judge admission data › ceiling reached after Google
  it('enforces the 490 counted ceiling without recording a redemption', async () => {
    await seedPlayers(479);
    await env.DB.prepare('INSERT INTO sign_in_refusals (sub, month) VALUES (?, ?)').bind('did:privy:prior-refusal', MONTH).run();
    const [code] = await issueJudgeCodes(env.DB, START);
    expect(await check(code)).toEqual({ status: 200, body: { ok: true } });
    for (let i = 1; i < 11; i += 1) await env.DB.prepare('INSERT INTO sign_in_refusals (sub, month) VALUES (?, ?)').bind(`did:privy:refused-${i}`, MONTH).run();
    expect((await api('/api/sign-in')).body.state).toBe('closed_all');
    expect((await exchange(await newcomer(1), code)).body).toMatchObject({ code: 'sign_in_refused', reason: 'ceiling' });
    expect(await count('judge_redemptions')).toBe(0);
  });

  // spec: add-showcase › Judge admission data › code expired during Google
  it('rechecks expiry on return, counts a refusal and erases code records on December 1', async () => {
    await seedPlayers(460);
    const [code] = await issueJudgeCodes(env.DB, START);
    expect((await check(code)).status).toBe(200);
    vi.setSystemTime(JUDGE_EXPIRES_AT);
    expect(await exchange(await newcomer(1), code)).toEqual({ status: 403, body: { code: 'judge_expired' } });
    expect(await count('judge_redemptions')).toBe(0);
    expect(await count('sign_in_refusals')).toBe(1);
    await cleanJudgeCodes(env.DB, JUDGE_DELETE_AT - 1);
    expect(await count('judge_codes')).toBe(10);
    await cleanJudgeCodes(env.DB, JUDGE_DELETE_AT);
    expect(await count('judge_codes')).toBe(0);
    expect(await count('judge_redemptions')).toBe(0);
  });
});
