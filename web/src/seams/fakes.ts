// State a test hands to the fakes before the page loads (Playwright's addInitScript). Fakes exist
// only in the e2e mode (VITE_FAKES); no dev or prod build contains this file.
export interface FakeState {
  auth?: { authenticated?: boolean; nearAccountId?: string | null; identityToken?: string | null };
  rpc?: { viewResult?: unknown; balanceYocto?: string; txHash?: string; txOk?: boolean };
  worker?: { version?: string };
}

export function fakeState(): FakeState {
  return (globalThis as { __NEARLING_FAKES__?: FakeState }).__NEARLING_FAKES__ ?? {};
}
