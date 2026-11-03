// The only module that talks to the game's Worker. Every request with a player carries Privy's identity token in
// `privy-id-token` (design.md › Worker); without one it goes as a visitor. A failure is a WorkerError: `status` 0
// means the Worker never answered, any other is its HTTP status with the `code` of its body (`signed_out`,
// `rate_limited`, `chain_unreachable`, `not_owner`, `no_pet`, …).
import type {
  AdviceRead,
  Conversation,
  DiaryView,
  FeedOutcome,
  FeedSheetAnswer,
  HatchStatus,
  Health,
  HireMode,
  Me,
  OutfitSlug,
  PetState,
  PetView,
  RiddleStatus,
  SignInGate,
  SkillText,
  Token,
  WalletInfo,
  WardrobeView,
  WorkerApi,
} from './worker-types';
import { WorkerError } from './worker-types';

export * from './worker-types';

/** A request that gets no answer in this long is `Connection rule` › «сервер недоступен». */
export const REQUEST_TIMEOUT_MS = 15_000;
/** `POST /api/hatch` may hold: a second tap waits up to 30 s for the first, a transaction up to 25 s. */
export const HATCH_TIMEOUT_MS = 65_000;
/** `POST …/feed/send` and `…/snack` may hold: the server waits up to 25 s for the network (`SEND_TIMEOUT_MS`), a second tap
 *  of another tab waits as long. The line «Still checking…» does not wait for this: it comes at 10 s (`feedFlight.ts`). */
export const FEED_SEND_TIMEOUT_MS = 65_000;
/** The sign-out does not wait on the server longer than this (`Sign-out data` › `server not reached`). */
export const END_SESSION_TIMEOUT_MS = 3000;

async function call<T>(path: string, token: Token, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      method: init?.method ?? 'GET',
      headers: {
        ...(token ? { 'privy-id-token': token } : {}),
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init?.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch {
    // no answer in time, or a dropped connection: the request and its body share the deadline
    throw new WorkerError(0, 'unreachable');
  }
  // `204`: an answer with no body (`POST /api/session/end`)
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not the Worker's answer (a proxy's page): a refusal keeps its status, an «ok» is no answer at all
    if (res.ok) throw new WorkerError(0, 'unreachable');
  }
  if (!res.ok) {
    const code = typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? body.code : 'error';
    throw new WorkerError(res.status, code, body);
  }
  return body as T;
}

const id = (tokenId: string) => encodeURIComponent(tokenId);

const real: WorkerApi = {
  health: () => call<Health>('/health', null),
  me: (token) => call<Me>('/api/me', token),
  hatchStatus: (token, opts) => call<HatchStatus>(opts?.look ? '/api/hatch?look=1' : '/api/hatch', token),
  hatch: (token, name) => call<{ tokenId: string }>('/api/hatch', token, { method: 'POST', body: { name }, timeoutMs: HATCH_TIMEOUT_MS }),
  pet: (token, tokenId) => call<PetView>(`/api/pets/${id(tokenId)}`, token),
  petState: (token, tokenId, job, wakes) => {
    const query = new URLSearchParams();
    if (job) query.set('job', job);
    if (wakes !== undefined) query.set('wakes', String(wakes));
    const text = query.toString();
    return call<PetState>(`/api/pets/${id(tokenId)}/state${text ? `?${text}` : ''}`, token);
  },
  conversation: (token, tokenId, before) =>
    call<Conversation>(`/api/pets/${id(tokenId)}/conversation${before !== undefined ? `?before=${before}` : ''}`, token),
  say: (token, tokenId, text, mode) => call<{ job: string }>(`/api/pets/${id(tokenId)}/thoughts`, token, { method: 'POST', body: { text, mode } }),
  greeting: (token, tokenId) => call<{ job: string | null }>(`/api/pets/${id(tokenId)}/greeting`, token, { method: 'POST' }),
  retryWake: (token, tokenId) => call<{ job: string | null }>(`/api/pets/${id(tokenId)}/wake`, token, { method: 'POST' }),
  async session(token, body) {
    try {
      return await call<{ ok: true }>('/api/session', token, { method: 'POST', body });
    } catch (e) {
      // `403 sign_in_refused { reason, until }`: the one refusal that carries more than its code
      if (e instanceof WorkerError && e.status === 403 && e.code === 'sign_in_refused') {
        const { reason, until } = (e.body ?? {}) as { reason?: unknown; until?: unknown };
        if ((reason === 'mau' || reason === 'ceiling') && typeof until === 'string') return { refused: { reason, until } };
      }
      throw e;
    }
  },
  endSession: (token) => call<void>('/api/session/end', token, { method: 'POST', timeoutMs: END_SESSION_TIMEOUT_MS }),
  signInState: () => call<SignInGate>('/api/sign-in', null),
  clearMemory: (token, tokenId) => call<{ ok: true }>(`/api/pets/${id(tokenId)}/memory/clear`, token, { method: 'POST' }),
  feedSheet: (token, tokenId) => call<FeedSheetAnswer>(`/api/pets/${id(tokenId)}/feed`, token),
  buildFeed: (token, tokenId, portion) => call<{ tx: string }>(`/api/pets/${id(tokenId)}/feed`, token, { method: 'POST', body: { portion } }),
  sendFeed: (token, tokenId, body) =>
    call<FeedOutcome>(`/api/pets/${id(tokenId)}/feed/send`, token, { method: 'POST', body, timeoutMs: FEED_SEND_TIMEOUT_MS }),
  feedOutcome: (token, tokenId, body) => call<FeedOutcome>(`/api/pets/${id(tokenId)}/feed/outcome`, token, { method: 'POST', body }),
  snack: (token, tokenId) => call<FeedOutcome>(`/api/pets/${id(tokenId)}/snack`, token, { method: 'POST', timeoutMs: FEED_SEND_TIMEOUT_MS }),
  wallet: (token) => call<WalletInfo>('/api/wallet', token),
  diary: (token, tokenId) => call<DiaryView>(`/api/pets/${id(tokenId)}/diary`, token),
  readDiary: (token, tokenId, day) => call<{ ok: true }>(`/api/pets/${id(tokenId)}/diary/read`, token, { method: 'POST', body: { day } }),
  answerQuestion: (token, tokenId, body) => call<{ job: string }>(`/api/pets/${id(tokenId)}/diary/answer`, token, { method: 'POST', body }),
  answerRiddle: (token, tokenId, body) => call<{ status: RiddleStatus }>(`/api/pets/${id(tokenId)}/riddle`, token, { method: 'POST', body }),
  wardrobe: (token, tokenId) => call<WardrobeView>(`/api/pets/${id(tokenId)}/wardrobe`, token),
  wear: (token, tokenId, item) => call<{ worn: OutfitSlug | null }>(`/api/pets/${id(tokenId)}/wardrobe/wear`, token, { method: 'POST', body: { item } }),
  buy: (token, tokenId, item) => call<{ id: string }>(`/api/pets/${id(tokenId)}/wardrobe/buy`, token, { method: 'POST', body: { item } }),
  seenOutfit: (token, tokenId, item) => call<{ ok: true }>(`/api/pets/${id(tokenId)}/wardrobe/seen`, token, { method: 'POST', body: { item } }),
  setHireMode: (token, tokenId, mode) => call<{ mode: HireMode }>(`/api/pets/${id(tokenId)}/hire-mode`, token, { method: 'PUT', body: { mode } }),
  askOffer: (token, tokenId, price) => call<{ job: string }>(`/api/pets/${id(tokenId)}/offer/ask`, token, { method: 'POST', body: { price } }),
  declineOffer: (token, tokenId) => call<{ job: string }>(`/api/pets/${id(tokenId)}/offer/decline`, token, { method: 'POST' }),
  finishHire: (token, tokenId) => call<{ job: string }>(`/api/pets/${id(tokenId)}/hire/finish`, token, { method: 'POST' }),
  advice: (token, tokenId, payer) => call<AdviceRead>(`/api/pets/${id(tokenId)}/advice?payer=${encodeURIComponent(payer)}`, token),
  askAdvice: (token, tokenId, body) => call<{ job: string }>(`/api/pets/${id(tokenId)}/advice`, token, { method: 'POST', body }),
  skill: (token, tokenId) => call<{ skill: SkillText | null }>(`/api/pets/${id(tokenId)}/skill`, token),
  saveSkill: (token, tokenId, body) => call<{ skill: { label: string } }>(`/api/pets/${id(tokenId)}/skill`, token, { method: 'PUT', body }),
  forgetSkill: (token, tokenId) => call<{ skill: null }>(`/api/pets/${id(tokenId)}/skill`, token, { method: 'DELETE' }),
};

export const workerApi: WorkerApi =
  import.meta.env.VITE_FAKES === 'true' ? (await import('./worker.fake')).fakeWorkerApi : real;

/** A Toast goes after 4 s (DS README). Only the e2e mode's fakes can hold it: a capture of the frame that shows a Toast is taken
 *  seconds after the page loads on software GL, past the Toast's time. */
export const toastHeld: () => boolean =
  import.meta.env.VITE_FAKES === 'true' ? (await import('./worker.fake')).fakeToastHeld : () => false;

/** `Conversation flow` › «долгий ответ»: no reply for this long, and the waiting line appears. Only the e2e mode's
 *  fakes can change it (a capture of a frame that is not about waiting must not catch the line by the clock). */
export const waitLineMs: (real: number) => number =
  import.meta.env.VITE_FAKES === 'true' ? (await import('./worker.fake')).fakeWaitLineMs : (real) => real;
