// The only module that talks to the game's Worker. Every request with a player carries Privy's identity token in
// `privy-id-token` (design.md › Worker); without one it goes as a visitor. A failure is a WorkerError: `status` 0
// means the Worker never answered, any other is its HTTP status with the `code` of its body (`signed_out`,
// `rate_limited`, `chain_unreachable`, `not_owner`, `no_pet`, …).
import type {
  AdviceRead,
  CatalogEntryView,
  CardSource,
  CodeRead,
  CodeTestResult,
  Conversation,
  DiaryView,
  ExperienceNotes,
  RelationshipSummary,
  WorkRecord,
  ErrandQuote,
  SharedErrand,
  FeedOutcome,
  FeedSheetAnswer,
  GiftLink,
  GiftOutcome,
  PublicGift,
  HatchStatus,
  Health,
  HireBoard,
  ShowcaseCopy,
  HireMode,
  Me,
  MyPets,
  OutfitSlug,
  PetState,
  PetView,
  VerificationIndex,
  SharedReceipt,
  VerificationThought,
  RiddleStatus,
  SignInGate,
  SkillRead,
  SourceView,
  Token,
  ToolView,
  WalletInfo,
  WardrobeView,
  WishRead,
  WorkInvitation,
  RefusalEvidence,
  WatchRead,
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

async function call<T>(path: string, token: Token, init?: { method?: string; body?: unknown; timeoutMs?: number; serverTime?: boolean }): Promise<T> {
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
    const code = typeof body === 'object' && body !== null && 'error' in body && body.error === 'former_owner' ? 'former_owner'
      : typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? body.code : 'error';
    throw new WorkerError(res.status, code, body);
  }
  if (init?.serverTime && body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return { ...body, serverTime: res.headers.get('date') ?? undefined } as T;
  }
  return body as T;
}

async function callReceiptBytes(code: string, n: number, part: 'request' | 'reply'): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(`/api/verification/receipts/${encodeURIComponent(code)}/calls/${n}/${part}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { throw new WorkerError(0, 'unreachable'); }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: string } | null;
    throw new WorkerError(response.status, body?.code ?? 'error');
  }
  return new Uint8Array(await response.arrayBuffer());
}

const id = (tokenId: string) => encodeURIComponent(tokenId);

const real: WorkerApi = {
  wish: (token, tokenId) => call<WishRead>(`/api/pets/${id(tokenId)}/wish`, token),
  cancelWish: (token, tokenId) => call<{ status: 'released' | 'pending' }>(`/api/pets/${id(tokenId)}/wish/cancel`, token, { method: 'POST' }),
  continueWish: (token, tokenId) => call<{ status: 'active' | 'pending' } | { code: 'wish_pending' }>(`/api/pets/${id(tokenId)}/wish/continue`, token, { method: 'POST' }),
  invitations: (token, tokenId) => call<{ invitations: WorkInvitation[] }>(`/api/pets/${id(tokenId)}/invitations`, token),
  acceptInvitation: (token, tokenId, invitationId) => call<{ workerId: string; name: string; label: string | null; price: WorkInvitation['price']; question: '' }>(`/api/pets/${id(tokenId)}/invitations/${encodeURIComponent(invitationId)}/accept`, token, { method: 'POST' }),
  dismissInvitation: (token, tokenId, invitationId) => call<{ status: 'dismissed' }>(`/api/pets/${id(tokenId)}/invitations/${encodeURIComponent(invitationId)}/dismiss`, token, { method: 'POST' }),
  refusalEvidence: (token, tokenId, refusalId) => call<RefusalEvidence>(`/api/verification/pets/${id(tokenId)}/refusals/${encodeURIComponent(refusalId)}`, token),
  experience: (token, tokenId) => call<ExperienceNotes>(`/api/pets/${id(tokenId)}/experience`, token),
  workRecord: (tokenId) => call<WorkRecord>(`/api/pets/${id(tokenId)}/work`, null),
  experienceRecordOpened: (ids) => call<void>('/api/experience/record-opened', null, { method: 'POST', body: ids }),
  societyDiarySeen: (token, tokenId, ids) => call<void>(`/api/pets/${id(tokenId)}/society/diary-seen`, token, { method: 'POST', body: ids }),
  approveExperience: (token, tokenId, noteId, approved, generation) => call(`/api/pets/${id(tokenId)}/experience/notes/${id(noteId)}/approval`, token, { method: 'PUT', body: { approved, generation } }),
  publishExperienceField: (token, tokenId, noteId, generation) => call(`/api/pets/${id(tokenId)}/experience/field`, token, { method: 'POST', body: { noteId, generation } }),
  health: () => call<Health>('/health', null),
  showcase: () => call<ShowcaseCopy>('/api/showcase', null),
  hireBoard: (token) => call<HireBoard>('/api/hire', token),
  me: (token) => call<Me>('/api/me', token, { serverTime: true }),
  myPets: (token) => call<MyPets>('/api/me/pets', token),
  publicGift: (token, code) => call<PublicGift>(`/api/gifts/${encodeURIComponent(code)}`, token),
  acceptGift: (token, code) => call<{ status: 'accepted'; tokenId: string }>(`/api/gifts/${encodeURIComponent(code)}/accept`, token, { method: 'POST' }),
  giftLink: (token, tokenId) => call<GiftLink>(`/api/pets/${id(tokenId)}/gift`, token),
  createGift: (token, tokenId) => call<GiftLink>(`/api/pets/${id(tokenId)}/gift`, token, { method: 'POST' }),
  cancelGift: (token, tokenId) => call<GiftLink>(`/api/pets/${id(tokenId)}/gift`, token, { method: 'DELETE' }),
  prepareGift: (token, tokenId) => call<GiftOutcome>(`/api/pets/${id(tokenId)}/gift/prepare`, token, { method: 'POST' }),
  sendGift: (token, tokenId, body) => call<GiftOutcome>(`/api/pets/${id(tokenId)}/gift/send`, token, { method: 'POST', body, timeoutMs: FEED_SEND_TIMEOUT_MS }),
  giftOutcome: (token, tokenId) => call<GiftOutcome>(`/api/pets/${id(tokenId)}/gift/outcome`, token),
  hatchStatus: (token, opts) => call<HatchStatus>(opts?.look ? '/api/hatch?look=1' : '/api/hatch', token, { serverTime: true }),
  hatch: (token, name) => call<{ tokenId: string } | { pending: true }>('/api/hatch', token, { method: 'POST', body: { name }, timeoutMs: HATCH_TIMEOUT_MS }),
  pet: (token, tokenId) => call<PetView>(`/api/pets/${id(tokenId)}`, token),
  relationships: (token, tokenId) => call<RelationshipSummary>(`/api/pets/${id(tokenId)}/relationships`, token),
  cardLines: (token, tokenId) => call<{ lines: Array<{ id: string; text: string }> }>(`/api/pets/${id(tokenId)}/card-lines`, token),
  cardSource: (token, tokenId, body) => call<CardSource>(`/api/pets/${id(tokenId)}/card-source`, token, { method: 'POST', body }),
  cardShared: (token, body) => call<void>('/api/showcase/card-shared', token, { method: 'POST', body }),
  verificationIndex: (tokenId) => call<VerificationIndex>(`/api/verification/pets/${id(tokenId)}`, null),
  verificationThought: (token, tokenId, thoughtId) => call<VerificationThought>(
    `/api/verification/pets/${id(tokenId)}/thoughts/${encodeURIComponent(thoughtId)}`, token),
  publishReceipt: (token, tokenId, thoughtId, operationId) => call<{ code: string; path: string }>(
    `/api/verification/pets/${id(tokenId)}/thoughts/${encodeURIComponent(thoughtId)}/links`, token,
    { method: 'POST', body: { operationId } }),
  sharedReceipt: (code) => call<SharedReceipt>(`/api/verification/receipts/${encodeURIComponent(code)}`, null),
  receiptBytes: callReceiptBytes,
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
      if (e instanceof WorkerError && e.status === 403 && (e.code === 'judge_invalid' || e.code === 'judge_exhausted' || e.code === 'judge_expired')) {
        return { refused: { reason: e.code } };
      }
      throw e;
    }
  },
  endSession: (token) => call<void>('/api/session/end', token, { method: 'POST', timeoutMs: END_SESSION_TIMEOUT_MS }),
  signInState: () => call<SignInGate>('/api/sign-in', null),
  judgeCheck: (code) => call<{ ok: true }>('/api/judge/check', null, { method: 'POST', body: { code } }),
  clearMemory: (token, tokenId, approval) => call<{ ok: true } | { code: 'close_retry' }>(`/api/pets/${id(tokenId)}/memory/clear`, token, { method: 'POST', body: approval ? { approval } : {} }),
  feedSheet: (token, tokenId) => call<FeedSheetAnswer>(`/api/pets/${id(tokenId)}/feed`, token),
  buildFeed: (token, tokenId, portion, code) => call<{ tx: string }>(`/api/pets/${id(tokenId)}/feed`, token, { method: 'POST', body: { portion, ...(code ? { code } : {}) } }),
  sendFeed: (token, tokenId, body) =>
    call<FeedOutcome>(`/api/pets/${id(tokenId)}/feed/send`, token, { method: 'POST', body, timeoutMs: FEED_SEND_TIMEOUT_MS }),
  feedOutcome: (token, tokenId, body) => call<FeedOutcome>(`/api/pets/${id(tokenId)}/feed/outcome`, token, { method: 'POST', body }),
  snack: (token, tokenId, code) => call<FeedOutcome>(`/api/pets/${id(tokenId)}/snack`, token, { method: 'POST', body: code ? { code } : {}, timeoutMs: FEED_SEND_TIMEOUT_MS }),
  wallet: (token) => call<WalletInfo>('/api/wallet', token),
  diary: (token, tokenId) => call<DiaryView>(`/api/pets/${id(tokenId)}/diary`, token),
  watch: (token, tokenId) => call<WatchRead>(`/api/pets/${id(tokenId)}/watch`, token),
  saveWatch: (token, tokenId, target) => call<WatchRead>(`/api/pets/${id(tokenId)}/watch`, token, { method: 'PUT', body: { target } }),
  resumeWatch: (token, tokenId) => call<WatchRead>(`/api/pets/${id(tokenId)}/watch/resume`, token, { method: 'POST' }),
  stopWatch: (token, tokenId) => call<{ target: null }>(`/api/pets/${id(tokenId)}/watch`, token, { method: 'DELETE' }),
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
  skill: (token, tokenId) => call<SkillRead>(`/api/pets/${id(tokenId)}/skill`, token),
  saveSkill: (token, tokenId, body) => call<{ skill: { label: string } }>(`/api/pets/${id(tokenId)}/skill`, token, { method: 'PUT', body }),
  forgetSkill: (token, tokenId) => call<{ skill: null }>(`/api/pets/${id(tokenId)}/skill`, token, { method: 'DELETE' }),
  errand: (token, tokenId, form) => call<ErrandQuote>(`/api/pets/${id(tokenId)}/errand?form=${form}`, token),
  prepareSharedErrand: (token, tokenId, body) => call(`/api/pets/${id(tokenId)}/shared-errands`, token, { method: 'POST', body }),
  sharedErrand: (token, tokenId, code) => call<SharedErrand>(`/api/pets/${id(tokenId)}/errand/${encodeURIComponent(code)}`, token),
  sharedErrandEvent: (token, tokenId, code, body) => call<void>(`/api/pets/${id(tokenId)}/errand/${encodeURIComponent(code)}/events`, token, { method: 'POST', body }),
  closeSharedErrand: (token, tokenId, code, approval) => call<{ ok: true }>(`/api/pets/${id(tokenId)}/errand/${encodeURIComponent(code)}/close`, token, { method: 'POST', body: { approval } }),
  releaseSharedReserve: (token, tokenId, approval) => call<{ ok: true } | { code: 'close_retry' }>(`/api/pets/${id(tokenId)}/shared-close`, token, { method: 'POST', body: { approval } }),
  sendErrand: (token, tokenId, body) => call<{ job: string }>(`/api/pets/${id(tokenId)}/errand`, token, { method: 'POST', body }),
  adapters: (token) => call<{ entries: CatalogEntryView[] }>('/api/adapters', token),
  checkSource: (token, tokenId, address) => call<{ tools: ToolView[] }>(`/api/pets/${id(tokenId)}/sources/check`, token, { method: 'POST', body: { address } }),
  saveSource: (token, tokenId, body) => call<{ source: SourceView }>(`/api/pets/${id(tokenId)}/sources`, token, { method: 'POST', body }),
  editSource: (token, tokenId, sid, body) => call<{ source: SourceView }>(`/api/pets/${id(tokenId)}/sources/${id(sid)}`, token, { method: 'PUT', body }),
  removeSource: (token, tokenId, sid) => call<{ removed: true }>(`/api/pets/${id(tokenId)}/sources/${id(sid)}`, token, { method: 'DELETE' }),
  publishSource: (token, tokenId, sid) => call<{ source: SourceView }>(`/api/pets/${id(tokenId)}/sources/${id(sid)}/publish`, token, { method: 'POST' }),
  unpublishSource: (token, tokenId, sid) => call<{ source: SourceView }>(`/api/pets/${id(tokenId)}/sources/${id(sid)}/publish`, token, { method: 'DELETE' }),
  code: (token, tokenId) => call<CodeRead>(`/api/pets/${id(tokenId)}/code`, token),
  testCode: (token, tokenId, body) => call<CodeTestResult>(`/api/pets/${id(tokenId)}/code/test`, token, { method: 'POST', body }),
  saveCode: (token, tokenId, body) => call<{ code: { functions: ToolView[] } }>(`/api/pets/${id(tokenId)}/code`, token, { method: 'PUT', body }),
  removeCode: (token, tokenId) => call<{ removed: true }>(`/api/pets/${id(tokenId)}/code`, token, { method: 'DELETE' }),
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
