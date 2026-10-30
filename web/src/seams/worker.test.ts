import { afterEach, describe, expect, it, vi } from 'vitest';
import { HATCH_TIMEOUT_MS, REQUEST_TIMEOUT_MS, workerApi, WorkerError } from './worker';

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
