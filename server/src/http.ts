// The shared front of every /api route: who is calling and the request limits.
//
// The order of a route's checks (design.md › Worker): the request limit -> the session -> the input
// -> the network (`pet_view`, never cached) -> the owner -> the pause -> PetDesk. The limit's key
// is the player when there is a valid session and the IP otherwise, so the token is read first;
// nothing else is done before the limit.
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { identify, type Session } from './auth';
import { monthOf } from './signin';

export type AppEnv = { Bindings: Env; Variables: { session: Session | null } };
export type AppContext = Context<AppEnv>;

/** Requests a minute: from one IP without a session, and from one player with all their sessions
 * (Guest view data, Session request limit data). */
export const REQUESTS_PER_MINUTE = 120;

export const gate = createMiddleware<AppEnv>(async (c, next) => {
  const identity = await identify(c.req.raw, c.env);
  const key =
    identity.kind === 'session' ? `player:${identity.session.sub}` : `ip:${c.req.header('cf-connecting-ip') ?? 'unknown'}`;
  const counter = c.env.LIMITER.get(c.env.LIMITER.idFromName(key));
  // The excess is turned away before any network read, reservation or event.
  if (!(await counter.hit(Math.floor(Date.now() / 60_000), REQUESTS_PER_MINUTE))) {
    return c.json({ code: 'rate_limited' }, 429);
  }
  // A token that does not verify is no session: the client shows the signed-out view.
  if (identity.kind === 'invalid') return c.json({ code: 'signed_out' }, 401);
  // A token nobody could judge: the player stays signed in and sees `Connection rule`.
  if (identity.kind === 'unavailable') return c.json({ code: 'auth_unavailable' }, 503);
  if (identity.kind === 'session') {
    // A valid token alone opens nothing: the player needs a row (the exchange of `POST /api/session`
    // made it) and a session that was not ended by a sign-out (ADR-022).
    const { sub, sid } = identity.session;
    const row = await c.env.DB.prepare('SELECT month, EXISTS (SELECT 1 FROM ended_sessions WHERE sid = ?1) AS ended FROM players WHERE sub = ?2')
      .bind(sid, sub)
      .first<{ month: string; ended: number }>();
    if (row === null || row.ended === 1) return c.json({ code: 'signed_out' }, 401);
    // A request with a session counts as played this month, with no cap: the session is alive.
    const month = monthOf(Date.now());
    if (row.month !== month) await c.env.DB.prepare('UPDATE players SET month = ?1 WHERE sub = ?2 AND month <> ?1').bind(month, sub).run();
  }
  c.set('session', identity.kind === 'session' ? identity.session : null);
  await next();
  return undefined;
});

export function requireSession(c: AppContext): Session | Response {
  const session = c.get('session');
  return session ?? c.json({ code: 'signed_out' }, 401);
}

export const TOKEN_ID = /^\d{1,20}$/;

/** The UTC day number (days since the epoch) of a time in milliseconds. */
export function utcDay(ms: number): number {
  return Math.floor(ms / 86_400_000);
}
