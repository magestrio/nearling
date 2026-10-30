import { afterEach, describe, expect, it, vi } from 'vitest';
import { END_SESSION_TIMEOUT_MS, HATCH_TIMEOUT_MS, REQUEST_TIMEOUT_MS, workerApi, WorkerError } from './worker';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A network that holds a request until its signal ends it, and a deadline the test ends by hand. */
function blackHole() {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
        }),
    ),
  );
  return { deadline, timeout };
}

describe('the Worker seam', () => {
  // spec: add-pet › Connection rule › сервер недоступен
  it('gives up on a request nobody answers: a black hole is «the server does not answer»', async () => {
    const { deadline, timeout } = blackHole();
    const asked = workerApi.pet(null, '9');
    deadline.abort();
    await expect(asked).rejects.toMatchObject({ status: 0, code: 'unreachable' });
    await expect(asked).rejects.toBeInstanceOf(WorkerError);
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
  });

  // spec: add-pet › Birth flow › не вылупился
  it('waits longer for a birth, which the server may hold', async () => {
    const { deadline, timeout } = blackHole();
    const asked = workerApi.hatch('t', 'Pixel');
    deadline.abort();
    await expect(asked).rejects.toMatchObject({ status: 0 });
    expect(timeout).toHaveBeenCalledWith(HATCH_TIMEOUT_MS);
  });

  // spec: add-pet › Connection rule › сервер недоступен
  it('takes a 200 that is not the Worker\'s answer for no answer, and a refusal keeps its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
    await expect(workerApi.pet(null, '9')).rejects.toMatchObject({ status: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })));
    await expect(workerApi.pet(null, '9')).rejects.toMatchObject({ status: 502, code: 'error' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'no_pet' }, { status: 404 })));
    await expect(workerApi.pet(null, '9')).rejects.toMatchObject({ status: 404, code: 'no_pet' });
  });

  // spec: add-pet › Service pause data › пауза снялась
  it('marks the page\'s own repeat as a look, and a load or a tap as no look', async () => {
    const fetchMock = vi.fn(async () => Response.json({ open: false, reason: 'service' }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.hatchStatus('t');
    await workerApi.hatchStatus('t', { look: true });
    expect(fetchMock.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(['/api/hatch', '/api/hatch?look=1']);
  });

  // spec: add-pet › Connection rule › AI-провайдер недоступен
  it('asks for a wake thought again by POST', async () => {
    const fetchMock = vi.fn(async () => Response.json({ job: 'j' }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.retryWake('t', '9')).toEqual({ job: 'j' });
    expect(fetchMock.mock.calls[0]).toMatchObject(['/api/pets/9/wake', { method: 'POST', headers: { 'privy-id-token': 't' } }]);
  });
});

describe('the Worker seam of the session', () => {
  const calls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => c as unknown as [string, RequestInit]);

  // spec: add-account › Sign-in flow › вошёл со страницы
  it('sends the exchange with the token and its two marks, and takes the 200', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.session('t', { fresh: true, from: 'link' })).toEqual({ ok: true });
    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe('/api/session');
    expect(init).toMatchObject({ method: 'POST', headers: { 'privy-id-token': 't' } });
    expect(JSON.parse(init.body as string)).toEqual({ fresh: true, from: 'link' });
  });

  // spec: add-account › Sign-in flow › новый после Google
  it('takes the refusal of the exchange as an answer, with its reason and the day it opens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'sign_in_refused', reason: 'mau', until: '2026-12-01T00:00:00.000Z' }, { status: 403 })));
    expect(await workerApi.session('t', { fresh: true })).toEqual({ refused: { reason: 'mau', until: '2026-12-01T00:00:00.000Z' } });
  });

  // spec: add-account › Sign-in flow › вход не удался
  it('keeps a 401 of the exchange a failure, and a 403 with no reason too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'signed_out' }, { status: 401 })));
    await expect(workerApi.session('t', { fresh: false })).rejects.toMatchObject({ status: 401, code: 'signed_out' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'sign_in_refused' }, { status: 403 })));
    await expect(workerApi.session('t', { fresh: false })).rejects.toMatchObject({ status: 403, code: 'sign_in_refused' });
  });

  // spec: add-account › Sign-out data › server not reached
  it('ends the session with a 3 second limit, takes the 204, and lets a black hole be no answer', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await expect(workerApi.endSession('t')).resolves.toBeUndefined();
    expect(calls(fetchMock)[0]![0]).toBe('/api/session/end');
    expect(timeout).toHaveBeenCalledWith(END_SESSION_TIMEOUT_MS);
    expect(END_SESSION_TIMEOUT_MS).toBe(3000);

    const { deadline } = blackHole();
    const asked = workerApi.endSession('t');
    deadline.abort();
    await expect(asked).rejects.toMatchObject({ status: 0, code: 'unreachable' });
  });

  // spec: add-account › Sign-in flow › вход начат × чтение входа не удалось
  it('reads the gate with no token at all: a stale one would be a 401', async () => {
    const fetchMock = vi.fn(async () => Response.json({ state: 'closed_new', until: '2026-12-01T00:00:00.000Z' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.signInState()).toEqual({ state: 'closed_new', until: '2026-12-01T00:00:00.000Z' });
    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe('/api/sign-in');
    expect(init.headers).toEqual({});
  });

  // spec: add-account › Memory deletion flow › стирает
  it('clears a pet\'s memory by POST with the token', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.clearMemory('t', '9')).toEqual({ ok: true });
    expect(calls(fetchMock)[0]).toMatchObject(['/api/pets/9/memory/clear', { method: 'POST', headers: { 'privy-id-token': 't' } }]);
  });

  // spec: add-account › Clear memory dialog screen › error
  it('keeps the code of a refusal of the clear, and the unknown outcome of a lost answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'not_owner' }, { status: 403 })));
    await expect(workerApi.clearMemory('t', '9')).rejects.toMatchObject({ status: 403, code: 'not_owner' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'clear_failed' }, { status: 500 })));
    await expect(workerApi.clearMemory('t', '9')).rejects.toMatchObject({ status: 500, code: 'clear_failed' });
    const { deadline } = blackHole();
    const asked = workerApi.clearMemory('t', '9');
    deadline.abort();
    await expect(asked).rejects.toMatchObject({ status: 0 });
  });
});
