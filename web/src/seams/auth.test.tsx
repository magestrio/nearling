// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takePendingAction } from '../screens/pet/parts';
import { peekReturnPlace, rememberReturnPlace, takeReturnText } from '../signin/returnPlace';
import { ReturnToPlace } from '../signin/ReturnToPlace';
import type { AuthApi, ProviderApi } from './auth-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const privy = vi.hoisted(() => ({ fail: false, ready: false, loads: 0, logins: 0, publish: (_: unknown) => undefined as void }));

vi.mock('./auth.privy', () => {
  privy.loads += 1;
  if (privy.fail) throw new Error('the chunk could not be loaded');
  return {
    PrivyHost({ onApi }: { onApi: (api: unknown) => void }) {
      privy.publish = onApi;
      useEffect(() => onApi({ ready: privy.ready, authenticated: false, signInError: null, login: () => void (privy.logins += 1) }), [onApi]);
      return null;
    },
  };
});

vi.mock('./worker', async (original) => ({
  ...(await original<typeof import('./worker')>()),
  workerApi: { session: async () => ({ ok: true }) },
}));

const { PRIVY_WAIT_MS, RealAuthProvider, useAuth } = await import('./auth');

let root: Root | null = null;
let seen: AuthApi;

function Probe() {
  seen = useAuth();
  return <p>the page</p>;
}

async function mount(beside?: ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <RealAuthProvider>
        <Probe />
        {beside}
      </RealAuthProvider>,
    ),
  );
  if (vi.isFakeTimers()) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  return host;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  privy.fail = false;
  privy.ready = false;
  privy.logins = 0;
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('Privy that fails to come', () => {
  // First of the file: a mock's factory that succeeded once is not run again.
  // spec: add-account › Sign-in flow › вход не удался × Privy не загрузился
  it('is a failed sign-in when the chunk of the SDK does not load at the tap, and the page stays', async () => {
    vi.useRealTimers();
    const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
    privy.fail = true;
    const host = await mount();
    await act(async () => seen.login());
    await settle();
    expect(host.textContent).toBe('the page');
    expect(seen).toMatchObject({ ready: true, authenticated: false, signInError: 'failed' });
  });

  // Then: a mock's factory that succeeded once is not run again.
  // spec: add-pet › Connection rule › сервер недоступен
  it('keeps the page when the chunk does not load, and tries again on the next tap', async () => {
    vi.useRealTimers();
    const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
    privy.fail = true;
    localStorage.setItem('privy:token', 'x');
    const host = await mount();
    await settle();
    expect(host.textContent).toBe('the page');
    expect(seen).toMatchObject({ ready: true, authenticated: false });

    const before = privy.loads;
    privy.fail = false;
    vi.resetModules();
    await act(async () => seen.login());
    await settle();
    expect(privy.loads).toBeGreaterThan(before);
    expect(host.textContent).toBe('the page');
  });

  // spec: add-pet › Connection rule › сервер недоступен
  it('opens the page as signed-out after a bounded wait when Privy never reports ready', async () => {
    localStorage.setItem('privy:token', 'x');
    await mount();
    expect(seen.ready).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRIVY_WAIT_MS - 1);
    });
    expect(seen.ready).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(seen).toMatchObject({ ready: true, authenticated: false });
  });
});

describe('a tap that needs Privy and does not get it', () => {
  // spec: add-account › Sign-in flow › вход не удался × Privy не загрузился
  it('is a failed sign-in when Privy is not ready in the bounded wait after the tap, and the next tap tries again', async () => {
    await mount();
    expect(seen.signInError).toBeNull();
    await act(async () => seen.login());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRIVY_WAIT_MS - 1);
    });
    expect(seen.signInError).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(seen).toMatchObject({ ready: true, authenticated: false, signInError: 'failed' });
    expect(privy.logins).toBe(0);

    // the next tap clears it and waits again
    await act(async () => seen.login());
    expect(seen.signInError).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRIVY_WAIT_MS);
    });
    expect(seen.signInError).toBe('failed');
  });

  // spec: add-account › Sign-in flow › вход не удался × Privy не загрузился
  it('is no failed sign-in when Privy is slow on a page that only holds a session', async () => {
    localStorage.setItem('privy:token', 'x');
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRIVY_WAIT_MS);
    });
    expect(seen).toMatchObject({ ready: true, signInError: null });
  });
});

describe('a return from Google with a slow Privy', () => {
  const RETURN = '/?privy_oauth_code=abc&privy_oauth_state=def&privy_oauth_provider=google';
  const session = (): ProviderApi => ({
    ready: true,
    authenticated: true,
    nearAccountId: 'player.testnet',
    walletFailed: false,
    email: null,
    freshSignIn: true,
    signInError: null,
    login() {},
    clearSignInError() {},
    async logout() {},
    createNearWallet: async () => 'player.testnet',
    getIdentityToken: async () => 'identity-token',
    signNearHash: async () => new Uint8Array(64),
  });

  beforeEach(() => {
    takePendingAction();
    window.history.replaceState(null, '', RETURN);
    rememberReturnPlace({ path: '/pet/9', action: 'feed', text: 'And if they ask why?' });
  });

  // spec: add-account › Sign-in flow › вошёл со страницы × Privy опоздал
  it('is no Back from Google when the bounded wait ends: the place, the text and the code stay', async () => {
    await mount(<ReturnToPlace />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRIVY_WAIT_MS);
    });
    expect(seen).toMatchObject({ ready: true, authenticated: false, freshSignIn: true, signInError: null });
    expect(window.location.pathname + window.location.search).toBe(RETURN);
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed', text: 'And if they ask why?' });
  });

  // spec: add-account › Sign-in flow › вошёл со страницы × Privy опоздал
  it('ends where a sign-in ends when Privy comes after the wait: the place, the tapped «Feed», the text', async () => {
    await mount(<ReturnToPlace />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRIVY_WAIT_MS);
    });
    await act(async () => {
      privy.publish(session());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(window.location.pathname).toBe('/pet/9');
    expect(takePendingAction()).toBe('feed');
    expect(takeReturnText('/pet/9')).toBe('And if they ask why?');
  });

  // spec: add-account › Sign-in flow › вошёл со страницы × Privy опоздал
  it('is no fresh sign-in on a page with no code in the address', async () => {
    window.history.replaceState(null, '', '/');
    localStorage.setItem('privy:token', 'x');
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRIVY_WAIT_MS);
    });
    expect(seen).toMatchObject({ ready: true, freshSignIn: false });
  });
});
