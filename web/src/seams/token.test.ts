import { describe, expect, it, vi } from 'vitest';
import { isSessionEnded, makeTokenKeeper, tokenEnds } from './token';

const jwt = (exp: number) => `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`;
const NOW = 1_800_000_000_000;
const clock = () => NOW;
const inSeconds = (s: number) => NOW / 1000 + s;

describe('the identity token', () => {
  // spec: add-pet › Pet screen › success (владелец)
  it('calls Privy once while the token holds: polling the pet is no call to Privy', async () => {
    const ask = vi.fn(async () => jwt(inSeconds(3600)));
    const keeper = makeTokenKeeper(ask, clock);
    for (let i = 0; i < 12; i += 1) await keeper.get();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  // spec: add-pet › Pet screen › success (владелец)
  it('asks again a minute before the token ends, and two callers at once share the one call', async () => {
    const ask = vi.fn(async () => jwt(inSeconds(59)));
    const keeper = makeTokenKeeper(ask, clock);
    await Promise.all([keeper.get(), keeper.get()]);
    expect(ask).toHaveBeenCalledTimes(1);
    await keeper.get();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  // spec: add-pet › Birth flow › вылупился
  it('asks again after `forget`: the first token after the wallet carries the wallet', async () => {
    const ask = vi.fn(async () => jwt(inSeconds(3600)));
    const keeper = makeTokenKeeper(ask, clock);
    await keeper.get();
    keeper.forget();
    await keeper.get();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  // spec: add-pet › Pet screen › signed-out × сессия истекла посреди игры
  it('turns Privy\'s refusal into no session, so the visitor path runs', async () => {
    const ask = vi.fn(() => Promise.reject(Object.assign(new Error('x'), { type: 'api_error', status: 401 })));
    const keeper = makeTokenKeeper(ask, clock);
    await expect(keeper.get()).resolves.toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(isSessionEnded({ privyErrorCode: 'missing_or_invalid_token' })).toBe(true);
    expect(isSessionEnded({ privyErrorCode: 'must_be_authenticated' })).toBe(true);
  });

  // spec: D-165 › Privy 429 during identity token refresh
  it('retries a 429 and keeps the resulting token in tab memory', async () => {
    const ask = vi.fn().mockRejectedValueOnce(Object.assign(new Error('rate limit'), { status: 429 }))
      .mockResolvedValue(jwt(inSeconds(3600)));
    const keeper = makeTokenKeeper(ask, clock);
    await expect(keeper.get()).resolves.toBe(jwt(inSeconds(3600)));
    await expect(keeper.get()).resolves.toBe(jwt(inSeconds(3600)));
    expect(ask).toHaveBeenCalledTimes(2);
  });

  // spec: add-pet › Connection rule › сервер недоступен
  it('leaves a network failure an error: the owner stays signed in and sees the connection line', async () => {
    vi.useFakeTimers();
    const down = Object.assign(new Error('Request timed out'), { type: 'client_error', privyErrorCode: 'client_request_timeout' });
    const ask = vi.fn(() => Promise.reject(down));
    const keeper = makeTokenKeeper(ask, clock);
    const result = keeper.get();
    const rejected = expect(result).rejects.toBe(down);
    await vi.advanceTimersByTimeAsync(5_100);
    await rejected;
    expect(ask).toHaveBeenCalledTimes(4);
    expect(isSessionEnded(new TypeError('Failed to fetch'))).toBe(false);
    expect(isSessionEnded(null)).toBe(false);
    vi.useRealTimers();
  });

  // spec: add-pet › Pet screen › signed-out × сессия истекла посреди игры
  it('keeps nothing from an ask that was in flight when `forget` ran: the next sign-in asks again', async () => {
    let finish: (token: string) => void = () => undefined;
    const ask = vi
      .fn<() => Promise<string | null>>()
      .mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)))
      .mockResolvedValue(jwt(inSeconds(3600)));
    const keeper = makeTokenKeeper(ask, clock);
    const old = keeper.get();
    keeper.forget();
    finish(jwt(inSeconds(1800)));
    await expect(old).resolves.toBe(jwt(inSeconds(1800)));
    expect(await keeper.get()).toBe(jwt(inSeconds(3600)));
    expect(ask).toHaveBeenCalledTimes(2);
  });

  // spec: add-pet › Pet screen › success (владелец)
  it('does not keep a token it cannot read, and takes no `null` for a token', async () => {
    expect(tokenEnds('not-a-jwt')).toBeNull();
    expect(tokenEnds('a.%%%.c')).toBeNull();
    const ask = vi.fn(async () => 'not-a-jwt');
    const keeper = makeTokenKeeper(ask, clock);
    await keeper.get();
    await keeper.get();
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
