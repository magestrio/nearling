// State a test hands to the fakes before the page loads (Playwright's addInitScript). Fakes exist
// only in the e2e mode (VITE_FAKES); no dev or prod build contains this file's users.
import type {
  ClosedReason,
  Conversation,
  DiaryView,
  FeedOutcome,
  FeedSheetData,
  HatchStatus,
  Me,
  MyFeed,
  PetBase,
  PetState,
  RiddleStatus,
  SessionResult,
  SignInGate,
  WalletInfo,
} from './worker-types';

/** An answer the fake gives instead of a value: the Worker's refusal (status 0 — it never answered). */
export interface FakeFail {
  /** `body`: the few refusals that carry more than a code (`409 short` and `409 snack_gone` hold the sheet) */
  fail: { status: number; code: string; body?: unknown };
}

export interface FakeWorkerState {
  version?: string;
  /** the wait before «Still working on it…» (ms), instead of the spec's 10 s */
  waitLineMs?: number;
  /** a Toast stays until the page goes (a capture of its frame takes seconds on software GL) */
  toastHeld?: boolean;
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
  pets?: Record<string, PetBase & Partial<MyFeed> & { owner?: Partial<Omit<Extract<import('./worker-types').PetView, { viewer: 'owner' }>, keyof PetBase | keyof MyFeed | 'viewer'>> }>;
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
  /** the exchange of the page load answers `200`, and every request after it that carries a token is a 401: a session that
   *  ended between the exchange and the page's first request (`Session expiry flow` › `401 на первой загрузке`) */
  expiredAfterExchange?: boolean;
  /** `POST /api/session`; default `{ ok: true }` */
  session?: SessionResult | FakeFail;
  /** `POST /api/session/end` refused or never answered instead of `204` */
  endSession?: FakeFail;
  /** `GET /api/sign-in`; default `{ state: 'open' }` */
  signIn?: SignInGate | FakeFail;
  /** `POST …/memory/clear`; default `{ ok: true }` */
  clearMemory?: { ok: true } | FakeFail;
  clearMemoryDelayMs?: number;
  /** `GET …/feed`: fields laid over the sheet the fake builds from the pet and the viewer (default: three portions at 5¢ / 23¢ /
   *  92¢, 0.31 NEAR in the wallet, a free snack where `Snack rule` gives one); `{ chain: false }` or a refusal instead */
  feedSheet?: Partial<FeedSheetData> | { chain: false } | FakeFail;
  feedSheetDelayMs?: number;
  /** `POST …/feed`; default a real `pet_feed` transaction built by near-api-js for the pet and the portion asked */
  buildFeed?: { tx: string } | FakeFail;
  /** `POST …/feed/send`; default `{ status: 'ok', hatched: true }` */
  sendFeed?: FeedOutcome | FakeFail;
  /** the send is held this long (ms): the frame of a meal on its way */
  feedSendDelayMs?: number;
  /** `POST …/feed/outcome`; default `{ status: 'ok', hatched: true }` */
  feedOutcome?: FeedOutcome | FakeFail;
  /** `POST …/snack`; default `{ status: 'ok', hatched: true }` */
  snack?: FeedOutcome | FakeFail;
  /** `GET /api/wallet`; default the address of the fake account with 0.31 NEAR */
  wallet?: WalletInfo | FakeFail;
  /** `GET …/diary`: fields laid over the sample diary the fake builds (an open riddle, an entry with its question, a streak of 2 with
   *  one freeze), or a refusal instead. The owner only: another viewer is a `403 not_owner`. */
  diary?: Partial<DiaryView> | FakeFail;
  diaryDelayMs?: number;
  /** `POST …/diary/read`; default `{ ok: true }` */
  readDiary?: { ok: true } | FakeFail;
  /** `POST …/diary/answer`; default `{ job: 'job-question' }` */
  answerQuestion?: { job: string } | FakeFail;
  /** `POST …/riddle`; default `{ status: 'accepted' }` */
  answerRiddle?: { status: RiddleStatus } | FakeFail;
}

export interface FakeState {
  auth?: {
    authenticated?: boolean;
    nearAccountId?: string | null;
    identityToken?: string | null;
    /** the Google account's email, shown in the Account menu; default `sam@example.com` */
    email?: string | null;
    /** what the next «sign-in with Google» ends in; default `ok`. `cancelled`, `failed`: the page came back from Google with
     *  that, at `/`. `start_failed`: Google never started (`initOAuth` rejected, Privy did not come), so the page never left
     *  and the address is the place again. `held`: Google is still starting: the address is `/`, the page still stands. */
    outcome?: 'ok' | 'cancelled' | 'failed' | 'start_failed' | 'held';
    /** the page starts as a return from Google (`privy_oauth_code` in the address) */
    fresh?: boolean;
  };
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
