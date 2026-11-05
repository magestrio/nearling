// Who is calling. The browser sends Privy's identity token in the `privy-id-token` header; the
// Worker checks it against the app's JWKS (the key by its `kid`), the issuer and the audience, and
// reads the player's NEAR account from the token's `linked_accounts`. The token is the session:
// it ends when Privy stops renewing it (design.md › Решения › «Сессия игрока»).
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const TOKEN_HEADER = 'privy-id-token';

export interface Session {
  /** The Privy user id (`did:privy:…`): opaque, the key of the per-player request count. */
  sub: string;
  /** The embedded wallet's NEAR implicit account: 64 lowercase hex. */
  accountId: string;
  /** SHA-256 of the exact verified identity token, used only to reject this token after sign-out. */
  tokenHash: string;
  /** The Google name as the `google_oauth` entry of `linked_accounts` carries it, unchecked. Only
   * `POST /api/session` reads it (`Feeder identity data`); it is never logged. `null`: none. */
  name: string | null;
}

export type Identity =
  | { kind: 'none' }
  | { kind: 'invalid' }
  // Privy's key set could not be had: the token was not judged. Not the end of a session.
  | { kind: 'unavailable' }
  | { kind: 'session'; session: Session };

/** What jose says about a token itself. Anything else (a fetch that failed, a non-200, a timeout, a
 * broken key set) is about the key set. */
const BAD_TOKEN = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JWKS_NO_MATCHING_KEY',
]);

const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

// jose caches the fetched key set inside the function it returns; one per JWKS url per isolate.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySetFor(url: string) {
  let set = keySets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    keySets.set(url, set);
  }
  return set;
}

interface LinkedAccount {
  type?: unknown;
  chain_type?: unknown;
  address?: unknown;
  name?: unknown;
}

/** The first NEAR wallet among the token's linked accounts: `{ type: 'wallet', chain_type: 'near',
 * address }` (Privy identity tokens carry `linked_accounts` as a stringified array). */
/** What a refused token held, for the log: kinds and chains, never an address, an email or the token. */
function shapeOf(linkedAccounts: unknown): string {
  if (typeof linkedAccounts !== 'string') return typeof linkedAccounts;
  try {
    const list = JSON.parse(linkedAccounts) as LinkedAccount[];
    return list.map((a) => `${String(a?.type)}:${String(a?.chain_type)}:${typeof a?.address === 'string' ? a.address.length : '-'}`).join(' ');
  } catch {
    return 'unreadable';
  }
}

function nearAccountOf(linkedAccounts: unknown): string | null {
  if (typeof linkedAccounts !== 'string') return null;
  let list: unknown;
  try {
    list = JSON.parse(linkedAccounts);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  for (const entry of list as LinkedAccount[]) {
    if (entry?.type === 'wallet' && entry.chain_type === 'near' && typeof entry.address === 'string') {
      return IMPLICIT_ACCOUNT.test(entry.address) ? entry.address : null;
    }
  }
  return null;
}

/** The name of the Google sign-in among the token's linked accounts, as sent. */
function googleNameOf(linkedAccounts: unknown): string | null {
  if (typeof linkedAccounts !== 'string') return null;
  try {
    const list = JSON.parse(linkedAccounts) as LinkedAccount[];
    if (!Array.isArray(list)) return null;
    const entry = list.find((a) => a?.type === 'google_oauth');
    return typeof entry?.name === 'string' ? entry.name : null;
  } catch {
    return null;
  }
}

export async function identify(req: Request, env: Pick<Env, 'PRIVY_APP_ID' | 'PRIVY_JWKS_URL'>): Promise<Identity> {
  const token = req.headers.get(TOKEN_HEADER);
  if (token === null || token === '') return { kind: 'none' };
  try {
    const { payload } = await jwtVerify(token, keySetFor(env.PRIVY_JWKS_URL), {
      issuer: 'privy.io',
      audience: env.PRIVY_APP_ID,
      algorithms: ['ES256'],
    });
    const accountId = nearAccountOf(payload['linked_accounts']);
    if (typeof payload.sub !== 'string' || accountId === null) {
      console.log('auth refused · no NEAR wallet ·', shapeOf(payload['linked_accounts']));
      return { kind: 'invalid' };
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return { kind: 'session', session: { sub: payload.sub, accountId, tokenHash, name: googleNameOf(payload['linked_accounts']) } };
  } catch (e) {
    // A bad signature, an expired token, a wrong audience: no session.
    const code = (e as { code?: string } | null)?.code ?? '';
    console.log('auth refused ·', code || 'no code');
    return BAD_TOKEN.has(code) ? { kind: 'invalid' } : { kind: 'unavailable' };
  }
}
