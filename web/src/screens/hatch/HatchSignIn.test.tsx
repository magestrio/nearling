// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const begin = vi.hoisted(() => vi.fn());
vi.mock('../../seams/auth', () => ({ useAuth: () => ({ authenticated: false, nearAccountId: null }) }));
vi.mock('../../signin/signIn', () => ({ useSignIn: () => ({ begin }) }));
vi.mock('../../signin/SignInOutcome', () => ({ SignInOutcome: () => null }));
vi.mock('./useHatch', () => ({ useHatch: () => {
  const [name, setName] = useState('');
  return { view: { kind: 'signed-out' }, name, cleaned: name, birth: 'idle', setName,
    known: [], friend: null, nameRefused: false };
} }));

import { HatchScreen } from './HatchScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// spec: D-31 › Hatch sign-in return › typed name survives successful Google sign-in
it('passes the typed Hatch name into the shared sign-in return record', async () => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<HatchScreen from={null} />));
  const input = host.querySelector<HTMLInputElement>('input[placeholder="e.g. Pixel"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Pixel');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Sign in with Google to hatch your pet'))!;
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(begin).toHaveBeenCalledWith('signin', { text: 'Pixel' });
  await act(async () => root.unmount());
  host.remove();
});
