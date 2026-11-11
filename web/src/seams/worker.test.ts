import { afterEach, describe, expect, it, vi } from 'vitest';
import { END_SESSION_TIMEOUT_MS, FEED_SEND_TIMEOUT_MS, HATCH_TIMEOUT_MS, REQUEST_TIMEOUT_MS, workerApi, WorkerError } from './worker';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared errand Worker seam', () => {
  // spec: add-pet-errands › Friend-funded errand flow › owner shares a job
  // spec: add-pet-errands › Shared errand screen › success
  // spec: add-pet-errands › Friend-funded errand flow › owner confirms closing an unsettled job
  it('prepares, reads publicly, records sharing, and sends only the signed close approval', async () => {
    const code = 'c'.repeat(64);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => init.method === 'POST' && String(_url).endsWith('/events')
      ? new Response(null, { status: 204 }) : Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.prepareSharedErrand('t', '9', { form: 'find', job: 'A question' });
    await workerApi.sharedErrand(null, '9', code);
    await workerApi.sharedErrandEvent('t', '9', code, { kind: 'shared' });
    await workerApi.closeSharedErrand('t', '9', code, { public_key: 'a'.repeat(64), signature: 'b'.repeat(128) });
    const seen = fetchMock.mock.calls.map(([path, init]) => [path, init.method, init.body ? JSON.parse(init.body as string) : null]);
    expect(seen).toEqual([
      ['/api/pets/9/shared-errands', 'POST', { form: 'find', job: 'A question' }],
      [`/api/pets/9/errand/${code}`, 'GET', null],
      [`/api/pets/9/errand/${code}/events`, 'POST', { kind: 'shared' }],
      [`/api/pets/9/errand/${code}/close`, 'POST', { approval: { public_key: 'a'.repeat(64), signature: 'b'.repeat(128) } }],
    ]);
    expect(fetchMock.mock.calls[1]![1].headers).toEqual({});
  });
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
  // spec: add-any-chain-feed › Cross-chain availability rule › changed quote
  it('keeps Worker response time with an accepted payment address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'a'.repeat(32), quote: {} },
      { headers: { date: 'Wed, 11 Nov 2026 20:35:00 GMT' } })));
    const answer = await workerApi.anyChainAccept('a'.repeat(32));
    expect(answer.serverTime).toBe('Wed, 11 Nov 2026 20:35:00 GMT');
  });
  // spec: add-hatch-again › Repeat ownership data › prior owner reads old memory
  it('recognizes the former-owner refusal body without exposing private memory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'former_owner' }, { status: 403 })));
    await expect(workerApi.conversation('identity-token', '9')).rejects.toMatchObject({ status: 403, code: 'former_owner' });
  });

  // spec: add-account › Showcase data › one copy for everyone
  it('reads the public Showcase copy without a session or request body', async () => {
    const copy = { pets: [], numbers: null };
    const fetchMock = vi.fn(async () => Response.json(copy));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.showcase()).toEqual(copy);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/showcase');
    expect(init.method).toBe('GET');
    expect(init.headers).not.toHaveProperty('privy-id-token');
    expect(init.body).toBeUndefined();
  });
  // spec: add-verification › Verification screen › success
  it('reads public list and selected thought through their exact paths, keeping words behind the session token', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'a'.repeat(24) }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.verificationIndex('9');
    await workerApi.verificationThought('identity', '9', 'a'.repeat(24));
    expect(fetchMock.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual([
      '/api/verification/pets/9', `/api/verification/pets/9/thoughts/${'a'.repeat(24)}`,
    ]);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty('privy-id-token');
    expect((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toHaveProperty('privy-id-token', 'identity');
  });
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

  // spec: add-hatch-again › Hatch again screen › birth closed for the day × 00:00 UTC
  it('carries the Worker response clock with Hatch and Home status reads', async () => {
    const headers = { date: 'Tue, 10 Nov 2026 23:59:55 GMT' };
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/me'
      ? { accountId: 'a', hatched: null, currentPet: null, ownedCount: 0, birth: { open: false, reason: 'daily' } }
      : { open: false, reason: 'daily' }, { headers })));
    expect((await workerApi.hatchStatus('t')).serverTime).toBe(headers.date);
    expect((await workerApi.me('t')).serverTime).toBe(headers.date);
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

  // spec: add-showcase › Judge admission data › private code checked
  it('sends a judge code only in a public POST body before Google', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.judgeCheck('sample-private-code');
    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe('/api/judge/check');
    expect(init.method).toBe('POST');
    expect(init.headers).not.toHaveProperty('privy-id-token');
    expect(JSON.parse(init.body as string)).toEqual({ code: 'sample-private-code' });
    expect(JSON.stringify({ url, headers: init.headers })).not.toContain('sample-private-code');
  });

  // spec: add-showcase › Judge admission data › admitted Google return
  it('sends the checked bearer only in the session body and maps a post-Google exhausted refusal', async () => {
    const fetchMock = vi.fn(async () => Response.json({ code: 'judge_exhausted' }, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.session('identity', { fresh: true, from: 'home', judgeCode: 'sample-private-code' })).toEqual({ refused: { reason: 'judge_exhausted' } });
    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe('/api/session');
    expect(JSON.parse(init.body as string)).toEqual({ fresh: true, from: 'home', judgeCode: 'sample-private-code' });
    expect(JSON.stringify({ url, headers: init.headers })).not.toContain('sample-private-code');
  });

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

  // spec: add-account › Memory deletion flow › unsettled shared job
  // spec: add-account › Memory deletion flow › close retry after memory clear
  it('sends only the signed close approval and preserves a confirmed-clear retry response', async () => {
    const approval = { public_key: 'a'.repeat(64), signature: 'b'.repeat(128) };
    const fetchMock = vi.fn(async () => Response.json({ code: 'close_retry' }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.clearMemory('t', '9', approval)).toEqual({ code: 'close_retry' });
    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe('/api/pets/9/memory/clear');
    expect(JSON.parse(String(init.body))).toEqual({ approval });
  });

  // spec: add-pet-errands › Friend-funded errand flow › new owner releases old reserve
  it('sends the new owner approval to the word-free reserve route', async () => {
    const approval = { public_key: 'a'.repeat(64), signature: 'b'.repeat(128) };
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.releaseSharedReserve('t', '9', approval)).toEqual({ ok: true });
    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe('/api/pets/9/shared-close');
    expect(JSON.parse(String(init.body))).toEqual({ approval });
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

describe('the Worker seam of feeding', () => {
  const calls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => c as unknown as [string, RequestInit]);

  // spec: add-feeding › Feed sheet screen › success (владелец)
  it('reads the sheet of a pet with the token, and takes a network that does not read as an answer', async () => {
    const fetchMock = vi.fn(async () => Response.json({ chain: false }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.feedSheet('t', '9')).toEqual({ chain: false });
    expect(calls(fetchMock)[0]).toMatchObject(['/api/pets/9/feed', { method: 'GET', headers: { 'privy-id-token': 't' } }]);
  });

  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it('asks for the portion by POST, sends the signed bytes, and keeps the code and the sheet of a refusal', async () => {
    const fetchMock = vi.fn(async () => Response.json({ tx: 'AAA' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.buildFeed('t', '9', '0.05')).toEqual({ tx: 'AAA' });
    expect(JSON.parse(calls(fetchMock)[0]![1].body as string)).toEqual({ portion: '0.05' });
    fetchMock.mockImplementation(async () => Response.json({ status: 'ok', hash: 'h', hatched: true }));
    expect(await workerApi.sendFeed('t', '9', { tx: 'AAA', signature: 'BBB' })).toEqual({ status: 'ok', hash: 'h', hatched: true });
    expect(calls(fetchMock)[1]![0]).toBe('/api/pets/9/feed/send');
    expect(JSON.parse(calls(fetchMock)[1]![1].body as string)).toEqual({ tx: 'AAA', signature: 'BBB' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'short', sheet: { chain: true } }, { status: 409 })));
    await expect(workerApi.buildFeed('t', '9', '0.2')).rejects.toMatchObject({ status: 409, code: 'short', body: { sheet: { chain: true } } });
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен
  it('waits for a send as long as the server may hold it, which is longer than a plain request', async () => {
    const { deadline, timeout } = blackHole();
    const asked = workerApi.sendFeed('t', '9', { tx: 'AAA', signature: 'BBB' });
    deadline.abort();
    await expect(asked).rejects.toMatchObject({ status: 0, code: 'unreachable' });
    expect(timeout).toHaveBeenCalledWith(FEED_SEND_TIMEOUT_MS);
    expect(FEED_SEND_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
  });

  // spec: add-feeding › Feeding outcome rule › closed on its way × session ended
  it('asks for an outcome and the snack by POST, and the wallet by GET', async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: 'unknown', hatched: false }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.feedOutcome('t', '9', { id: 'abc', source: 'snack' });
    await workerApi.snack('t', '9');
    vi.stubGlobal('fetch', fetchMock.mockImplementation(async () => Response.json({ address: 'a', balance: '1', funded: false })));
    await workerApi.wallet('t');
    const made = calls(fetchMock);
    expect(made.map(([url, init]) => `${init.method} ${url}`)).toEqual(['POST /api/pets/9/feed/outcome', 'POST /api/pets/9/snack', 'GET /api/wallet']);
    expect(JSON.parse(made[0]![1].body as string)).toEqual({ id: 'abc', source: 'snack' });
  });

  // spec: add-pet › Sleep and wake flow › разбудил друг при открытой странице
  it('sends the wakes the page knows with the state, and the job when there is one', async () => {
    const fetchMock = vi.fn(async () => Response.json({ events: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.petState('t', '9');
    await workerApi.petState('t', '9', 'j1');
    await workerApi.petState('t', '9', undefined, 0);
    await workerApi.petState('t', '9', 'j1', 3);
    expect(calls(fetchMock).map(([url]) => url)).toEqual([
      '/api/pets/9/state',
      '/api/pets/9/state?job=j1',
      '/api/pets/9/state?wakes=0',
      '/api/pets/9/state?job=j1&wakes=3',
    ]);
  });
});

describe('the Worker seam of the Diary', () => {
  const calls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => c as unknown as [string, RequestInit]);

  // spec: add-daily-ritual › Diary screen › success
  it('reads the diary with the token by GET, and keeps the code of a pet that is not theirs any more', async () => {
    const fetchMock = vi.fn(async () => Response.json({ day: 20757 }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.diary('t', '9');
    expect(calls(fetchMock)[0]).toMatchObject(['/api/pets/9/diary', { method: 'GET', headers: { 'privy-id-token': 't' } }]);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'not_owner' }, { status: 403 })));
    await expect(workerApi.diary('t', '9')).rejects.toMatchObject({ status: 403, code: 'not_owner' });
  });

  // spec: add-daily-ritual › Daily ritual flow › встречает дневником
  it('sends the read mark with the diary\'s day by POST', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.readDiary('t', '9', 20757)).toEqual({ ok: true });
    const [url, init] = calls(fetchMock)[0]!;
    expect(`${init.method} ${url}`).toBe('POST /api/pets/9/diary/read');
    expect(JSON.parse(init.body as string)).toEqual({ day: 20757 });
  });

  // spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня
  it('sends the answer to the question as text and day, takes the 202 job, and keeps the code of a 409', async () => {
    const fetchMock = vi.fn(async () => Response.json({ job: 'j' }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.answerQuestion('t', '9', { text: 'It did.', day: 20757 })).toEqual({ job: 'j' });
    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe('/api/pets/9/diary/answer');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'It did.', day: 20757 });
    for (const code of ['paused', 'late', 'no_question', 'already']) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code }, { status: 409 })));
      await expect(workerApi.answerQuestion('t', '9', { text: 'It did.', day: 20757 })).rejects.toMatchObject({ status: 409, code });
    }
  });

  // spec: add-daily-ritual › Riddle rule › ответ принят
  it('sends the riddle answer with the day it was typed for, takes its status, and keeps the code of a 409', async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: 'late' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.answerRiddle('t', '9', { text: 'a clock', day: 20756 })).toEqual({ status: 'late' });
    const [url, init] = calls(fetchMock)[0]!;
    expect(`${init.method} ${url}`).toBe('POST /api/pets/9/riddle');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'a clock', day: 20756 });
    for (const code of ['asleep', 'not_sealed']) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code }, { status: 409 })));
      await expect(workerApi.answerRiddle('t', '9', { text: 'a clock', day: 20757 })).rejects.toMatchObject({ status: 409, code });
    }
  });
});

describe('the work routes', () => {
  const calls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => c as unknown as [string, RequestInit]);
  const once = (body: unknown, status = 200) => {
    const fetchMock = vi.fn(async () => Response.json(body, { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  // spec: add-pet-work › Hire mode rule › Ask me first
  it('switches the hiring mode by PUT with the mode and nothing else, and keeps the code of a 409', async () => {
    const fetchMock = once({ mode: 'manual' });
    expect(await workerApi.setHireMode('t', '9', 'manual')).toEqual({ mode: 'manual' });
    const [url, init] = calls(fetchMock)[0]!;
    expect(`${init.method} ${url}`).toBe('PUT /api/pets/9/hire-mode');
    expect(JSON.parse(init.body as string)).toEqual({ mode: 'manual' });
    once({ code: 'asleep' }, 409);
    await expect(workerApi.setHireMode('t', '9', 'auto')).rejects.toMatchObject({ status: 409, code: 'asleep' });
  });

  // spec: add-pet-work › Pet hire flow › предложение в Manual
  it('answers an offer by POST: «Ask» with the price the card named, «No thanks» and «Try again» with nothing; the 202 job comes back', async () => {
    const fetchMock = once({ job: 'j1' }, 202);
    expect(await workerApi.askOffer('t', '9', '380000000000000000000')).toEqual({ job: 'j1' });
    expect(await workerApi.declineOffer('t', '9')).toEqual({ job: 'j1' });
    expect(await workerApi.finishHire('t', '9')).toEqual({ job: 'j1' });
    const [ask, decline, finish] = calls(fetchMock);
    expect(`${ask![1].method} ${ask![0]}`).toBe('POST /api/pets/9/offer/ask');
    expect(JSON.parse(ask![1].body as string)).toEqual({ price: '380000000000000000000' });
    expect(`${decline![1].method} ${decline![0]}`).toBe('POST /api/pets/9/offer/decline');
    expect(`${finish![1].method} ${finish![0]}`).toBe('POST /api/pets/9/hire/finish');
    for (const code of ['paused', 'no_offer']) {
      once({ code }, 409);
      await expect(workerApi.askOffer('t', '9', '1')).rejects.toMatchObject({ status: 409, code });
    }
  });

  // spec: add-pet-work › Advice flow › вопрос отправлен
  it('reads the advice column with the payer in the query and sends the question with its payer and the price shown', async () => {
    const fetchMock = once({ price: { yocto: '1', cents: 0.38 }, skilled: false, workerAsleep: false, resting: null, payer: { tokenId: '9', name: 'Pixel', state: 'ok', until: null }, dropsAt: null, pending: null, last: null });
    expect((await workerApi.advice('t', '2', '9')).price.cents).toBe(0.38);
    expect(`${calls(fetchMock)[0]![1].method} ${calls(fetchMock)[0]![0]}`).toBe('GET /api/pets/2/advice?payer=9');
    const asked = once({ job: 'j2' }, 202);
    expect(await workerApi.askAdvice('t', '2', { payer: '9', text: 'How?', price: '380' })).toEqual({ job: 'j2' });
    expect(`${calls(asked)[0]![1].method} ${calls(asked)[0]![0]}`).toBe('POST /api/pets/2/advice');
    expect(JSON.parse(calls(asked)[0]![1].body as string)).toEqual({ payer: '9', text: 'How?', price: '380' });
    once({ code: 'not_payer' }, 403);
    await expect(workerApi.advice('t', '2', '7')).rejects.toMatchObject({ status: 403, code: 'not_payer' });
  });

  // spec: add-pet-work › Skill writing flow › skill saved
  it('reads, saves and forgets the skill on its own route, and keeps the code of a label not accepted', async () => {
    const read = once({ skill: { label: 'charts', instruction: 'Explain charts.' } });
    expect((await workerApi.skill('t', '9')).skill?.label).toBe('charts');
    expect(`${calls(read)[0]![1].method} ${calls(read)[0]![0]}`).toBe('GET /api/pets/9/skill');
    const saved = once({ skill: { label: 'charts' } });
    expect(await workerApi.saveSkill('t', '9', { label: 'charts', instruction: 'Explain charts.' })).toEqual({ skill: { label: 'charts' } });
    expect(`${calls(saved)[0]![1].method} ${calls(saved)[0]![0]}`).toBe('PUT /api/pets/9/skill');
    expect(JSON.parse(calls(saved)[0]![1].body as string)).toEqual({ label: 'charts', instruction: 'Explain charts.' });
    const gone = once({ skill: null });
    expect(await workerApi.forgetSkill('t', '9')).toEqual({ skill: null });
    expect(`${calls(gone)[0]![1].method} ${calls(gone)[0]![0]}`).toBe('DELETE /api/pets/9/skill');
    once({ code: 'bad_label' }, 400);
    await expect(workerApi.saveSkill('t', '9', { label: 'x', instruction: 'y' })).rejects.toMatchObject({ status: 400, code: 'bad_label' });
  });
});

describe('the wardrobe routes', () => {
  const calls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => c as unknown as [string, RequestInit]);

  // spec: add-wardrobe › Wardrobe screen › success
  it('reads the wardrobe with the token by GET, and keeps the code of a pet that is not theirs any more', async () => {
    const fetchMock = vi.fn(async () => Response.json({ owned: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.wardrobe('t', '9');
    expect(calls(fetchMock)[0]).toMatchObject(['/api/pets/9/wardrobe', { method: 'GET', headers: { 'privy-id-token': 't' } }]);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'not_owner' }, { status: 403 })));
    await expect(workerApi.wardrobe('t', '9')).rejects.toMatchObject({ status: 403, code: 'not_owner' });
  });

  // spec: add-wardrobe › Outfit rule › надел
  it('sends the item to wear by POST, and null to take it off, and keeps the code of a 409', async () => {
    const fetchMock = vi.fn(async () => Response.json({ worn: 'bow-tie' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.wear('t', '9', 'bow-tie')).toEqual({ worn: 'bow-tie' });
    await workerApi.wear('t', '9', null);
    const [first, second] = calls(fetchMock);
    expect(`${first![1].method} ${first![0]}`).toBe('POST /api/pets/9/wardrobe/wear');
    expect(JSON.parse(first![1].body as string)).toEqual({ item: 'bow-tie' });
    expect(JSON.parse(second![1].body as string)).toEqual({ item: null });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'not_owned' }, { status: 409 })));
    await expect(workerApi.wear('t', '9', 'bow-tie')).rejects.toMatchObject({ status: 409, code: 'not_owned' });
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает
  it('sends the item to buy by POST, takes the 202 id, and keeps the codes of a 409', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'b1' }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.buy('t', '9', 'smart-glasses')).toEqual({ id: 'b1' });
    const [url, init] = calls(fetchMock)[0]!;
    expect(`${init.method} ${url}`).toBe('POST /api/pets/9/wardrobe/buy');
    expect(JSON.parse(init.body as string)).toEqual({ item: 'smart-glasses' });
    for (const code of ['owned', 'paused']) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code }, { status: 409 })));
      await expect(workerApi.buy('t', '9', 'smart-glasses')).rejects.toMatchObject({ status: 409, code });
    }
  });

  // spec: add-wardrobe › New outfit notice screen › success
  it('tells the server a notice was shown with the item\'s name and nothing else', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.seenOutfit('t', '9', 'cozy-scarf')).toEqual({ ok: true });
    const [url, init] = calls(fetchMock)[0]!;
    expect(`${init.method} ${url}`).toBe('POST /api/pets/9/wardrobe/seen');
    expect(JSON.parse(init.body as string)).toEqual({ item: 'cozy-scarf' });
  });
});

describe('the errand routes', () => {
  const calls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => c as unknown as [string, RequestInit]);

  // spec: add-pet-errands › Errand sheet screen › success
  it('reads the quote of a form by GET with the token, and keeps the code and the body of a refusal', async () => {
    const fetchMock = vi.fn(async () => Response.json({ form: 'find' }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.errand('t', '9', 'find');
    expect(calls(fetchMock)[0]).toMatchObject(['/api/pets/9/errand?form=find', { method: 'GET', headers: { 'privy-id-token': 't' } }]);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'not_owner' }, { status: 403 })));
    await expect(workerApi.errand('t', '9', 'read')).rejects.toMatchObject({ status: 403, code: 'not_owner' });
  });

  // spec: add-pet-errands › Errand flow › sent
  it('sends the form and the job by POST, takes the 202 job, and keeps the block of a 409', async () => {
    const fetchMock = vi.fn(async () => Response.json({ job: 'j1' }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await workerApi.sendErrand('t', '9', { form: 'check', job: 'Octopuses have three hearts.' })).toEqual({ job: 'j1' });
    const [url, init] = calls(fetchMock)[0]!;
    expect(`${init.method} ${url}`).toBe('POST /api/pets/9/errand');
    expect(JSON.parse(init.body as string)).toEqual({ form: 'check', job: 'Octopuses have three hearts.' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'blocked', block: { reason: 'energy', until: '2026-11-04T00:00:00.000Z' } }, { status: 409 })));
    await expect(workerApi.sendErrand('t', '9', { form: 'find', job: 'x' })).rejects.toMatchObject({ status: 409, code: 'blocked', body: { block: { reason: 'energy' } } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'away' }, { status: 409 })));
    await expect(workerApi.sendErrand('t', '9', { form: 'find', job: 'x' })).rejects.toMatchObject({ status: 409, code: 'away' });
  });

  // spec: add-pet-errands › Adapter connect flow › address answered
  it('checks an address by POST, saves and edits a source, and removes it', async () => {
    const fetchMock = vi.fn(async () => Response.json({ tools: [], source: {}, removed: true }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.checkSource('t', '9', 'https://mcp.example.com/daybook');
    await workerApi.saveSource('t', '9', { label: 'Daybook', address: 'https://mcp.example.com/daybook', ticks: ['events_on'] });
    await workerApi.editSource('t', '9', 'abc', { label: 'Daybook', ticks: [] });
    await workerApi.removeSource('t', '9', 'abc');
    const seen = calls(fetchMock).map(([url, init]) => `${init.method} ${url}${init.body ? ` ${init.body as string}` : ''}`);
    expect(seen).toEqual([
      'POST /api/pets/9/sources/check {"address":"https://mcp.example.com/daybook"}',
      'POST /api/pets/9/sources {"label":"Daybook","address":"https://mcp.example.com/daybook","ticks":["events_on"]}',
      'PUT /api/pets/9/sources/abc {"label":"Daybook","ticks":[]}',
      'DELETE /api/pets/9/sources/abc',
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'address_failed' }, { status: 422 })));
    await expect(workerApi.checkSource('t', '9', 'https://x.example.com/mcp')).rejects.toMatchObject({ status: 422, code: 'address_failed' });
  });

  // spec: add-pet-errands › Catalog flow › publish
  it('publishes and takes out on the source\'s publish route, and reads the catalog of anyone', async () => {
    const fetchMock = vi.fn(async () => Response.json({ source: {}, entries: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.publishSource('t', '9', 'abc');
    await workerApi.unpublishSource('t', '9', 'abc');
    await workerApi.adapters(null);
    const seen = calls(fetchMock).map(([url, init]) => `${init.method} ${url}`);
    expect(seen).toEqual(['POST /api/pets/9/sources/abc/publish', 'DELETE /api/pets/9/sources/abc/publish', 'GET /api/adapters']);
    expect(calls(fetchMock)[2]![1].headers).toEqual({});
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'insult' }, { status: 409 })));
    await expect(workerApi.publishSource('t', '9', 'abc')).rejects.toMatchObject({ status: 409, code: 'insult' });
  });

  // spec: add-pet-errands › Skill code flow › test passed
  it('reads, tests, saves and removes the skill\'s code on its own routes', async () => {
    const fetchMock = vi.fn(async () => Response.json({ code: null, outcome: 'ok', removed: true }));
    vi.stubGlobal('fetch', fetchMock);
    await workerApi.code('t', '9');
    await workerApi.testCode('t', '9', { code: 'export const x = 1;', fn: 'openerFor', values: '11, 3' });
    await workerApi.saveCode('t', '9', { code: 'export const x = 1;', ticks: ['openerFor'] });
    await workerApi.removeCode('t', '9');
    const seen = calls(fetchMock).map(([url, init]) => `${init.method} ${url}${init.body ? ` ${init.body as string}` : ''}`);
    expect(seen).toEqual([
      'GET /api/pets/9/code',
      'POST /api/pets/9/code/test {"code":"export const x = 1;","fn":"openerFor","values":"11, 3"}',
      'PUT /api/pets/9/code {"code":"export const x = 1;","ticks":["openerFor"]}',
      'DELETE /api/pets/9/code',
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'tests_used_up' }, { status: 429 })));
    await expect(workerApi.testCode('t', '9', { code: 'x', fn: 'f', values: '' })).rejects.toMatchObject({ status: 429, code: 'tests_used_up' });
  });
});
