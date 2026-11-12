// Dev builds only (VITE_DEV_ROUTE): a Privy test account signs in instead of Google, so a script can drive the dev game
// (Google refuses automated sign-in). The credentials are put into this browser's storage by hand or by the script; a
// production build has this branch as dead code and never reads them (`scripts/check-prod-build.mjs`).
export const TEST_LOGIN_KEY = 'nearling.testLogin';

export type TestLogin = { email: string; code: string } | { phone: string; code: string };

export function readTestLogin(): TestLogin | null {
  if (import.meta.env.VITE_DEV_ROUTE !== 'true') return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(TEST_LOGIN_KEY);
  } catch {
    return null; // storage blocked: Google as usual
  }
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null; // not a test login: Google as usual
  }
  const v = value as Record<string, unknown> | null;
  if (typeof v?.code !== 'string') return null;
  if (typeof v.email === 'string') return { email: v.email, code: v.code };
  if (typeof v.phone === 'string') return { phone: v.phone, code: v.code };
  return null;
}
