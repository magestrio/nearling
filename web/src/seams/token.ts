// The identity token as the app asks for it. Privy's `getIdentityToken` calls Privy (`GET users/me`) every time, and the
// page asks before every request: one call per poll, and a slow Privy would read as «Can't reach {name}…». So the token
// is kept until a minute before it ends. Nothing here is stored: it lives in the tab's memory.
const SPARE_MS = 60_000;
const RETRY_DELAYS_MS = [600, 1_500, 3_000];
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** When the JWT ends, ms since the epoch; null when it can't be read (then it is not kept). */
export function tokenEnds(token: string): number | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const { exp } = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Privy refused the session (it ended, or was signed out in another tab). A network failure is no such thing. */
export function isSessionEnded(e: unknown): boolean {
  const { status, privyErrorCode } = (e ?? {}) as { status?: unknown; privyErrorCode?: unknown };
  return status === 401 || status === 403 || privyErrorCode === 'missing_or_invalid_token' || privyErrorCode === 'must_be_authenticated';
}

/** A provider or Worker read that may succeed when the connection or rate limit recovers. */
export function isTransientAuthError(e: unknown): boolean {
  if (isSessionEnded(e)) return false;
  const { status, type, privyErrorCode } = (e ?? {}) as { status?: unknown; type?: unknown; privyErrorCode?: unknown };
  if (typeof status === 'number') return status === 0 || status === 429 || (status >= 500 && status < 600);
  return e instanceof TypeError || type === 'client_error' || privyErrorCode === 'client_request_timeout';
}

async function askWithRetry(ask: () => Promise<string | null>): Promise<string | null> {
  for (const delay of RETRY_DELAYS_MS) {
    try { return await ask(); }
    catch (error) {
      if (!isTransientAuthError(error)) throw error;
      await wait(delay);
    }
  }
  return ask();
}

export interface TokenKeeper {
  /** The token, or null when the session has ended; rejects when Privy could not be asked. */
  get(): Promise<string | null>;
  /** The next `get` asks Privy: the player changed, or their token no longer says what is true (a new wallet). */
  forget(): void;
}

export function makeTokenKeeper(ask: () => Promise<string | null>, now: () => number = Date.now): TokenKeeper {
  let held: { token: string; ends: number } | null = null;
  let asking: Promise<string | null> | null = null;
  // An ask that began before a `forget` carries the old player's token (or the one before the wallet): it still answers
  // its own callers, but it keeps nothing.
  let generation = 0;
  return {
    get() {
      if (held !== null && held.ends - now() > SPARE_MS) return Promise.resolve(held.token);
      if (asking === null) {
        const mine = generation;
        const own: Promise<string | null> = askWithRetry(ask)
          .then((token) => {
            const ends = token === null ? null : tokenEnds(token);
            if (mine === generation) held = token !== null && ends !== null ? { token, ends } : null;
            return token;
          })
          .catch((e: unknown) => {
            if (mine === generation) held = null;
            if (isSessionEnded(e)) return null;
            throw e;
          })
          .finally(() => {
            if (asking === own) asking = null;
          });
        asking = own;
      }
      return asking;
    },
    forget() {
      generation += 1;
      held = null;
      asking = null;
    },
  };
}
