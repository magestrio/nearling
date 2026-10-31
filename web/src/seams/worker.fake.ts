// The Worker's answers for the e2e mode and the screen captures: read from `__NEARLING_FAKES__.worker` at every call,
// so a test can change them after the page loaded. The shapes are the real routes' (server/src/routes/*), the refusals
// carry the real codes. Nothing here leaves the machine.
import { actions, createTransaction } from 'near-api-js';
import { config } from '../config';
import { PORTION_YOCTO, toBase64 } from '../feeding/feedTx';
import { cleanName, hasVisible } from '../lib/nameClean';
import { publicKeyFromImplicitAccount } from '../near/privySigner';
import { fakeState, recordCall, type FakeFail, type FakeWorkerState } from './fakes';
import {
  WorkerError,
  type FeedOutcome,
  type FeedSheetData,
  type PetView,
  type PortionNear,
  type SessionResult,
  type SignInGate,
  type WalletInfo,
  type WorkerApi,
} from './worker-types';

const state = (): FakeWorkerState => fakeState().worker ?? {};
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isFail(v: unknown): v is FakeFail {
  return typeof v === 'object' && v !== null && 'fail' in v;
}

/** The answer a test configured, after its delay, or the refusal it configured instead. */
async function answer<T>(name: string, configured: T | FakeFail | undefined, fallback: T, delayMs?: number): Promise<T> {
  recordCall(`worker:${name}`);
  const ms = delayMs ?? state().delayMs ?? 0;
  if (ms > 0) await wait(ms);
  if (isFail(configured)) throw new WorkerError(configured.fail.status, configured.fail.code, configured.fail.body ?? null);
  return configured ?? fallback;
}

const PIXEL_RESULT = { tokenId: '9' };
const PIXEL = { tokenId: '9', name: 'Pixel', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 }, mood: 'happy' as const };
const BISCUIT = { tokenId: '2', name: 'Biscuit', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 }, mood: 'happy' as const };
const OWNER_DEFAULTS = {
  traits: ['clever', 'sociable'],
  energy: 7,
  tired: false,
  paused: false,
  deepPrice: { cents: 0.12, yocto: '260000000000000000000' },
  hello: false,
  pendingJob: null,
  pendingMode: null,
  pendingKind: null,
  pendingText: null,
  lastThought: null,
  memoryEpoch: 0,
  wakes: 0,
  ownedCount: 1,
};

function petsOf(): NonNullable<FakeWorkerState['pets']> {
  return state().pets ?? { '9': PIXEL, '2': BISCUIT };
}

const PORTION_CENTS = { '0.01': 5, '0.05': 23, '0.2': 92 } as const;
/** 0.31 NEAR: what the frames' wallet holds. */
const WALLET_YOCTO = '310000000000000000000000';
const fakeAccount = (): string => fakeState().auth?.nearAccountId ?? 'a'.repeat(64);

/** The sheet the real route would build for this pet and the fake player: the portions all within reach, 0.31 NEAR in the wallet,
 *  the free snack where `Snack rule` gives one (a friend's, an asleep pet's of the owner). A test lays its own fields over it. */
function defaultSheet(tokenId: string): FeedSheetData {
  const pet = petsOf()[tokenId];
  if (!pet) throw new WorkerError(404, 'no_pet');
  const owner = (state().owned ?? []).includes(tokenId);
  return {
    chain: true,
    viewer: owner ? 'owner' : 'guest',
    name: pet.name,
    fullness: pet.fullness,
    portions: (Object.keys(PORTION_YOCTO) as PortionNear[]).map((near) => ({ near, yocto: PORTION_YOCTO[near].toString(), cents: PORTION_CENTS[near], missing: null })),
    wallet: { state: 'some', balance: WALLET_YOCTO },
    snack: owner && pet.fullness.state !== 'asleep' ? { state: 'none' } : { state: 'ready' },
    hatched: true,
    friend: null,
    pending: null,
  };
}

/** A confirmed meal or snack; a friend's carries the name for the thanks. */
function defaultOutcome(tokenId: string): FeedOutcome {
  const owner = (state().owned ?? []).includes(tokenId);
  return { status: 'ok', hash: 'FakeFeedHash1111111111111111111111111111111', hatched: true, ...(owner ? {} : { friend: 'Maya' }) };
}

/** A token is no session once a test says so (`sessionExpired`): the Worker answers every request that carries one with `401`. */
function needSession(token: string | null): void {
  if (token !== null && (state().sessionExpired || (state().expiredAfterExchange && exchanged))) throw new WorkerError(401, 'signed_out');
}
/** The exchange of this page load was answered `200`. */
let exchanged = false;

/** What `GET /api/pets/:id` answers for this viewer. */
async function viewOf(token: string | null, tokenId: string): Promise<PetView> {
  needSession(token);
  const ms = state().delayMs ?? 0;
  if (ms > 0) await wait(ms);
  const refused = state().petResult;
  if (refused) throw new WorkerError(refused.fail.status, refused.fail.code);
  const pet = petsOf()[tokenId];
  if (!pet) throw new WorkerError(404, 'no_pet');
  const { owner, myFeed, ...base } = pet;
  if (token === null) return { viewer: 'visitor', ...base };
  if (!(state().owned ?? []).includes(tokenId)) return { viewer: 'guest', ...base, myFeed: myFeed ?? null };
  return { viewer: 'owner', ...base, ...OWNER_DEFAULTS, myFeed: myFeed ?? null, ...owner };
}

/** How long a thought may be on its way before «Still working on it…» joins the thinking line: 10 s as the spec says;
 *  a capture of a frame that is not about waiting holds it off, the frame that is gets it at once. */
export const fakeToastHeld = (): boolean => state().toastHeld === true;

export const fakeWaitLineMs =(real: number): number => state().waitLineMs ?? real;

export const fakeWorkerApi: WorkerApi = {
  async health() {
    return { ok: true, version: state().version ?? 'fake-version', env: 'e2e' };
  },

  me: async (token) => {
    if (token === null) throw new WorkerError(401, 'signed_out');
    needSession(token);
    return answer('me', state().me, { accountId: 'a'.repeat(64), hatched: null, currentPet: null, ownedCount: 0 });
  },

  hatchStatus: (token, opts) => {
    needSession(token);
    // the query the real route takes: `?look=1` is recorded beside the call, so a test can tell a look from a check
    if (opts?.look) recordCall('worker:hatchStatus:look');
    return answer('hatchStatus', state().hatchStatus, { open: true }, state().hatchStatusDelayMs);
  },

  async hatch(token, name) {
    const s = state();
    if (token === null) throw new WorkerError(401, 'signed_out');
    needSession(token);
    recordCall(`worker:hatch:${name}`);
    // The server cleans the raw name and refuses one with nothing visible; the list of insults never enters the repo.
    if (!hasVisible(cleanName(name))) {
      return answer<{ tokenId: string }>('hatch', { fail: { status: 422, code: 'name_rejected' } }, PIXEL_RESULT, s.hatchDelayMs);
    }
    return answer('hatch', s.hatchResult, { tokenId: '9' }, s.hatchDelayMs);
  },

  async pet(token, tokenId) {
    recordCall('worker:pet');
    return viewOf(token, tokenId);
  },

  async petState(token, tokenId, job, wakes) {
    recordCall('worker:petState');
    // the number the page sent with `?wakes=`, beside the plain call record, so a test can tell what the page knows
    if (wakes !== undefined) recordCall(`worker:petState:wakes:${wakes}`);
    const view = await viewOf(token, tokenId);
    if (view.viewer !== 'owner') throw new WorkerError(403, 'not_owner');
    const { viewer: _viewer, ownedCount: _owned, ...owner } = view;
    const configured = state().petState;
    if (isFail(configured)) throw new WorkerError(configured.fail.status, configured.fail.code);
    // Events are what happened since the last look — the real server tells each once. The fake does the same: the
    // events a test configured go out with this answer and are gone from the next.
    if (configured?.events?.length) state().petState = { ...configured, events: [] };
    return { ...owner, events: [], ...(job ? { pending: false } : {}), ...configured };
  },

  conversation: (token) => {
    needSession(token);
    return answer('conversation', state().conversation, { lines: [], more: false, before: null });
  },
  say: (token, _tokenId, _text, mode) => {
    needSession(token);
    // the mode the tap asked for, beside the plain call record (`worker:say:chat` / `worker:say:deep`)
    recordCall(`worker:say:${mode}`);
    return answer('say', state().say, { job: 'job-1' });
  },
  greeting: (token) => {
    needSession(token);
    return answer('greeting', state().greeting, { job: 'job-1' });
  },
  retryWake: (token) => {
    needSession(token);
    return answer('retryWake', state().retryWake, { job: 'job-wake' });
  },

  session: async (token, body) => {
    recordCall(`worker:session:${body.fresh ? 'fresh' : 'load'}${body.from ? `:${body.from}` : ''}`);
    if (token === null || state().sessionExpired) throw new WorkerError(401, 'signed_out');
    const result = await answer<SessionResult>('session', state().session, { ok: true });
    exchanged = 'ok' in result;
    return result;
  },

  endSession: async (token) => {
    recordCall('worker:endSession');
    const refused = state().endSession;
    if (isFail(refused)) throw new WorkerError(refused.fail.status, refused.fail.code);
    if (token === null) throw new WorkerError(401, 'signed_out');
  },

  signInState: () => answer<SignInGate>('signInState', state().signIn, { state: 'open' }),

  feedSheet: async (token, tokenId) => {
    // asked is recorded before the refusal, as the Worker would have been asked
    recordCall('worker:feedSheet');
    if (token === null) throw new WorkerError(401, 'signed_out');
    needSession(token);
    const ms = state().feedSheetDelayMs ?? state().delayMs ?? 0;
    if (ms > 0) await wait(ms);
    const configured = state().feedSheet;
    if (isFail(configured)) throw new WorkerError(configured.fail.status, configured.fail.code);
    if (configured?.chain === false) return { chain: false };
    return { ...defaultSheet(tokenId), ...configured };
  },

  buildFeed: async (token, tokenId, portion) => {
    if (token === null) throw new WorkerError(401, 'signed_out');
    needSession(token);
    recordCall(`worker:buildFeed:${portion}`);
    const configured = state().buildFeed;
    if (isFail(configured)) throw new WorkerError(configured.fail.status, configured.fail.code, configured.fail.body ?? null);
    if (configured) return configured;
    // a real `pet_feed` as the Worker builds it, so the client's check meets real bytes
    const account = fakeAccount();
    const tx = createTransaction(
      account,
      publicKeyFromImplicitAccount(account),
      config.contractId,
      1n,
      [actions.functionCall('pet_feed', { token_id: tokenId }, 5n * 10n ** 12n, PORTION_YOCTO[portion])],
      new Uint8Array(32).fill(1),
    );
    return { tx: toBase64(tx.encode()) };
  },

  sendFeed: async (token, tokenId) => {
    if (token === null) throw new WorkerError(401, 'signed_out');
    try {
      needSession(token);
    } catch (e) {
      // asked is recorded before the refusal, as the Worker would have been asked
      recordCall('worker:sendFeed');
      throw e;
    }
    return answer<FeedOutcome>('sendFeed', state().sendFeed, defaultOutcome(tokenId), state().feedSendDelayMs);
  },

  feedOutcome: async (token, tokenId) => {
    if (token === null) throw new WorkerError(401, 'signed_out');
    needSession(token);
    return answer<FeedOutcome>('feedOutcome', state().feedOutcome, defaultOutcome(tokenId));
  },

  snack: async (token, tokenId) => {
    if (token === null) throw new WorkerError(401, 'signed_out');
    needSession(token);
    return answer<FeedOutcome>('snack', state().snack, defaultOutcome(tokenId), state().feedSendDelayMs);
  },

  wallet: async (token) => {
    if (token === null) throw new WorkerError(401, 'signed_out');
    try {
      needSession(token);
    } catch (e) {
      // asked is recorded before the refusal, as the Worker would have been asked
      recordCall('worker:wallet');
      throw e;
    }
    return answer<WalletInfo>('wallet', state().wallet, { address: fakeAccount(), balance: WALLET_YOCTO, funded: false });
  },

  clearMemory: async (token, tokenId) => {
    if (token === null || state().sessionExpired) throw new WorkerError(401, 'signed_out');
    recordCall(`worker:clearMemory:${tokenId}`);
    const result = await answer('clearMemory', state().clearMemory, { ok: true as const }, state().clearMemoryDelayMs);
    // what the real server holds from then on: an empty conversation, one more clear on the pet, no greeting to come
    const held = fakeState().worker;
    const pet = petsOf()[tokenId];
    if (held) {
      held.conversation = { lines: [], more: false, before: null };
      held.greeting = { job: null };
      if (pet) held.pets = { ...petsOf(), [tokenId]: { ...pet, owner: { ...pet.owner, memoryEpoch: (pet.owner?.memoryEpoch ?? 0) + 1 } } };
    }
    return result;
  },
};
