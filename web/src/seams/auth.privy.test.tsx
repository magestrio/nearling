// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takePendingAction } from '../screens/pet/parts';
import { rememberReturnPlace, takeReturnPlace } from '../signin/returnPlace';
import { ReturnToPlace } from '../signin/ReturnToPlace';
import { AuthContext, type AuthApi } from './auth-context';
import { PrivyHost } from './auth.privy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every hook hands out new functions on every render, as Privy's do: the page must not depend on them being stable.
const privy = vi.hoisted(() => ({
  authenticated: true,
  linked: 'player.testnet' as string | null,
  oauth: vi.fn(),
  created: vi.fn(),
  createFails: false,
}));

vi.mock('../config', () => ({ config: { privyAppId: 'app' } }));

vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => children,
  getIdentityToken: async () => null,
  useLoginWithOAuth: () => ({ initOAuth: (...args: unknown[]) => privy.oauth(...args) }),
  usePrivy: () => ({
    ready: true,
    authenticated: privy.authenticated,
    user: { linkedAccounts: privy.linked === null ? [] : [{ type: 'wallet', chainType: 'near', address: privy.linked }] },
    logout: async () => undefined,
  }),
}));

vi.mock('@privy-io/react-auth/extended-chains', () => ({
  useCreateWallet: () => ({
    createWallet: async () => {
      privy.created();
      if (privy.createFails) throw new Error('wallet refused');
      return { wallet: { address: 'new.testnet' } };
    },
  }),
  useSignRawHash: () => ({ signRawHash: async () => ({ signature: '0x00' }) }),
}));

let root: Root | null = null;
let published = 0;
let api: AuthApi | null = null;

// The provider above: a new `api` is its state, so every publish renders the host again. `ReturnToPlace` stands under
// it as it does in the app.
function Above() {
  const [current, set] = useState<AuthApi | null>(null);
  return (
    <>
      <PrivyHost
        onApi={(next) => {
          published += 1;
          api = next;
          set(next);
        }}
      />
      {current ? (
        <AuthContext.Provider value={current}>
          <ReturnToPlace />
        </AuthContext.Provider>
      ) : null}
    </>
  );
}

async function mount() {
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root?.render(<Above />);
  });
}

beforeEach(() => {
  privy.authenticated = true;
  privy.linked = 'player.testnet';
  privy.createFails = false;
  privy.oauth.mockClear();
  privy.created.mockClear();
  published = 0;
  api = null;
  sessionStorage.clear();
  takePendingAction();
  window.history.replaceState(null, '', '/');
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
});

describe('Bridge against a provider that re-renders it', () => {
  it('publishes once for a signed-in player and stops, with hooks that hand out new functions', async () => {
    await mount();
    expect(api?.authenticated).toBe(true);
    expect(api?.nearAccountId).toBe('player.testnet');
    expect(published).toBeLessThan(5);
  });

  it('makes the wallet of a new player once and stops', async () => {
    privy.linked = null;
    await mount();
    expect(privy.created).toHaveBeenCalledTimes(1);
    expect(api?.ready).toBe(true);
    expect(api?.authenticated).toBe(true);
    expect(api?.nearAccountId).toBe('new.testnet');
    expect(published).toBeLessThan(6);
  });

  it('starts Google through the newest function of the hook', async () => {
    privy.authenticated = false;
    privy.linked = null;
    await mount();
    expect(api?.authenticated).toBe(false);
    api?.login();
    expect(privy.oauth).toHaveBeenCalledWith({ provider: 'google' });
  });

  // spec: add-pet › Pet screen › signed-out × сессия истекла посреди игры
  it('sends a tap to Google when Privy still says signed in and the wallet is there: the retry would change nothing', async () => {
    await mount();
    expect(api?.authenticated).toBe(true);
    api?.login();
    expect(privy.oauth).toHaveBeenCalledWith({ provider: 'google' });
    expect(privy.created).not.toHaveBeenCalled();
  });

  // spec: add-pet › Birth flow › вылупился × вход нового игрока, кошелёк не вышел
  it('leads a new player whose wallet failed back to the place, and the tap there tries the wallet again', async () => {
    privy.linked = null;
    privy.createFails = true;
    rememberReturnPlace({ path: '/pet/9', action: 'feed' });
    await mount();
    expect(privy.created).toHaveBeenCalledTimes(1);
    // not a visitor's black page: the app knows the sign-in stands and the wallet is what is missing
    expect(api).toMatchObject({ ready: true, authenticated: false, walletFailed: true, nearAccountId: null });
    expect(window.location.pathname).toBe('/pet/9');
    expect(takeReturnPlace()).toBeNull();
    // «Feed {name}» waits for a sign-in that is whole
    expect(takePendingAction()).toBeNull();

    // the tap on the place's «Sign in…»: the screen puts the place back and sends the tab to `/`, then asks to sign in
    rememberReturnPlace({ path: '/pet/9', action: 'feed' });
    window.history.replaceState(null, '', '/');
    privy.createFails = false;
    await act(async () => {
      api?.login();
    });
    expect(privy.oauth).not.toHaveBeenCalled();
    expect(privy.created).toHaveBeenCalledTimes(2);
    expect(api).toMatchObject({ ready: true, authenticated: true, walletFailed: false, nearAccountId: 'new.testnet' });
    expect(window.location.pathname).toBe('/pet/9');
    expect(takePendingAction()).toBe('feed');
  });

  // spec: add-pet › Birth flow › вылупился × вход нового игрока, кошелёк не вышел
  it('takes the place again when the retry fails too', async () => {
    privy.linked = null;
    privy.createFails = true;
    rememberReturnPlace('/hatch');
    await mount();
    expect(window.location.pathname).toBe('/hatch');
    rememberReturnPlace('/hatch');
    window.history.replaceState(null, '', '/');
    await act(async () => {
      api?.login();
    });
    expect(privy.created).toHaveBeenCalledTimes(2);
    expect(api).toMatchObject({ ready: true, authenticated: false, walletFailed: true });
    expect(window.location.pathname).toBe('/hatch');
  });
});
