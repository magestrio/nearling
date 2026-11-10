// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  myPets: vi.fn(),
  auth: { getIdentityToken: async () => 'token', endSession: vi.fn() },
}));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('../seams/worker', async (original) => ({
  ...(await original<typeof import('../seams/worker')>()),
  workerApi: { myPets: mocks.myPets },
}));

import { MyPetsSheet, closeMyPets } from './MyPetsSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  mocks.myPets.mockReset();
  mocks.auth.endSession.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  closeMyPets();
  host.remove();
});

// spec: add-gift › My pets sheet screen › error
it('keeps the read error and retry together, then replaces them after a fresh read', async () => {
  mocks.myPets.mockRejectedValueOnce(new Error('unreachable')).mockResolvedValue({ pets: [], currentPet: null });
  await act(async () => root.render(<MyPetsSheet tokenId="9" />));
  const dialog = host.querySelector('[role="dialog"]')!;
  const error = dialog.querySelector('[role="alert"]')!;
  const retry = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === 'Try again')!;
  expect(error.textContent).toBe("We couldn't load your pets right now. Try again in a moment.");
  expect(error.parentElement).toBe(retry.parentElement);
  await act(async () => retry.click());
  expect(mocks.myPets).toHaveBeenCalledTimes(2);
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
  expect(dialog.querySelector('[aria-label="Your pets"]')).not.toBeNull();
});
