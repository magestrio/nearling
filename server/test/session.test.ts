import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clean } from '../src/cron';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const MONTH = '2036-11';
const OLD_MONTH = '2036-10';
const UNTIL_NOV = '2036-12-01T00:00:00.000Z';
/** The wallet of the players the tests seed by hand (a token needs a real implicit account). */
const ACCOUNT = NEAR_ACCOUNT(7);

beforeEach(async () => {
  for (const table of ['players', 'sign_in_refusals', 'ended_sessions']) await env.DB.exec(`DELETE FROM ${table}`);
});

/** `n` players already signed in this month (or in `month`), and `refused` accounts refused after Google. */
async function seed(n: number, refused = 0, month = MONTH): Promise<void> {
  const make = (table: string, columns: string, values: string) =>
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?1) INSERT INTO ${table} (${columns}) SELECT ${values} FROM n`;
  if (n > 0) await env.DB.prepare(make('players', 'sub, account_id, month, created_at', "'did:privy:seed-' || i, ?3, ?2, 1")).bind(n, month, ACCOUNT).run();
  if (refused > 0) await env.DB.prepare(make('sign_in_refusals', 'sub, month', "'did:privy:refused-' || i, ?2")).bind(refused, month).run();
}

const count = async (table: string, where = '1') => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n;
const rowOf = (sub: string) => env.DB.prepare('SELECT * FROM players WHERE sub = ?').bind(sub).first<{ account_id: string; month: string }>();

const exchange = (tk: string | undefined, body: unknown = { fresh: true, from: 'home' }) => api('/api/session', { token: tk, body });
const newcomer = (n: number, opts: Parameters<typeof token>[2] = {}) => token(`did:privy:new-${n}`, NEAR_ACCOUNT(100 + n), { noPlayer: true, ...opts });

describe('Sign-in data', () => {
  // spec: add-account › Sign-in data › новый игрок вошёл
  it('makes a player of this month and counts one more, and sends nothing to the network', async () => {
    await seed(10);
    const res = await exchange(await newcomer(1));
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(await rowOf('did:privy:new-1')).toMatchObject({ account_id: NEAR_ACCOUNT(101), month: MONTH });
    expect(await count('players', `month = '${MONTH}'`)).toBe(11);
    // Privy's key set only: no chain, no AI
    expect(new Set(h.net().fetched)).toEqual(new Set([env.PRIVY_JWKS_URL]));
    expect(h.events()).toEqual([{ name: 'sign_in_completed', props: { from: 'home' } }]);
    expect(h.logs()).toEqual(['session_ok']);
  });

  // spec: add-account › Sign-in data › новый игрок вошёл
  it('leaves out `from` of the event when the body does not name a known one', async () => {
    await exchange(await newcomer(1), { fresh: true, from: 'elsewhere' });
    await exchange(await newcomer(2), {});
    expect(h.events()).toEqual([
      { name: 'sign_in_completed', props: {} },
      { name: 'sign_in_completed', props: {} },
    ]);
  });

  // spec: add-account › Sign-in data › новый игрок вошёл × два входа на 479
  it('lets one of two sign-ins at 479 pass, and only one', async () => {
    await seed(479);
    const [a, b] = await Promise.all([exchange(await newcomer(1)), exchange(await newcomer(2))]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect(await count('players', `month = '${MONTH}'`)).toBe(480);
    expect(await count('sign_in_refusals')).toBe(1);
    expect([a, b].find((r) => r.status === 403)!.body).toEqual({ code: 'sign_in_refused', reason: 'mau', until: UNTIL_NOV });
  });

  // spec: add-account › Sign-in data › вход закрыт
  it('tells every browser only that sign-in is closed to new players, once 480 are in', async () => {
    await seed(479);
    expect((await api('/api/sign-in')).body).toEqual({ state: 'open' });
    await env.DB.prepare("INSERT INTO players (sub, account_id, month, created_at) VALUES ('did:privy:the-480th', 'a', ?, 1)").bind(MONTH).run();
    const visitor = await api('/api/sign-in');
    expect(visitor).toEqual({ status: 200, body: { state: 'closed_new', until: UNTIL_NOV } });
    // the same to a player with a session
    expect((await api('/api/sign-in', { token: await token('did:privy:seed-3', ACCOUNT) })).body).toEqual({ state: 'closed_new', until: UNTIL_NOV });
  });

  // spec: add-account › Sign-in data › потолок × в ответе только состояние
  it('answers nothing but the state and the time it ends', async () => {
    await seed(480, 10);
    const res = await api('/api/sign-in');
    expect(res.body).toEqual({ state: 'closed_all', until: UNTIL_NOV });
    await env.DB.exec('DELETE FROM sign_in_refusals');
    expect((await api('/api/sign-in')).body).toEqual({ state: 'closed_new', until: UNTIL_NOV });
  });

  // spec: add-account › Sign-in data › отказ после Google
  it('refuses a new player at 480, keeps their Privy id with the month, counts them, and makes no session', async () => {
    await seed(480);
    const tk = await newcomer(1);
    const res = await exchange(tk);
    expect(res).toEqual({ status: 403, body: { code: 'sign_in_refused', reason: 'mau', until: UNTIL_NOV } });
    expect(await rowOf('did:privy:new-1')).toBeNull();
    expect((await env.DB.prepare('SELECT * FROM sign_in_refusals').first())).toEqual({ sub: 'did:privy:new-1', month: MONTH });
    expect(h.events()).toEqual([{ name: 'sign_in_blocked', props: { step: 'after_google', reason: 'mau', from: 'home' } }]);
    // the log says the code and nothing of the player
    expect(h.logs()).toEqual(['session_refused:mau']);
    // the token opens nothing
    expect((await api('/api/hatch', { token: tk })).status).toBe(401);
  });

  // spec: add-account › Sign-in data › отказ после Google × второй отказ в месяце
  it('counts one account once a month, however often it comes back', async () => {
    await seed(480);
    const tk = await newcomer(1);
    await exchange(tk);
    await exchange(tk);
    await exchange(await newcomer(1, { sid: 'another' }));
    expect(await count('sign_in_refusals')).toBe(1);
    await exchange(await newcomer(2));
    expect(await count('sign_in_refusals')).toBe(2);
  });

  // spec: add-account › Sign-in data › отказ после Google × запрос с токеном без строки
  it('answers 401 to any request with a token of a player the server has no row of', async () => {
    const tk = await newcomer(1);
    for (const path of ['/api/hatch', '/api/pets/1', '/api/session/end']) {
      const res = await api(path, { token: tk, method: path.endsWith('end') ? 'POST' : 'GET' });
      expect(res, path).toEqual({ status: 401, body: { code: 'signed_out' } });
    }
    expect(await count('players')).toBe(0);
  });

  // spec: add-account › Sign-in data › отказ после Google × токен без строки и без fresh
  it('judges a token with no row as a sign-in even when the body says it is not fresh', async () => {
    await seed(480);
    const res = await exchange(await newcomer(1), { fresh: false });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('mau');
    // and with room, it is let in as a new player
    await env.DB.exec('DELETE FROM players');
    expect((await exchange(await newcomer(2), { fresh: false })).status).toBe(200);
    expect(await rowOf('did:privy:new-2')).toMatchObject({ month: MONTH });
  });

  // spec: add-account › Sign-in data › потолок
  it('closes sign-in to everyone at 490, a player of this month and one of last month alike', async () => {
    await seed(480, 10);
    expect((await api('/api/sign-in')).body).toEqual({ state: 'closed_all', until: UNTIL_NOV });
    const returning = await exchange(await token('did:privy:seed-5', ACCOUNT));
    expect(returning).toEqual({ status: 403, body: { code: 'sign_in_refused', reason: 'ceiling', until: UNTIL_NOV } });
    await env.DB.prepare("INSERT INTO players (sub, account_id, month, created_at) VALUES ('did:privy:last-month', 'a', ?, 1)").bind(OLD_MONTH).run();
    const old = await exchange(await token('did:privy:last-month', ACCOUNT));
    expect(old.body.reason).toBe('ceiling');
    const fresh = await exchange(await newcomer(1));
    expect(fresh.body.reason).toBe('ceiling');
    // a player already counted as signed in is not counted again as refused
    expect(await count('sign_in_refusals')).toBe(10 + 2);
    expect(h.events().map((e) => e.props.reason)).toEqual(['ceiling', 'ceiling', 'ceiling']);
  });

  // spec: add-account › Sign-in data › потолок
  it('closes sign-in to everyone at 490 counted as 480 signed in and 10 refused, and not before', async () => {
    await seed(480, 9);
    expect((await api('/api/sign-in')).body.state).toBe('closed_new');
    await seed(0);
    await env.DB.prepare("INSERT INTO sign_in_refusals (sub, month) VALUES ('did:privy:the-10th', ?)").bind(MONTH).run();
    expect((await api('/api/sign-in')).body.state).toBe('closed_all');
  });

  // spec: add-account › Sign-in data › потолок × живая сессия закрытого месяца
  it('lets a live session play on when sign-in is closed, and counts it past 480', async () => {
    await seed(480, 10);
    await env.DB.prepare("INSERT INTO players (sub, account_id, month, created_at) VALUES ('did:privy:live', 'a', ?, 1)").bind(OLD_MONTH).run();
    const tk = await token('did:privy:live', ACCOUNT);
    // the page loads: not a sign-in
    expect(await exchange(tk, { fresh: false })).toEqual({ status: 200, body: { ok: true } });
    expect((await rowOf('did:privy:live'))!.month).toBe(MONTH);
    expect(await count('players', `month = '${MONTH}'`)).toBe(481);
    expect(h.events()).toEqual([]);
    // and its requests
    expect((await api('/api/hatch', { token: tk })).status).toBe(200);
  });

  // spec: add-account › Sign-in data › потолок × живая сессия нового месяца
  it('moves a player to the new month at the first request with a session, with no cap', async () => {
    await env.DB.prepare("INSERT INTO players (sub, account_id, month, created_at) VALUES ('did:privy:live', 'a', ?, 1)").bind(OLD_MONTH).run();
    const tk = await token('did:privy:live', ACCOUNT); // the row stays: token() only seeds a missing one
    expect((await rowOf('did:privy:live'))!.month).toBe(OLD_MONTH);
    expect((await api('/api/hatch', { token: tk })).status).toBe(200);
    expect((await rowOf('did:privy:live'))!.month).toBe(MONTH);
  });

  // spec: add-account › Sign-in data › уже входил
  it('opens the session of a player who was in this month while sign-in is closed to new players, without counting', async () => {
    await seed(480);
    const res = await exchange(await token('did:privy:seed-9', ACCOUNT));
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(await count('players', `month = '${MONTH}'`)).toBe(480);
    expect(await count('sign_in_refusals')).toBe(0);
    expect(h.events()).toEqual([{ name: 'sign_in_completed', props: { from: 'home' } }]);
  });

  // spec: add-account › Sign-in flow › вернувшийся входит
  it('lets a returning player through Google when there is no ceiling, as any sign-in', async () => {
    await seed(480, 5);
    const res = await exchange(await token('did:privy:seed-1', ACCOUNT), { fresh: true, from: 'link' });
    expect(res.status).toBe(200);
    expect(h.events()).toEqual([{ name: 'sign_in_completed', props: { from: 'link' } }]);
    // a player of last month, signing in again while it is closed to new players, is not «returning»
    await env.DB.prepare("INSERT INTO players (sub, account_id, month, created_at) VALUES ('did:privy:last-month', 'a', ?, 1)").bind(OLD_MONTH).run();
    const old = await exchange(await token('did:privy:last-month', ACCOUNT));
    expect(old.body.reason).toBe('mau');
    expect((await rowOf('did:privy:last-month'))!.month).toBe(OLD_MONTH);
  });

  // spec: add-account › Sign-in data › уже входил
  it('lets a player of last month in as a new one while there is room, and moves their month', async () => {
    await seed(100);
    await env.DB.prepare("INSERT INTO players (sub, account_id, month, created_at) VALUES ('did:privy:last-month', 'a', ?, 1)").bind(OLD_MONTH).run();
    expect((await exchange(await token('did:privy:last-month', ACCOUNT))).status).toBe(200);
    expect((await rowOf('did:privy:last-month'))!.month).toBe(MONTH);
    expect(await count('players', `month = '${MONTH}'`)).toBe(101);
  });

  // spec: add-account › Sign-in data › новый месяц
  it('starts the count from zero on the 1st: refusals of the past month are erased and sign-in is open', async () => {
    await seed(480, 10);
    expect((await api('/api/sign-in')).body.state).toBe('closed_all');
    vi.setSystemTime(new Date('2036-12-01T00:00:00Z'));
    expect((await api('/api/sign-in')).body).toEqual({ state: 'open' });
    await clean(env, Date.now());
    expect(await count('sign_in_refusals')).toBe(0);
    // a refusal of the new month stays
    await env.DB.prepare("INSERT INTO sign_in_refusals (sub, month) VALUES ('did:privy:x', '2036-12')").run();
    await clean(env, Date.now());
    expect(await count('sign_in_refusals')).toBe(1);
    // the player of November comes back as a new one in December
    const res = await exchange(await token('did:privy:seed-2', ACCOUNT, { noPlayer: true }));
    expect(res.status).toBe(200);
    expect((await rowOf('did:privy:seed-2'))!.month).toBe('2036-12');
  });

  // spec: add-account › Sign-in data › новый месяц
  it('uses the UTC month at the edge of the month', async () => {
    await seed(480);
    vi.setSystemTime(new Date('2036-11-30T23:59:59Z'));
    expect((await api('/api/sign-in')).body.state).toBe('closed_new');
    vi.setSystemTime(new Date('2036-12-01T00:00:00Z'));
    expect((await api('/api/sign-in')).body.state).toBe('open');
  });

  // spec: add-account › Sign-in data › уже входил
  it('answers an exchange without a token or with a token nobody could judge', async () => {
    expect((await exchange(undefined)).status).toBe(401);
    expect((await exchange('not-a-token')).status).toBe(401);
    // jose will not fetch the key set again within 30 s of its last fetch, and earlier tests moved the
    // clock to December: this test goes past that, so an unknown key makes it fetch (and fail).
    vi.setSystemTime(new Date('2037-06-01T00:00:00Z'));
    const tk = await newcomer(1, { kid: 'rotated' });
    h.net().jwks.status = 500;
    expect(await exchange(tk)).toEqual({ status: 503, body: { code: 'auth_unavailable' } });
  });

  // spec: add-account › Sign-in data › новый игрок вошёл
  it('is outside the request limit: the exchange is not counted', async () => {
    const tk = await newcomer(1);
    expect((await exchange(tk)).status).toBe(200);
    for (let i = 0; i < 125; i += 1) expect((await exchange(tk, { fresh: false })).status).toBe(200);
  });
});

describe('Sign-out data', () => {
  const player = (sid: string | null, sub = 'did:privy:owner') => token(sub, NEAR_ACCOUNT(1), { sid });
  const end = (tk: string) => api('/api/session/end', { method: 'POST', token: tk });

  // spec: add-account › Sign-out data › second tab
  it('refuses the ended session in every tab of the browser, at once', async () => {
    const tabA = await player('sid-1');
    const tabB = await player('sid-1'); // another token of the same session
    expect((await api('/api/hatch', { token: tabB })).status).toBe(200);
    expect((await end(tabA)).status).toBe(204);
    expect((await env.DB.prepare('SELECT sid, ended_at FROM ended_sessions').first())).toEqual({ sid: 'sid-1', ended_at: Date.now() });
    for (const tk of [tabA, tabB]) {
      expect(await api('/api/hatch', { token: tk })).toEqual({ status: 401, body: { code: 'signed_out' } });
      expect((await exchange(tk, { fresh: false })).status).toBe(401);
    }
    // nothing about the player is in the record
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM ended_sessions').all())).not.toMatch(/owner|did:privy/);
  });

  // spec: add-account › Sign-out data › second tab × токен другого устройства
  it('leaves the session of another device untouched', async () => {
    const here = await player('sid-here');
    const other = await player('sid-other');
    await end(here);
    expect((await api('/api/hatch', { token: other })).status).toBe(200);
    expect((await exchange(other, { fresh: false })).status).toBe(200);
  });

  // spec: add-account › Sign-out data › signed in again
  it('accepts the new session of the same player within the 24 hours', async () => {
    await end(await player('sid-1'));
    vi.setSystemTime(Date.now() + 23 * 3_600_000);
    const again = await player('sid-2');
    expect(await exchange(again, { fresh: true, from: 'link' })).toEqual({ status: 200, body: { ok: true } });
    expect((await api('/api/hatch', { token: again })).status).toBe(200);
  });

  // spec: add-account › Sign-out data › second tab
  it('records nothing for a token with no session id, and says so by a code', async () => {
    const tk = await player(null);
    expect((await end(tk)).status).toBe(204);
    expect(await count('ended_sessions')).toBe(0);
    expect(h.logs()).toContain('session_no_sid');
    expect((await api('/api/hatch', { token: tk })).status).toBe(200);
  });

  // spec: add-account › Sign-out data › second tab
  it('keeps no sid or player id in the logs', async () => {
    const tk = await player('sid-secret');
    await end(tk);
    await api('/api/hatch', { token: tk });
    await exchange(tk, { fresh: true });
    expect(h.logs().join('\n')).not.toMatch(/sid-secret|did:privy|owner/);
  });

  // spec: add-account › Sign-in data › новый месяц
  it('erases an ended session 24 hours after the sign-out and not before', async () => {
    await end(await player('sid-old'));
    vi.setSystemTime(Date.now() + 3_600_000);
    await end(await player('sid-new', 'did:privy:other'));
    vi.setSystemTime(Date.now() + 23 * 3_600_000 + 1);
    await clean(env, Date.now());
    expect((await env.DB.prepare('SELECT sid FROM ended_sessions').all()).results).toEqual([{ sid: 'sid-new' }]);
  });
});

describe('Sign-out flow', () => {
  // spec: add-account › Sign-out flow › вышел × мысль в пути
  it('finishes and debits a thought that was on its way when the player signed out', async () => {
    h.net().contract.addPet('5', NEAR_ACCOUNT(1));
    const tk = await token('did:privy:owner', NEAR_ACCOUNT(1), { sid: 'sid-1' });
    const sent = await api('/api/pets/5/thoughts', { token: tk, body: { text: 'Hi there', mode: 'chat' } });
    expect(sent.status).toBe(202);
    expect((await api('/api/session/end', { method: 'POST', token: tk })).status).toBe(204);
    for (let i = 0; i < 1000; i += 1) {
      const row = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(sent.body.job).first<{ status: string }>();
      if (row !== null && row.status !== 'queued' && row.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(sent.body.job).first()).toEqual({ status: 'done' });
    expect(await env.DB.prepare("SELECT reply_text, status FROM thoughts WHERE token_id = '5'").first()).toEqual({ reply_text: 'Hello there, friend.', status: 'unbilled' });
    // the owner's pet and its thought are still there for the next sign-in
    const next = await token('did:privy:owner', NEAR_ACCOUNT(1), { sid: 'sid-2' });
    expect((await api('/api/pets/5', { token: next })).body).toMatchObject({ viewer: 'owner' });
  });
});
