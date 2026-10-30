// State a test hands to the fakes before the page loads (Playwright's addInitScript). Fakes exist
// only in the e2e mode (VITE_FAKES); no dev or prod build contains this file's users.
import type { ClosedReason, HatchStatus, Me, PetBase, PetState, Conversation } from './worker-types';

/** An answer the fake gives instead of a value: the Worker's refusal (status 0 — it never answered). */
export interface FakeFail {
  fail: { status: number; code: string };
}

export interface FakeWorkerState {
  version?: string;
  /** the wait before «Still working on it…» (ms), instead of the spec's 10 s */
  waitLineMs?: number;
  /** every answer waits this long (ms), unless its own `*DelayMs` says otherwise */
  delayMs?: number;
  /** `GET /api/hatch`; default `{ open: true }` */
  hatchStatus?: HatchStatus | FakeFail;
  hatchStatusDelayMs?: number;
  /** `POST /api/hatch`; default `{ tokenId: '9' }`. A name with no visible character is `name_rejected` as the
   *  real server answers it (the list's words never enter the repo). */
  hatchResult?: { tokenId: string } | FakeFail;
  hatchDelayMs?: number;
  me?: Me | FakeFail;
  /** the pets the fake knows, by token_id */
  pets?: Record<string, PetBase & { owner?: Partial<Omit<Extract<import('./worker-types').PetView, { viewer: 'owner' }>, keyof PetBase | 'viewer'>> }>;
  /** `GET /api/pets/:id` refused (the server, the network, the rate limit) instead of answering */
  petResult?: FakeFail;
  /** the token_ids the signed-in fake player owns: those answer with the owner's view, the rest with the guest's */
  owned?: string[];
  /** `GET …/state`; default the owner's view of the pet */
  petState?: Partial<PetState> | FakeFail;
  conversation?: Conversation | FakeFail;
  /** `POST …/thoughts` and `…/greeting`; default `{ job: 'job-1' }` */
  say?: { job: string } | FakeFail;
  greeting?: { job: string | null } | FakeFail;
  /** `POST …/wake`; default `{ job: 'job-wake' }` */
  retryWake?: { job: string | null } | FakeFail;
  /** a token is no session any more: every request that carries one is a 401, as the Worker answers */
  sessionExpired?: boolean;
}

export interface FakeState {
  auth?: { authenticated?: boolean; nearAccountId?: string | null; identityToken?: string | null };
  /** `hold`: every pet stands on its still, whatever the viewer chose. Software GL can't play pets for every test. */
  pet?: { hold?: boolean };
  rpc?: { viewResult?: unknown; balanceYocto?: string; txHash?: string; txOk?: boolean };
  worker?: FakeWorkerState;
}

export function fakeState(): FakeState {
  return (globalThis as { __NEARLING_FAKES__?: FakeState }).__NEARLING_FAKES__ ?? {};
}

/** What the fakes were asked, in order — `globalThis.__NEARLING_CALLS__`, for a test to read: `worker:hatch`,
 *  `privy:load`, `privy:login`… A fake that never runs in a dev or prod build writes it; nothing reads it there. */
export function recordCall(name: string): void {
  const g = globalThis as { __NEARLING_CALLS__?: string[] };
  (g.__NEARLING_CALLS__ ??= []).push(name);
}

export type { ClosedReason };
