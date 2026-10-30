import type { Page } from '@playwright/test';
import type { FakeState } from '../src/seams/fakes';

/** Nothing outside the local dev server is reachable (no Privy, no RPC); the seams answer from the fakes the test hands
 *  over before the page loads. The pets stand on their stills unless a test says otherwise (`pet: { hold: false }`):
 *  software GL can't play them on every page at once. */
export async function openWith(page: Page, route: string, fakes: FakeState = {}): Promise<void> {
  await page.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (r) => r.abort());
  await page.addInitScript((state) => {
    (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__ = state;
  }, { pet: { hold: true }, ...fakes });
  await page.goto(route);
}

/** What the fakes were asked, in order (`worker:hatch`, `privy:load`, …). */
export async function calls(page: Page): Promise<string[]> {
  return page.evaluate(() => (globalThis as { __NEARLING_CALLS__?: string[] }).__NEARLING_CALLS__ ?? []);
}

/** Changes what the Worker fake answers from now on, without a reload. */
export async function setWorker(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => {
    const g = globalThis as { __NEARLING_FAKES__?: { worker?: Record<string, unknown> } };
    g.__NEARLING_FAKES__ ??= {};
    g.__NEARLING_FAKES__.worker = { ...g.__NEARLING_FAKES__.worker, ...p };
  }, patch);
}

export const SIGNED_IN: FakeState['auth'] = { authenticated: true, nearAccountId: 'a'.repeat(64) };

/** The tab looks at the pet again at once, as it does when it comes back to the screen. */
export async function lookAgain(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

export const PIXEL = { tokenId: '9', name: 'Pixel', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 } };
export const BISCUIT = { tokenId: '2', name: 'Biscuit', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 } };
export const HISTORY = [
  { id: 'c1', who: 'pet' as const, text: 'Morning! I spent the night counting the hum of your fridge.', at: 1 },
  { id: 'c2:you', who: 'player' as const, text: 'Barely. Big presentation at ten.', at: 2 },
  { id: 'c3', who: 'pet' as const, text: 'Start with the chart, then.', at: 3 },
];
/** Pixel with its owner (one pet), the history and Biscuit beside it */
export const OWNER = { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT }, conversation: { lines: HISTORY, more: false, before: null } };
