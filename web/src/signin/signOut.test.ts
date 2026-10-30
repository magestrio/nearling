// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markNewborn, useBirth } from '../pet/newborn';
import { queueAction, takePendingAction } from '../screens/pet/parts';
import { END_SESSION_TIMEOUT_MS } from '../seams/worker';
import { WorkerError } from '../seams/worker-types';
import { setOutcome, useOutcome } from './outcome';
import { holdReturnText, peekReturnPlace, rememberReturnPlace, takeReturnText } from './returnPlace';
import { consumeSignedOutLine, peekSignedOutLine, signOut } from './signOut';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const worker = vi.hoisted(() => ({ endSession: vi.fn() }));
vi.mock('../seams/worker', async (original) => ({ ...(await original<typeof import('../seams/worker')>()), workerApi: worker }));

const auth = (over: Partial<Parameters<typeof signOut>[0]> = {}) => ({
  getIdentityToken: vi.fn(async () => 'identity-token' as string | null),
  logout: vi.fn(async () => undefined),
  ...over,
});

/** What a screen of this tab would read after the sign-out: the first show of pet «9», and the outcome line. */
async function readTab() {
  const seen: { birth?: boolean; outcome?: unknown } = {};
  const Probe = () => {
    seen.birth = useBirth('9');
    seen.outcome = useOutcome();
    return null;
  };
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe)));
  await act(async () => root.unmount());
  return seen;
}

beforeEach(() => {
  worker.endSession.mockReset();
  worker.endSession.mockResolvedValue(undefined);
  sessionStorage.clear();
  consumeSignedOutLine();
  window.history.replaceState(null, '', '/pet/9');
});

describe('signOut', () => {
  // spec: add-account › Sign-out data › server not reached
  it('waits for a token that doesn\'t come for the server call\'s limit, then ends the session in the browser all the same', async () => {
    vi.useFakeTimers();
    try {
      const a = auth({ getIdentityToken: vi.fn(() => new Promise<string | null>(() => undefined)) });
      const done = signOut(a);
      await vi.advanceTimersByTimeAsync(END_SESSION_TIMEOUT_MS - 1);
      expect(a.logout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(a.logout).toHaveBeenCalledTimes(1);
      expect(worker.endSession).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe('/');
      expect(peekSignedOutLine()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // spec: add-account › Sign-out flow › вышел × стирает текст во вкладке
  it('leaves nothing of the player in the tab: the action, the return record with its text, the held text, the pet, the outcome', async () => {
    queueAction('feed');
    rememberReturnPlace({ path: '/pet/9', action: 'signin', text: 'half a line' });
    holdReturnText('/pet/9', 'half a line');
    markNewborn('9');
    setOutcome({ kind: 'failed', place: '/pet/9' });
    await signOut(auth());
    expect(takePendingAction()).toBeNull();
    expect(peekReturnPlace()).toBeNull();
    expect(sessionStorage.getItem('nearling.returnPlace')).toBeNull();
    expect(takeReturnText('/pet/9')).toBeNull();
    window.history.replaceState(null, '', '/pet/9');
    expect(await readTab()).toEqual({ birth: false, outcome: null });
  });

  // spec: add-account › Sign-out flow › вышел
  it('ends the session at Privy and at the server, leads to Home and leaves the line for it', async () => {
    const a = auth();
    await signOut(a);
    expect(worker.endSession).toHaveBeenCalledWith('identity-token');
    expect(a.logout).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/');
    expect(peekSignedOutLine()).toBe(true);
    // Home lets it go once it is on the page: a later Home does not show it
    consumeSignedOutLine();
    expect(peekSignedOutLine()).toBe(false);
  });

  // spec: add-account › Sign-out data › server not reached
  it('is the same sign-out when the server is not reached and Privy fails', async () => {
    worker.endSession.mockRejectedValue(new WorkerError(0, 'unreachable'));
    const a = auth({ logout: vi.fn(async () => Promise.reject(new Error('privy offline'))) });
    await expect(signOut(a)).resolves.toBeUndefined();
    expect(window.location.pathname).toBe('/');
    expect(peekSignedOutLine()).toBe(true);
    expect(peekReturnPlace()).toBeNull();
  });

  // spec: add-account › Sign-out data › server not reached
  it('sends no record for a session with no token, and still signs out', async () => {
    const a = auth({ getIdentityToken: vi.fn(async () => null) });
    await signOut(a);
    expect(worker.endSession).not.toHaveBeenCalled();
    expect(a.logout).toHaveBeenCalledTimes(1);
    expect(peekSignedOutLine()).toBe(true);
  });
});
