// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takePendingAction } from '../screens/pet/parts';
import { AuthContext, type AuthApi } from '../seams/auth-context';
import { clearOutcome, useOutcome, type Outcome } from './outcome';
import { markSignInUnderWay, peekReturnPlace, rememberReturnPlace, signInUnderWay, takeReturnText } from './returnPlace';
import { ReturnToPlace } from './ReturnToPlace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({ replaced: [] as string[] }));
vi.mock('../route', async (original) => ({
  ...(await original<typeof import('../route')>()),
  replaceLocation: (path: string) => void route.replaced.push(path),
}));

let root: Root | null = null;
let outcome: Outcome | null = null;

function Line() {
  outcome = useOutcome();
  return null;
}

function restored(persisted: boolean) {
  const shown = new Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(shown, 'persisted', { value: persisted });
  return act(async () => void window.dispatchEvent(shown));
}

function auth(over: Partial<AuthApi> = {}): AuthApi {
  return {
    ready: true,
    authenticated: false,
    nearAccountId: null,
    walletFailed: false,
    email: null,
    freshSignIn: false,
    signInError: null,
    login() {},
    clearSignInError() {},
    async logout() {},
    async createNearWallet() {
      return 'a';
    },
    async getIdentityToken() {
      return null;
    },
    async signNearHash() {
      return new Uint8Array(64);
    },
    refusal: null,
    unreachable: false,
    retrySession() {},
    sessionEnded: false,
    sessionLine: false,
    endSession() {},
    needSession: () => true,
    ...over,
  };
}

async function mount(api: AuthApi) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(
      <AuthContext.Provider value={api}>
        <ReturnToPlace />
        <Line />
      </AuthContext.Provider>,
    );
  });
}

beforeEach(() => {
  sessionStorage.clear();
  takePendingAction();
  clearOutcome();
  markSignInUnderWay(false);
  outcome = null;
  route.replaced = [];
  window.history.replaceState(null, '', '/');
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe('the return from Google', () => {
  // spec: add-account › Sign-in flow › вошёл со страницы
  it('leads a whole sign-in back to the place, with the tapped «Feed» and the typed text to give back', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed', text: 'And if they ask why?' });
    await mount(auth({ authenticated: true }));
    expect(window.location.pathname).toBe('/pet/9');
    expect(takePendingAction()).toBe('feed');
    expect(takeReturnText('/pet/9')).toBe('And if they ask why?');
    expect(peekReturnPlace()).toBeNull();
  });

  // spec: add-account › Sign-in flow › вошёл с главной
  it('has nothing to do at `/` with no place: Home takes it from there', async () => {
    await mount(auth({ authenticated: true }));
    expect(window.location.pathname).toBe('/');
    expect(route.replaced).toEqual([]);
  });

  // spec: add-account › Sign-in flow › новый после Google × действие не продолжается
  it('leads a refusal back to the place, and runs nothing and brings back no text', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed', text: 'draft' });
    await mount(auth({ refusal: { reason: 'mau', until: '2026-12-01T00:00:00.000Z' } }));
    expect(window.location.pathname).toBe('/pet/9');
    expect(takePendingAction()).toBeNull();
    expect(takeReturnText('/pet/9')).toBeNull();
    expect(peekReturnPlace()).toBeNull();
  });

  // spec: add-account › Sign-in flow › отменил вход
  it('leads a closed Google window back to the place and keeps the tapped action', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed' });
    await mount(auth({ signInError: 'cancelled' }));
    expect(window.location.pathname).toBe('/pet/9');
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed', cancelled: true });
    expect(takePendingAction()).toBeNull();
  });

  // spec: add-account › Sign-in flow › вход не удался
  it('leads a failed sign-in back to the place as well', async () => {
    rememberReturnPlace({ path: '/hatch?from=2', action: 'signin' });
    await mount(auth({ signInError: 'failed' }));
    expect(window.location.pathname + window.location.search).toBe('/hatch?from=2');
    expect(peekReturnPlace()).toEqual({ path: '/hatch?from=2', action: 'signin', cancelled: true });
  });

  // spec: add-account › Sign-in flow › отменил вход × Back от Google
  it('takes a load at `/` with a place, no session and no code in the address for a cancel: Back from Google brings no callback', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed' });
    await mount(auth());
    expect(window.location.pathname).toBe('/pet/9');
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed', cancelled: true });
  });

  // spec: add-account › Sign-in flow › вошёл со страницы × обмен без ответа
  it('keeps the place while the exchange has not answered: a return from Google is not a cancel', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed' });
    await mount(auth({ freshSignIn: true, unreachable: true }));
    expect(window.location.pathname).toBe('/');
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed' });
  });

  // spec: add-account › Sign-in flow › вход начат × Pet screen
  it('waits while the provider or the exchange is not ready', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed' });
    await mount(auth({ ready: false }));
    expect(window.location.pathname).toBe('/');
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed' });
  });

  // spec: add-account › Sign-in flow › вошёл со страницы × Privy опоздал
  it('leaves the tab and the code in the address alone while Privy has not read the return', async () => {
    window.history.replaceState(null, '', '/?privy_oauth_code=abc');
    rememberReturnPlace({ path: '/pet/9', action: 'feed', text: 'draft' });
    await mount(auth({ freshSignIn: true }));
    expect(window.location.search).toBe('?privy_oauth_code=abc');
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed', text: 'draft' });
  });
});

describe('a sign-in that never left the page', () => {
  async function failedAt(address: string, record: Parameters<typeof rememberReturnPlace>[0]) {
    window.history.replaceState(null, '', address);
    await mount(auth());
    rememberReturnPlace(record);
    await mount(auth({ signInError: 'failed' }));
  }

  // spec: add-account › Sign-in flow › вход не удался
  it('draws its line at the place the tab never left, with no move', async () => {
    await failedAt('/pet/2', { path: '/pet/2', action: 'feed' });
    expect(outcome).toEqual({ kind: 'failed', place: '/pet/2' });
    expect(window.location.pathname).toBe('/pet/2');
    expect(route.replaced).toEqual([]);
  });

  // spec: add-account › Sign-in flow › вход не удался
  it('draws it on the Hatch screen with its query as well', async () => {
    await failedAt('/hatch?from=2', { path: '/hatch?from=2', action: 'signin' });
    expect(outcome).toEqual({ kind: 'failed', place: '/hatch?from=2' });
  });

  // spec: add-account › Session expiry flow › typed text after sign-in × вход отменён
  it('rewrites the record without the text and keeps the tapped action', async () => {
    await failedAt('/pet/2', { path: '/pet/2', action: 'feed', text: 'And if they ask why?' });
    expect(peekReturnPlace()).toEqual({ path: '/pet/2', action: 'feed', cancelled: true });
  });
});

describe('a sign-in under way', () => {
  // spec: add-account › Sign-in flow › вход не удался × Try again
  it('leaves the record and the address alone when an old error goes while Google is starting', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed', text: 'draft' });
    markSignInUnderWay(true);
    await mount(auth());
    expect(window.location.pathname).toBe('/');
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed', text: 'draft' });
    expect(outcome).toBeNull();
  });

  // spec: add-account › Sign-in flow › вход не удался × Try again
  it('still takes the answer when it comes', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed', text: 'draft' });
    markSignInUnderWay(true);
    await mount(auth({ signInError: 'failed' }));
    expect(window.location.pathname).toBe('/pet/9');
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed', cancelled: true });
    expect(outcome).toEqual({ kind: 'failed', place: '/pet/9' });
  });

  // spec: add-account › Sign-in flow › вход начат × второй тап
  it('ends when a page comes back from the back-forward cache: the page had left', async () => {
    markSignInUnderWay(true);
    await mount(auth({ ready: false }));
    await restored(true);
    expect(signInUnderWay()).toBe(false);
  });
});

describe('the record of a cancel, at `/`', () => {
  // spec: add-account › Home screen › signed-out × запись отмены
  it('is erased by a load of Home, and the tab stays there', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed', cancelled: true });
    await mount(auth());
    expect(window.location.pathname).toBe('/');
    expect(peekReturnPlace()).toBeNull();
    expect(outcome).toBeNull();
    expect(route.replaced).toEqual([]);
  });

  // spec: add-account › Home screen › signed-out × запись отмены
  it('is erased by a back-forward restore of Home, and the tab stays there', async () => {
    await mount(auth({ ready: false }));
    rememberReturnPlace({ path: '/pet/9', action: 'feed', cancelled: true });
    await restored(true);
    expect(route.replaced).toEqual([]);
    expect(peekReturnPlace()).toBeNull();
  });

  // spec: add-account › Home screen › signed-out × запись отмены
  it('does not replace a page the back-forward cache restored elsewhere', async () => {
    window.history.replaceState(null, '', '/pet/9');
    await mount(auth({ ready: false }));
    rememberReturnPlace({ path: '/pet/9', action: 'feed', cancelled: true });
    await restored(true);
    expect(route.replaced).toEqual([]);
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed', cancelled: true });
  });

  // spec: add-account › Home screen › signed-out × запись отмены
  it('is no whole return: signed in from another tab, Home neither leads to the old place nor queues its «Feed»', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed', cancelled: true });
    await mount(auth({ authenticated: true, nearAccountId: 'a' }));
    expect(window.location.pathname).toBe('/');
    expect(takePendingAction()).toBeNull();
    expect(peekReturnPlace()).toBeNull();
    expect(outcome).toBeNull();
  });
});

describe('a sign-in begun on Home', () => {
  // spec: add-account › Sign-in flow › запасной путь на телефоне
  it('takes a load at `/` with its record, no session and no code for a Back from Google, and stands on Home', async () => {
    rememberReturnPlace({ path: '/', action: 'signin' });
    await mount(auth());
    expect(outcome).toEqual({ kind: 'cancelled', place: '/' });
    expect(peekReturnPlace()).toBeNull();
    expect(window.location.pathname).toBe('/');
  });

  // spec: add-account › Sign-in flow › запасной путь на телефоне
  it('says the same after a back-forward restore, with no reload of Home', async () => {
    await mount(auth({ ready: false }));
    rememberReturnPlace({ path: '/', action: 'signin' });
    await restored(true);
    expect(outcome).toEqual({ kind: 'cancelled', place: '/' });
    expect(peekReturnPlace()).toBeNull();
    expect(route.replaced).toEqual([]);
  });

  // spec: add-account › Sign-in flow › вход не удался
  it('has its failed line on Home', async () => {
    rememberReturnPlace({ path: '/', action: 'signin' });
    await mount(auth({ signInError: 'failed' }));
    expect(outcome).toEqual({ kind: 'failed', place: '/' });
    expect(peekReturnPlace()).toBeNull();
  });

  // spec: add-account › Sign-in flow › вход не удался
  it('has its failed line on a Home whose address carries a mark, as the link to a real browser leaves it', async () => {
    window.history.replaceState(null, '', '/?ib=x');
    rememberReturnPlace({ path: '/', action: 'signin' });
    await mount(auth({ signInError: 'failed' }));
    expect(outcome).toEqual({ kind: 'failed', place: '/?ib=x' });
  });

  // spec: add-account › Sign-in flow › вошёл с главной
  it('counts as no place on a whole sign-in: the record goes, and Home routes the player', async () => {
    rememberReturnPlace({ path: '/', action: 'signin' });
    await mount(auth({ authenticated: true }));
    expect(peekReturnPlace()).toBeNull();
    expect(outcome).toBeNull();
    expect(takePendingAction()).toBeNull();
  });

  // spec: add-account › Sign-in flow › новый после Google
  it('counts as no place on a refusal: the line stands on Home', async () => {
    rememberReturnPlace({ path: '/', action: 'signin' });
    await mount(auth({ refusal: { reason: 'mau', until: '2026-12-01T00:00:00.000Z' } }));
    expect(outcome).toEqual({ kind: 'mau', place: '/', until: '2026-12-01T00:00:00.000Z' });
    expect(peekReturnPlace()).toBeNull();
  });

  // spec: add-account › Home screen › signed-out
  it('says nothing on a plain load of `/`', async () => {
    await mount(auth());
    expect(outcome).toBeNull();
  });
});

describe('the text of an ended session', () => {
  // spec: add-account › Session expiry flow › typed text after sign-in × вход отменён
  it('is not in the record a cancel rewrote, and does not come back', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'signin', text: 'And if they ask why?' });
    await mount(auth({ signInError: 'cancelled' }));
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'signin', cancelled: true });
    expect(takeReturnText('/pet/9')).toBeNull();
    // not later either, when a sign-in that follows is whole
    await mount(auth({ authenticated: true, signInError: null }));
    expect(takeReturnText('/pet/9')).toBeNull();
  });

  // spec: add-account › Session expiry flow › typed text after sign-in × вход отменён
  it('is not brought back by a page the back-forward cache restored: it is loaded afresh, with the record rewritten', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'signin', text: 'draft' });
    await mount(auth());
    // the Back from Google was a load at `/`: the cancel above already led the tab; now a restored page asks again
    rememberReturnPlace({ path: '/pet/9', action: 'signin', text: 'draft' });
    const restored = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restored, 'persisted', { value: true });
    await act(async () => void window.dispatchEvent(restored));
    expect(route.replaced).toEqual(['/pet/9']);
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'signin', cancelled: true });
    expect(takeReturnText('/pet/9')).toBeNull();
  });

  // spec: add-account › Sign-in flow › отменил вход × Back от Google
  it('lets an ordinary show of the page be', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'signin' });
    await mount(auth({ ready: false }));
    const shown = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(shown, 'persisted', { value: false });
    await act(async () => void window.dispatchEvent(shown));
    expect(route.replaced).toEqual([]);
  });
});
