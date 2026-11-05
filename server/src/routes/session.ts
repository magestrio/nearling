// The session: the exchange after Google (`POST /api/session`), the sign-out record (`POST
// /api/session/end`, ADR-022) and the question of the closed sign-in (`GET /api/sign-in`).
import { Hono } from 'hono';
import { identify } from '../auth';
import { requireSession, type AppEnv } from '../http';
import { checkJudgeCode, redeemJudgeCode } from '../judge';
import { feederName } from '../name/first';
import { admit, countsOf, monthOf, nextMonthStart, stateOf } from '../signin';
import { track } from '../track';

/** `POST /api/session` stands outside `gate`: it is the call that makes a player's row, and the
 * exchange is not in the request limit (Guest view data). Registered before `gate` in `index.ts`. */
export const exchangeRoutes = new Hono<AppEnv>();

/** Everything else of the session, behind `gate`. */
export const sessionRoutes = new Hono<AppEnv>();

type From = 'link' | 'home';

exchangeRoutes.post('/api/session', async (c) => {
  // The order of the decision: the token -> the ended session -> the row (design.md › Решения).
  const identity = await identify(c.req.raw, c.env);
  if (identity.kind === 'unavailable') return c.json({ code: 'auth_unavailable' }, 503);
  if (identity.kind !== 'session') return c.json({ code: 'signed_out' }, 401);
  const { sub, accountId, tokenHash, name } = identity.session;
  const db = c.env.DB;
  // The feeder's first name (`Feeder identity data`): kept on every `ok` answer, NULL when it does
  // not pass or the token has none. The row exists by then (a new one was made by `admit`).
  const rememberName = () => db.prepare('UPDATE players SET first_name = ?1 WHERE sub = ?2').bind(feederName(name, c.env.INSULT_LIST), sub).run();

  const ended = await db.prepare('SELECT 1 AS found FROM ended_sessions WHERE sid = ?').bind(tokenHash).first();
  if (ended !== null) return c.json({ code: 'signed_out' }, 401);

  const body = await c.req.json<{ fresh?: unknown; from?: unknown; judgeCode?: unknown }>().catch(() => null);
  const fresh = body?.fresh === true;
  const judgeCode = typeof body?.judgeCode === 'string' ? body.judgeCode : null;
  const from: From | null = body?.from === 'link' || body?.from === 'home' ? body.from : null;
  const now = Date.now();
  const month = monthOf(now);
  const row = await db.prepare('SELECT month FROM players WHERE sub = ?').bind(sub).first<{ month: string }>();

  // Not a sign-in: a player with a row loading the page. The month moves, with no cap.
  if (row !== null && !fresh) {
    if (row.month !== month) await db.prepare('UPDATE players SET month = ?1 WHERE sub = ?2 AND month <> ?1').bind(month, sub).run();
    await rememberName();
    console.log('session_ok');
    return c.json({ ok: true });
  }

  // A sign-in: a pass of Google, or a token that has no row.
  const counted = row?.month === month;
  const refuse = async (reason: 'mau' | 'ceiling') => {
    // A refused account is counted once a month; one already counted as signed in is not counted again.
    if (!counted) await db.prepare('INSERT OR IGNORE INTO sign_in_refusals (sub, month) VALUES (?, ?)').bind(sub, month).run();
    track('sign_in_blocked', { step: 'after_google', reason, ...(from === null ? {} : { from }) });
    console.log(`session_refused:${reason}`);
    return c.json({ code: 'sign_in_refused', reason, until: nextMonthStart(now) }, 403);
  };
  const welcome = async () => {
    await rememberName();
    track('sign_in_completed', from === null ? {} : { from });
    console.log('session_ok');
    return c.json({ ok: true });
  };

  const state = stateOf(await countsOf(db, month));
  // At the ceiling even a player of this month is refused (`Sign-in flow` › «закрылся для всех после Google»).
  if (state === 'closed_all') return refuse('ceiling');
  if (counted) return welcome();
  if (state === 'closed_new') {
    if (judgeCode === null) return refuse('mau');
    const result = await redeemJudgeCode(db, judgeCode, sub, accountId, month, now, row !== null);
    if (result === 'ok') return welcome();
    const again = await db.prepare('SELECT month FROM players WHERE sub = ?').bind(sub).first<{ month: string }>();
    if (again?.month === month) return welcome();
    if (result === 'ceiling' || result === 'mau') return refuse(result);
    if (!counted) await db.prepare('INSERT OR IGNORE INTO sign_in_refusals (sub, month) VALUES (?, ?)').bind(sub, month).run();
    console.log('session_refused:judge_code');
    return c.json({ code: result }, 403);
  }
  if (await admit(db, sub, accountId, month, now, row !== null)) return welcome();

  // The statement changed nothing: the month moved under it. Read again and answer by what is there.
  const again = await db.prepare('SELECT month FROM players WHERE sub = ?').bind(sub).first<{ month: string }>();
  if (again?.month === month) return welcome();
  return refuse(stateOf(await countsOf(db, month)) === 'closed_all' ? 'ceiling' : 'mau');
});

// «Sign out» on the server: this exact identity token is refused from now on.
sessionRoutes.post('/api/session/end', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  await c.env.DB.prepare('INSERT OR REPLACE INTO ended_sessions (sid, ended_at) VALUES (?, ?)').bind(session.tokenHash, Date.now()).run();
  return c.body(null, 204);
});

// The state of the sign-in for the browser, before Google. Nothing about players.
sessionRoutes.get('/api/sign-in', async (c) => {
  const now = Date.now();
  const state = stateOf(await countsOf(c.env.DB, monthOf(now)));
  return c.json(state === 'open' ? { state } : { state, until: nextMonthStart(now) });
});

// Public, body-only pre-Google check. The ordinary guest gate applies and this reserves nothing.
sessionRoutes.post('/api/judge/check', async (c) => {
  const body = await c.req.json<{ code?: unknown }>().catch(() => null);
  const code = typeof body?.code === 'string' ? body.code : '';
  try {
    const result = await checkJudgeCode(c.env.DB, code);
    return result === 'ok' ? c.json({ ok: true }) : c.json({ code: result }, 403);
  } catch {
    return c.json({ code: 'judge_unavailable' }, 503);
  }
});
