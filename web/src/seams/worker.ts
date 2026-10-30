// The only module that talks to the game's Worker. Every request with a player carries Privy's identity token in
// `privy-id-token` (design.md › Worker); without one it goes as a visitor. A failure is a WorkerError: `status` 0
// means the Worker never answered, any other is its HTTP status with the `code` of its body (`signed_out`,
// `rate_limited`, `chain_unreachable`, `not_owner`, `no_pet`, …).
import type { Conversation, HatchStatus, Health, Me, PetState, PetView, Token, WorkerApi } from './worker-types';
import { WorkerError } from './worker-types';

export * from './worker-types';

/** A request that gets no answer in this long is `Connection rule` › «сервер недоступен». */
export const REQUEST_TIMEOUT_MS = 15_000;
/** `POST /api/hatch` may hold: a second tap waits up to 30 s for the first, a transaction up to 25 s. */
export const HATCH_TIMEOUT_MS = 65_000;

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
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not the Worker's answer (a proxy's page): a refusal keeps its status, an «ok» is no answer at all
    if (res.ok) throw new WorkerError(0, 'unreachable');
  }
  if (!res.ok) {
    const code = typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? body.code : 'error';
    throw new WorkerError(res.status, code);
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
  petState: (token, tokenId, job) => call<PetState>(`/api/pets/${id(tokenId)}/state${job ? `?job=${encodeURIComponent(job)}` : ''}`, token),
  conversation: (token, tokenId, before) =>
    call<Conversation>(`/api/pets/${id(tokenId)}/conversation${before !== undefined ? `?before=${before}` : ''}`, token),
  say: (token, tokenId, text, mode) => call<{ job: string }>(`/api/pets/${id(tokenId)}/thoughts`, token, { method: 'POST', body: { text, mode } }),
  greeting: (token, tokenId) => call<{ job: string | null }>(`/api/pets/${id(tokenId)}/greeting`, token, { method: 'POST' }),
  retryWake: (token, tokenId) => call<{ job: string | null }>(`/api/pets/${id(tokenId)}/wake`, token, { method: 'POST' }),
};

export const workerApi: WorkerApi =
  import.meta.env.VITE_FAKES === 'true' ? (await import('./worker.fake')).fakeWorkerApi : real;

/** `Conversation flow` › «долгий ответ»: no reply for this long, and the waiting line appears. Only the e2e mode's
 *  fakes can change it (a capture of a frame that is not about waiting must not catch the line by the clock). */
export const waitLineMs: (real: number) => number =
  import.meta.env.VITE_FAKES === 'true' ? (await import('./worker.fake')).fakeWaitLineMs : (real) => real;
