import { actions, createTransaction } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicKeyFromImplicitAccount } from '../near/privySigner';
import { WorkerError, type FeedOutcome } from '../seams/worker-types';

const mocks = vi.hoisted(() => ({
  buildFeed: vi.fn(),
  sendFeed: vi.fn(),
  feedOutcome: vi.fn(),
  snack: vi.fn(),
  pet: vi.fn(),
}));
vi.mock('../seams/worker', async () => ({ ...(await import('../seams/worker-types')), workerApi: mocks }));
vi.mock('../config', () => ({ config: { contractId: 'nearling-dev.testnet' } }));
// the digest runs off the main thread and would outlast the fake clock's turns; the hash itself is feedTx.test.ts's
vi.mock('./feedTx', async (original) => ({ ...(await original<typeof import('./feedTx')>()), sha256Hex: async () => 'ab'.repeat(32) }));

import { CHECKING_MS, REPEAT_MS, currentFlight, onFlight, resetFlight, startMeal, startSnack, watchFlight, type FlightEvent, type FlightHost } from './feedFlight';
import { onFed, type FedEvent } from './feedRequest';
import { PORTION_YOCTO, toBase64 } from './feedTx';

const ACCOUNT = 'a1'.repeat(32);
const BLOCK = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

/** The transaction as the Worker builds it for a portion of this pet. */
function built(portion: keyof typeof PORTION_YOCTO = '0.05', tokenId = '9'): { tx: string } {
  const call = actions.functionCall('pet_feed', { token_id: tokenId }, 5_000_000_000_000n, PORTION_YOCTO[portion]);
  return { tx: toBase64(createTransaction(ACCOUNT, publicKeyFromImplicitAccount(ACCOUNT), 'nearling-dev.testnet', 7n, [call], BLOCK).encode()) };
}

const ok = (over: Partial<FeedOutcome> = {}): FeedOutcome => ({ status: 'ok', hash: 'H'.repeat(44), hatched: true, ...over });
const unknown: FeedOutcome = { status: 'unknown', hatched: true };
const refusal = (status: number, code: string, body: unknown = null) => new WorkerError(status, code, body);

let host: FlightHost;
let events: FlightEvent[];
let fed: FedEvent[];
let stopFed: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  for (const m of Object.values(mocks)) m.mockReset();
  host = {
    account: ACCOUNT,
    token: vi.fn(async () => 'token'),
    sign: vi.fn(async () => new Uint8Array(64).fill(7)),
    endSession: vi.fn(),
  };
  events = [];
  fed = [];
  onFlight((e) => events.push(e));
  stopFed = onFed((e) => fed.push(e));
  mocks.buildFeed.mockResolvedValue(built());
});

afterEach(() => {
  stopFed();
  resetFlight();
  vi.useRealTimers();
});

const ended = () => events.filter((e): e is Extract<FlightEvent, { kind: 'ended' }> => e.kind === 'ended');
const meal = (over: Partial<Parameters<typeof startMeal>[1]> = {}) => startMeal(host, { tokenId: '9', portion: '0.05', wasAsleep: false, ...over });

describe('the meal on its way', () => {
  // spec: add-feeding › Feeding outcome rule › отправлено
  it('builds, checks, signs and sends at the tap; a second portion is never started while one stands', async () => {
    mocks.sendFeed.mockResolvedValue(ok());
    expect(meal()).toBe(true);
    // a second tap, any portion, any pet, starts nothing
    expect(meal({ portion: '0.2' })).toBe(false);
    expect(startSnack(host, { tokenId: '2', wasAsleep: false })).toBe(false);
    expect(currentFlight()).toMatchObject({ tokenId: '9', source: 'near', checking: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.buildFeed).toHaveBeenCalledTimes(1);
    expect(mocks.buildFeed).toHaveBeenCalledWith('token', '9', '0.05');
    expect(host.sign).toHaveBeenCalledTimes(1);
    expect(mocks.sendFeed).toHaveBeenCalledTimes(1);
    expect(ended()).toHaveLength(1);
    expect(ended()[0]!.end).toEqual({ status: 'ok', hatched: true });
    expect(currentFlight()).toBeNull();
  });

  // spec: add-feeding › Feeding outcome rule › closed on its way
  it('closing the sheet aborts nothing: with no listener the meal goes on, and the page is told at the outcome', async () => {
    resetFlight(); // no sheet listens: the sheet that was closed is gone
    let release!: (o: FeedOutcome) => void;
    mocks.sendFeed.mockReturnValue(new Promise<FeedOutcome>((resolve) => (release = resolve)));
    meal();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(currentFlight()).not.toBeNull();
    release(ok());
    await vi.advanceTimersByTimeAsync(0);
    expect(currentFlight()).toBeNull();
    expect(fed).toEqual([{ kind: 'fed', tokenId: '9', source: 'near' }]);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен
  it('10 s after the tap «Still checking…» turns on, once, whatever the request is doing; not after the end', async () => {
    let release!: (o: FeedOutcome) => void;
    mocks.sendFeed.mockReturnValue(new Promise<FeedOutcome>((resolve) => (release = resolve)));
    meal();
    await vi.advanceTimersByTimeAsync(CHECKING_MS - 100);
    expect(events).toEqual([]);
    expect(currentFlight()!.checking).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(events.map((e) => e.kind)).toEqual(['checking']);
    expect(currentFlight()!.checking).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events.map((e) => e.kind)).toEqual(['checking']);
    release(ok());
    await vi.advanceTimersByTimeAsync(0);
    expect(events.map((e) => e.kind)).toEqual(['checking', 'ended']);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен × the repeat of the same bytes
  it('`unknown` or no answer repeats /send every 5 s with the same signed bytes — never a new build or signature', async () => {
    mocks.sendFeed.mockResolvedValueOnce(unknown).mockRejectedValueOnce(refusal(0, 'unreachable')).mockRejectedValueOnce(refusal(503, 'chain_unreachable')).mockResolvedValue(ok());
    meal();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sendFeed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(mocks.sendFeed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(mocks.sendFeed).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(mocks.sendFeed).toHaveBeenCalledTimes(4);
    const bodies = mocks.sendFeed.mock.calls.map((c) => c[2]);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(mocks.buildFeed).toHaveBeenCalledTimes(1);
    expect(host.sign).toHaveBeenCalledTimes(1);
    expect(ended()[0]!.end.status).toBe('ok');
  });

  // spec: add-feeding › Feeding outcome rule › closed on its way × session ended
  it('a 401 on a repeat stops this tab\'s asking: no message, the session ends and the page stands', async () => {
    mocks.sendFeed.mockResolvedValueOnce(unknown).mockRejectedValue(refusal(401, 'signed_out'));
    meal();
    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(mocks.sendFeed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.sendFeed).toHaveBeenCalledTimes(2);
    expect(host.endSession).toHaveBeenCalledWith(true);
    expect(ended()).toEqual([]);
    expect(currentFlight()).toBeNull();
    expect(fed).toEqual([]);
  });

  // spec: add-feeding › Feeding outcome rule › closed on its way × session ended
  it('a 401 under the tap itself sends nothing and closes the sheet with the line', async () => {
    mocks.buildFeed.mockRejectedValue(refusal(401, 'signed_out'));
    meal();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sendFeed).not.toHaveBeenCalled();
    expect(host.endSession).toHaveBeenCalledWith(true, true);
    expect(ended()[0]!.end).toEqual({ status: 'session' });
  });

  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it('a transaction that is not the tapped portion is not signed and not sent', async () => {
    mocks.buildFeed.mockResolvedValue(built('0.2'));
    meal({ portion: '0.05' });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.sign).not.toHaveBeenCalled();
    expect(mocks.sendFeed).not.toHaveBeenCalled();
    expect(ended()[0]!.end).toEqual({ status: 'failed' });
  });

  // spec: add-feeding › Feeding outcome rule › не прошло
  it('a refusal of the network is «не прошло»; nothing was signed when the build failed', async () => {
    mocks.buildFeed.mockRejectedValue(refusal(502, 'feed_not_built'));
    meal();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.sign).not.toHaveBeenCalled();
    expect(ended()[0]!.end).toEqual({ status: 'failed' });
    mocks.buildFeed.mockResolvedValue(built());
    mocks.sendFeed.mockResolvedValue({ status: 'failed', hatched: true });
    meal();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended()[1]!.end).toEqual({ status: 'failed' });
    mocks.sendFeed.mockRejectedValue(refusal(400, 'bad_tx'));
    meal();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended()[2]!.end).toEqual({ status: 'failed' });
  });

  // spec: add-feeding › Feed sheet screen › мало NEAR
  it('`409 short` and a network that does not read redraw the sheet from the answer', async () => {
    const sheet = { chain: true as const, name: 'Pixel' };
    mocks.buildFeed.mockRejectedValueOnce(refusal(409, 'short', { code: 'short', sheet }));
    meal();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended()[0]!.end).toEqual({ status: 'redraw', sheet });
    mocks.buildFeed.mockRejectedValueOnce(refusal(503, 'chain_unreachable'));
    meal();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended()[1]!.end).toEqual({ status: 'redraw', sheet: { chain: false } });
  });

  // spec: add-feeding › Feeding outcome rule › отправлено
  it('`409 pending` — another request of the player\'s holds a meal — is waited for by its row, «Still checking…» at once', async () => {
    mocks.buildFeed.mockRejectedValue(refusal(409, 'pending'));
    mocks.pet.mockResolvedValue({ viewer: 'owner', myFeed: { id: 'F'.repeat(44), source: 'near' } });
    mocks.feedOutcome.mockResolvedValueOnce(unknown).mockResolvedValue(ok());
    meal();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.map((e) => e.kind)).toEqual(['checking']);
    expect(mocks.feedOutcome).toHaveBeenCalledWith('token', '9', { id: 'F'.repeat(44), source: 'near' });
    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(ended()[0]!.end.status).toBe('ok');
    expect(mocks.sendFeed).not.toHaveBeenCalled();
  });
});

describe('the snack on its way', () => {
  // spec: add-feeding › Owner snack flow › даёт перекус
  it('the server sends it: nothing is built or signed, the outcome is the answer', async () => {
    mocks.snack.mockResolvedValue(ok({ hash: undefined }));
    startSnack(host, { tokenId: '9', wasAsleep: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.buildFeed).not.toHaveBeenCalled();
    expect(host.sign).not.toHaveBeenCalled();
    expect(ended()[0]).toMatchObject({ flight: { source: 'snack', wasAsleep: true }, end: { status: 'ok' } });
    expect(fed).toEqual([{ kind: 'fed', tokenId: '9', source: 'snack' }]);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен
  it('no answer: the row\'s id comes from `myFeed`, and the outcome is asked every 5 s', async () => {
    mocks.snack.mockRejectedValue(refusal(0, 'unreachable'));
    mocks.pet.mockResolvedValue({ viewer: 'guest', myFeed: { id: 'ab'.repeat(12), source: 'snack' } });
    mocks.feedOutcome.mockResolvedValueOnce(unknown).mockResolvedValueOnce(unknown).mockResolvedValue(ok({ friend: 'Maya' }));
    startSnack(host, { tokenId: '2', wasAsleep: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.feedOutcome).toHaveBeenCalledWith('token', '2', { id: 'ab'.repeat(12), source: 'snack' });
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 2);
    expect(mocks.feedOutcome).toHaveBeenCalledTimes(3);
    expect(ended()[0]!.end).toEqual({ status: 'ok', hatched: true, friend: 'Maya' });
  });

  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня
  it('`snack_gone` redraws the sheet as it stands now', async () => {
    const sheet = { chain: true as const, name: 'Biscuit' };
    mocks.snack.mockRejectedValue(refusal(409, 'snack_gone', { code: 'snack_gone', sheet }));
    startSnack(host, { tokenId: '2', wasAsleep: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended()[0]!.end).toEqual({ status: 'redraw', sheet });
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен
  it('no answer and no row of ours: the sheet reads again and the page looks at the pet', async () => {
    mocks.snack.mockRejectedValue(refusal(0, 'unreachable'));
    mocks.pet.mockResolvedValue({ viewer: 'guest', myFeed: null });
    startSnack(host, { tokenId: '2', wasAsleep: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended()[0]!.end).toEqual({ status: 'reread' });
    expect(fed).toHaveLength(1);
  });
});

describe('the identity token at the tap', () => {
  // spec: add-feeding › Feeding outcome rule › исход неизвестен × the identity token out of reach
  it('Privy out of reach at a meal\'s tap is «не прошло» with nothing built, signed or sent, and the next tap is taken', async () => {
    (host.token as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('privy unreachable'));
    expect(meal()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended().map((e) => e.end)).toEqual([{ status: 'failed' }]);
    expect(currentFlight()).toBeNull();
    expect(mocks.buildFeed).not.toHaveBeenCalled();
    expect(host.sign).not.toHaveBeenCalled();
    expect(mocks.sendFeed).not.toHaveBeenCalled();
    mocks.sendFeed.mockResolvedValue(ok());
    expect(meal()).toBe(true);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен × the identity token out of reach
  it('the same for the snack\'s tap', async () => {
    (host.token as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('privy unreachable'));
    expect(startSnack(host, { tokenId: '9', wasAsleep: true })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended().map((e) => e.end)).toEqual([{ status: 'failed' }]);
    expect(currentFlight()).toBeNull();
    expect(mocks.snack).not.toHaveBeenCalled();
    mocks.snack.mockResolvedValue(ok());
    expect(startSnack(host, { tokenId: '9', wasAsleep: true })).toBe(true);
  });
});

describe('a flight the server knows and this tab does not', () => {
  // spec: add-feeding › Feeding transaction data › outcome with the sheet closed
  it('after a reload the tab watches /feed/outcome with the id it was given, «Still checking…» from the start', async () => {
    mocks.feedOutcome.mockResolvedValueOnce(unknown).mockResolvedValue(ok());
    expect(watchFlight(host, { tokenId: '9', id: 'F'.repeat(44), source: 'near', wasAsleep: false })).toBe(true);
    expect(currentFlight()).toMatchObject({ checking: true, signed: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.feedOutcome).toHaveBeenCalledWith('token', '9', { id: 'F'.repeat(44), source: 'near' });
    expect(ended()).toEqual([]);
    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(ended()[0]!.end.status).toBe('ok');
    expect(fed).toEqual([{ kind: 'fed', tokenId: '9', source: 'near' }]);
    // the timer of 10 s was never set for it
    await vi.advanceTimersByTimeAsync(CHECKING_MS * 2);
    expect(events.filter((e) => e.kind === 'checking')).toEqual([]);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен
  it('a watched flight whose row went away ends after a few asks: the page and the sheet read again', async () => {
    mocks.feedOutcome.mockResolvedValue({ ...unknown, settled: true });
    watchFlight(host, { tokenId: '9', id: 'F'.repeat(44), source: 'near', wasAsleep: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended()).toEqual([]);
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 2);
    expect(mocks.feedOutcome).toHaveBeenCalledTimes(3);
    expect(ended()[0]!.end).toEqual({ status: 'reread' });
    expect(currentFlight()).toBeNull();
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 3);
    expect(mocks.feedOutcome).toHaveBeenCalledTimes(3);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен
  it('a settled answer between unknowns of a standing row does not end the watch early', async () => {
    mocks.feedOutcome
      .mockResolvedValueOnce({ ...unknown, settled: true })
      .mockResolvedValueOnce({ ...unknown, settled: true })
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce({ ...unknown, settled: true })
      .mockResolvedValue(ok());
    watchFlight(host, { tokenId: '9', id: 'F'.repeat(44), source: 'near', wasAsleep: false });
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 4);
    expect(ended()[0]!.end.status).toBe('ok');
  });

  // spec: add-feeding › Feeding outcome rule › closed on its way × session ended
  it('a 401 ends its asking without a message', async () => {
    mocks.feedOutcome.mockRejectedValue(refusal(401, 'signed_out'));
    watchFlight(host, { tokenId: '9', id: 'F'.repeat(44), source: 'near', wasAsleep: false });
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 3);
    expect(mocks.feedOutcome).toHaveBeenCalledTimes(1);
    expect(host.endSession).toHaveBeenCalledWith(true);
    expect(ended()).toEqual([]);
  });

  // spec: add-feeding › Own pet feeding flow › разбудил × a reload with the meal on its way
  it('the pet that sleeps on the page is the flight\'s: a meal confirmed after a reload wakes it', () => {
    watchFlight(host, { tokenId: '9', id: 'F'.repeat(44), source: 'near', wasAsleep: true });
    expect(currentFlight()).toMatchObject({ wasAsleep: true });
  });
});
