import { expect, test, type Page } from '@playwright/test';
import type { PetBase } from '../src/seams/worker-types';
import { BISCUIT, calls, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const HUNGRY_PIXEL: PetBase = { ...PIXEL, fullness: { state: 'hungry', level: 0.25 } };
const ownerWith = (extra: Record<string, unknown> = {}) => ({ ...OWNER, pets: { '9': HUNGRY_PIXEL, '2': BISCUIT }, ...extra });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Feed Pixel' });
const TEXT = 'Pixel could use a snack! Feed Pixel here:';
const COPIED = 'Link copied — send it to a friend.';
const MANUAL = 'Copy this link and send it to a friend:';
const ask = (page: Page) => sheet(page).getByRole('button', { name: 'Ask friends to feed Pixel' });

type Browser = { share?: 'ok' | 'abort' | 'refused'; clipboard?: 'ok' | 'denied' };
/** What this browser has under `navigator`: what it was handed is kept for the test to read. */
async function browser(page: Page, what: Browser) {
  await page.addInitScript((w) => {
    const g = globalThis as { __shared?: unknown[]; __copied?: string[] };
    g.__shared = [];
    g.__copied = [];
    const nav = navigator as unknown as Record<string, unknown>;
    if (w.share) {
      nav.share = async (data: unknown) => {
        g.__shared!.push(data);
        if (w.share === 'abort') throw new DOMException('closed', 'AbortError');
        if (w.share === 'refused') throw new DOMException('no', 'NotAllowedError');
      };
    } else {
      nav.share = undefined;
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (w.clipboard === 'denied') throw new Error('denied');
          g.__copied!.push(text);
        },
      },
    });
  }, what);
}
const shared = (page: Page) => page.evaluate(() => (globalThis as { __shared?: unknown[] }).__shared);
const copied = (page: Page) => page.evaluate(() => (globalThis as { __copied?: string[] }).__copied);

async function openOwner(page: Page, what: Browser) {
  await browser(page, what);
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: ownerWith() });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(ask(page)).toBeVisible();
}

// spec: add-feeding › Feed link sharing flow › делится
// spec: add-feeding › Feed link share data › ссылка ушла
test('делится: the system menu gets the link and the text and nothing else; nothing is sent to the server', async ({ page }) => {
  await openOwner(page, { share: 'ok', clipboard: 'ok' });
  // the sheet's own poll goes on; what the tap adds is what is counted
  const others = async () => (await calls(page)).filter((c) => c !== 'worker:feedSheet');
  const before = await others();
  await ask(page).click();
  await expect.poll(() => shared(page)).toHaveLength(1);
  const [data] = (await shared(page)) as Array<Record<string, string>>;
  expect(Object.keys(data!).sort()).toEqual(['text', 'url']);
  expect(data!.text).toBe(TEXT);
  const url = new URL(data!.url!);
  expect(url.pathname).toBe('/pet/9');
  // no account of the sharer, no tab id, no mark of an in-app browser
  expect([...url.searchParams.entries()]).toEqual([['via', 'feed']]);
  // no copy, no toast, no field: the menu took it
  expect(await copied(page)).toEqual([]);
  await expect(page.getByText(COPIED)).toHaveCount(0);
  // nothing about it leaves the browser through the Worker (the event is the analytics seam's)
  expect(await others()).toEqual(before);
});

// spec: add-feeding › Feed link sharing flow › делится
test('делится: the player closing the menu changes nothing', async ({ page }) => {
  await openOwner(page, { share: 'abort', clipboard: 'ok' });
  await ask(page).click();
  await expect.poll(() => shared(page)).toHaveLength(1);
  expect(await copied(page)).toEqual([]);
  await expect(page.getByText(COPIED)).toHaveCount(0);
  await expect(sheet(page).getByText(MANUAL)).toHaveCount(0);
  await expect(ask(page)).toBeVisible();
});

// spec: add-feeding › Feed link sharing flow › делится
test('делится: no menu — the link with its text is copied, «Link copied — send it to a friend.» in a Toast and on the live region', async ({ page }) => {
  await openOwner(page, { clipboard: 'ok' });
  await ask(page).click();
  await expect(page.getByText(COPIED).first()).toBeVisible();
  await expect(sheet(page).getByRole('status').filter({ hasText: COPIED })).toHaveCount(1);
  const [text] = (await copied(page))!;
  expect(text).toMatch(new RegExp(`^${TEXT} http://[^ ]+/pet/9\\?via=feed$`));
  await expect(ask(page)).toBeVisible();
});

// spec: add-feeding › Feed link sharing flow › делится
test('делится: a menu that refuses falls to the copy', async ({ page }) => {
  await openOwner(page, { share: 'refused', clipboard: 'ok' });
  await ask(page).click();
  await expect(page.getByText(COPIED).first()).toBeVisible();
  expect(await copied(page)).toHaveLength(1);
});

// spec: add-feeding › Feed link sharing flow › скопировать не вышло
test('скопировать не вышло: the text with the link in a field the player selects, the focus and the selection on it', async ({ page }) => {
  await openOwner(page, { clipboard: 'denied' });
  await ask(page).click();
  const dialog = sheet(page);
  const field = dialog.getByLabel(MANUAL);
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(new RegExp(`^${TEXT} http://[^ ]+/pet/9\\?via=feed$`));
  await expect(field).toHaveAttribute('readonly', '');
  await expect(field).toBeFocused();
  expect(await field.evaluate((el) => (el as HTMLTextAreaElement).selectionEnd - (el as HTMLTextAreaElement).selectionStart)).toBeGreaterThan(40);
  await expect(dialog.getByRole('status').filter({ hasText: MANUAL })).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Ask friends to feed Pixel' })).toHaveCount(0);
  await expect(page.getByText(COPIED)).toHaveCount(0);
});

// spec: add-feeding › Feed link sharing flow › скопировать не вышло × Close
test('скопировать не вышло × Close: the field goes with the sheet, and the sheet opens without it', async ({ page }) => {
  await openOwner(page, { clipboard: 'denied' });
  await ask(page).click();
  await expect(sheet(page).getByLabel(MANUAL)).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(ask(page)).toBeVisible();
  await expect(sheet(page).getByLabel(MANUAL)).toHaveCount(0);
});

// spec: add-feeding › Feed link sharing flow › скопировать не вышло × Close
test('делится × Close: the Toast runs out on its own time, also after the sheet was closed', async ({ page }) => {
  await page.clock.install();
  await openOwner(page, { clipboard: 'ok' });
  await ask(page).click();
  await expect(page.getByText(COPIED).first()).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText(COPIED)).toBeVisible();
  await page.clock.fastForward(4_500);
  await expect(page.getByText(COPIED)).toHaveCount(0);
});

// spec: add-feeding › Feed link sharing flow › делится × a tap on a portion
test('делится × a tap on a portion: the live region says «Feeding Pixel…», not the copy line that stood before', async ({ page }) => {
  await openOwner(page, { clipboard: 'ok' });
  await ask(page).click();
  await expect(sheet(page).getByRole('status').filter({ hasText: COPIED })).toHaveCount(1);
  await setWorker(page, { feedSendDelayMs: 30_000 });
  await sheet(page).getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(sheet(page).getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
  await expect(sheet(page).getByRole('status').filter({ hasText: 'Feeding Pixel…' })).toHaveCount(1);
  await expect(sheet(page).getByRole('status').filter({ hasText: COPIED })).toHaveCount(0);
});

// spec: add-feeding › Feed link sharing flow › ссылку открыли
test('ссылку открыли: a visitor sees the Pet screen of the pet in its state, with no sign-in and no sheet', async ({ page }) => {
  await openWith(page, '/pet/2?via=feed', { worker: { pets: { '9': PIXEL, '2': { ...BISCUIT, fullness: { state: 'hungry', level: 0.25 } } } } });
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // the pet's own address, not the sharer's: no call that names a player
  expect((await calls(page)).filter((c) => c.startsWith('worker:') && c !== 'worker:pet')).toEqual([]);
});
