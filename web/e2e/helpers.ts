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

export const PIXEL = { tokenId: '9', name: 'Pixel', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 }, mood: 'happy' as const };
export const BISCUIT = { tokenId: '2', name: 'Biscuit', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 }, mood: 'happy' as const };
export const HISTORY = [
  { id: 'c1', who: 'pet' as const, text: 'Morning! I spent the night counting the hum of your fridge.', at: 1 },
  { id: 'c2:you', who: 'player' as const, text: 'Barely. Big presentation at ten.', at: 2 },
  { id: 'c3', who: 'pet' as const, text: 'Start with the chart, then.', at: 3 },
];
/** Pixel with its owner (one pet), the history and Biscuit beside it */
export const OWNER = { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT }, conversation: { lines: HISTORY, more: false, before: null } };

// User agents for the tests of the in-app browsers: the ordinary strings of Safari on iPhone and Chrome on an Android phone,
// with the documented in-app names added (the real ones of X and Telegram are recorded by hand on a real phone). A test
// hands one to the browser through `test.use({ userAgent })`; the product never spoofs a user agent.
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
export const UA = {
  iphone: IPHONE_UA,
  android: ANDROID_UA,
  xOnIphone: `${IPHONE_UA} Twitter for iPhone`,
  xOnAndroid: `${ANDROID_UA} TwitterAndroid`,
  telegramOnAndroid: `${ANDROID_UA} Telegram-Android/10.14.0`,
};

/** `GET /api/sign-in` closed for new players until the 1st of December. */
export const CLOSED_NEW = { state: 'closed_new' as const, until: '2026-12-01T00:00:00.000Z' };
/** The same, closed for everyone (the ceiling). */
export const CLOSED_ALL = { state: 'closed_all' as const, until: '2026-12-01T00:00:00.000Z' };

/** The UTC day of the sample diary (2026-10-31, the frames' day) and the clock that stands in it. */
export const SAMPLE_DAY = 20_757;
export const inSampleDay = (page: Page, at = '12:00:00') => page.clock.install({ time: new Date(`2026-10-31T${at}Z`) });
/** Pixel asleep, for the Pet screen's `asleep` state and the Diary that stood while it fell asleep */
export const ASLEEP_PIXEL = { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 } };

/** The owner's Diary on the sample day, with the fields of `diary` laid over the sample diary. */
export async function openDiary(page: Page, diary: Record<string, unknown> = {}, worker: Record<string, unknown> = {}, at?: string): Promise<void> {
  await inSampleDay(page, at);
  await openWith(page, '/pet/9/diary', { auth: SIGNED_IN, worker: { ...OWNER, ...worker, diary } });
}

/** The Pet screen of the owner's Pixel, with the fields of its owner view laid over (`diaryUnread`, `pendingQuestion`, …). */
export async function openPet(page: Page, owner: Record<string, unknown> = {}, worker: Record<string, unknown> = {}, at?: string): Promise<void> {
  await inSampleDay(page, at);
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, ...worker, pets: { '9': { ...PIXEL, owner }, '2': BISCUIT } } });
}

/** Changes what Pixel's owner view says from now on (the fake's pets are read at every call). */
export async function setPixel(page: Page, owner: Record<string, unknown>, base: Record<string, unknown> = {}): Promise<void> {
  await setWorker(page, { pets: { '9': { ...PIXEL, ...base, owner }, '2': BISCUIT } });
}

/** A line as the screen draws it: the page's live region says it too, visually hidden, once it came while the screen stood. */
export const drawn = (page: Page, text: string | RegExp, options?: { exact?: boolean }) => page.getByText(text, options).and(page.locator(':not(.ds-hidden)'));

/** The privy and worker calls the fakes were asked, without the rest. */
export const privyCalls = async (page: Page): Promise<string[]> => (await calls(page)).filter((c) => c.startsWith('privy:'));
