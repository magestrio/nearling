// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ adapters: vi.fn(), me: vi.fn(), myPets: vi.fn(),
  auth: { ready: true, authenticated: true, getIdentityToken: vi.fn(), endSession: vi.fn() } }));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('../seams/worker', async () => ({ ...(await import('../seams/worker-types')),
  workerApi: { adapters: mocks.adapters, me: mocks.me, myPets: mocks.myPets } }));

import { useCatalog } from './useCatalog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
function Probe() {
  const catalog = useCatalog(null);
  return <><span data-role={catalog.role?.kind ?? ''}>{catalog.view.kind}</span><button onClick={catalog.tryAgain}>Try again</button></>;
}

beforeEach(() => {
  mocks.adapters.mockReset().mockResolvedValue({ entries: [{ id: 'one' }] });
  mocks.me.mockReset().mockRejectedValue(new Error('lookup unavailable'));
  mocks.myPets.mockReset();
  mocks.auth.getIdentityToken.mockReset().mockResolvedValue('token');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

// spec: add-pet-errands › Adapter catalog screen › browse only, no pet
it('separates an unavailable ownership read from a successful no-pet read', async () => {
  await act(async () => root.render(<Probe />));
  expect(host.querySelector('span')?.dataset.role).toBe('unavailable');
  expect(host.querySelector('span')?.textContent).toBe('ready');
  mocks.me.mockResolvedValue({ ownedCount: 0, currentPet: null });
  await act(async () => host.querySelector('button')!.click());
  expect(host.querySelector('span')?.dataset.role).toBe('no-pet');
});
