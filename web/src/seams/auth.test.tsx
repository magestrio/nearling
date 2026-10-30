// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from './auth-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const privy = vi.hoisted(() => ({ fail: false, ready: false, loads: 0 }));

vi.mock('./auth.privy', () => {
  privy.loads += 1;
  if (privy.fail) throw new Error('the chunk could not be loaded');
  return {
    PrivyHost({ onApi }: { onApi: (api: unknown) => void }) {
      useEffect(() => onApi({ ready: privy.ready, authenticated: false, login: () => undefined }), [onApi]);
      return null;
    },
  };
});

const { PRIVY_WAIT_MS, RealAuthProvider, useAuth } = await import('./auth');

let root: Root | null = null;
let seen: AuthApi;

function Probe() {
  seen = useAuth();
  return <p>the page</p>;
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <RealAuthProvider>
        <Probe />
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
  // First: a mock's factory that succeeded once is not run again.
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
