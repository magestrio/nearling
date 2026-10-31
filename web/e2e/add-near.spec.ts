import { expect, test, type Page } from '@playwright/test';
import type { FeedSheetData, PetBase, SheetPortion } from '../src/seams/worker-types';
import { calls, openWith, OWNER, PIXEL, BISCUIT, setWorker, SIGNED_IN } from './helpers';

const HUNGRY_PIXEL: PetBase = { ...PIXEL, fullness: { state: 'hungry', level: 0.25 } };
const ADDRESS = 'a'.repeat(64);
const SEND = 'Send NEAR to this address from another wallet or an exchange.';
const STAYS =
  'NEAR you add here stays in this game — it feeds pets and pays the small network fees. The game has no way to send it back out, so add only what you plan to use.';
const WAITING = 'Waiting for your NEAR…';
const feed = (page: Page) => page.getByRole('dialog', { name: 'Feed Pixel' });
const add = (page: Page) => page.getByRole('dialog', { name: 'Add NEAR' });
const reads = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:wallet').length;

/** 0.08 NEAR: the 0.2 portion is short by 0.13, «Add NEAR» stands under it */
const LOW: SheetPortion[] = [
  { near: '0.01', yocto: '10000000000000000000000', cents: 5, missing: null },
  { near: '0.05', yocto: '50000000000000000000000', cents: 23, missing: null },
  { near: '0.2', yocto: '200000000000000000000000', cents: 92, missing: '0.13' },
];
const lowSheet: Partial<FeedSheetData> = { portions: LOW, wallet: { state: 'some', balance: '80000000000000000000000' } };
const ownerLow = (extra: Record<string, unknown> = {}) => ({ ...OWNER, pets: { '9': HUNGRY_PIXEL, '2': BISCUIT }, feedSheet: lowSheet, ...extra });

async function stubClipboard(page: Page, fails = false) {
  await page.addInitScript((refuse) => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (refuse) throw new Error('denied');
          (globalThis as { __copied?: string }).__copied = text;
        },
      },
    });
  }, fails);
}

async function openAddNear(page: Page, worker: Record<string, unknown> = ownerLow()) {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await feed(page).getByRole('button', { name: 'Add NEAR' }).click();
  await expect(add(page)).toBeVisible();
}

// spec: add-feeding › Add NEAR sheet screen › success
test('success: the address with «Copy», the two lines on where the NEAR stays, and «Waiting for your NEAR…»', async ({ page }) => {
  await openAddNear(page);
  const dialog = add(page);
  await expect(dialog.getByText(ADDRESS)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(dialog.getByText(SEND)).toBeVisible();
  await expect(dialog.getByText(STAYS)).toBeVisible();
  await expect(dialog.getByText(WAITING).last()).toBeVisible();
  await expect(dialog.getByRole('status').filter({ hasText: WAITING })).toHaveCount(1);
  // a step inside the sheet: «Back» and «Close», and the Feed sheet's portions are gone from the view
  await expect(dialog.getByRole('button', { name: 'Back' })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Feed · / })).toHaveCount(0);
});

// spec: add-feeding › Add NEAR sheet screen › success
test('«Copy» copies the address: «Address copied.» in a Toast and on the sheet\'s live region', async ({ page }) => {
  await stubClipboard(page);
  await openAddNear(page);
  await add(page).getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Address copied.').first()).toBeVisible();
  await expect(add(page).getByRole('status').filter({ hasText: 'Address copied.' })).toHaveCount(1);
  expect(await page.evaluate(() => (globalThis as { __copied?: string }).__copied)).toBe(ADDRESS);
});

// spec: add-feeding › Add NEAR sheet screen › success
test('«Copy» that fails says to select the address and copy it by hand, and selects it', async ({ page }) => {
  await stubClipboard(page, true);
  await openAddNear(page);
  await add(page).getByRole('button', { name: 'Copy' }).click();
  await expect(add(page).getByText('Select the address and copy it by hand.').last()).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(ADDRESS);
});

// spec: add-feeding › Add NEAR sheet screen › NEAR пришёл
test('NEAR пришёл: «Your NEAR is here!» for 4 seconds with no reload, then the Feed sheet with the new amount', async ({ page }) => {
  await page.clock.install();
  await openAddNear(page);
  const dialog = add(page);
  // the watch asks every 5 s
  const before = await reads(page);
  await expect
    .poll(async () => {
      await page.clock.fastForward(5_100);
      return reads(page);
    })
    .toBeGreaterThan(before);
  await expect(dialog.getByText('Your NEAR is here!')).toHaveCount(0);
  await setWorker(page, {
    wallet: { address: ADDRESS, balance: '900000000000000000000000', funded: true },
    feedSheet: { portions: LOW.map((p) => ({ ...p, missing: null })), wallet: { state: 'some', balance: '900000000000000000000000' } },
  });
  await page.clock.fastForward(5_100);
  await expect(dialog.getByText('Your NEAR is here!').last()).toBeVisible();
  await expect(dialog.getByRole('status').filter({ hasText: 'Your NEAR is here!' })).toHaveCount(1);
  // the waiting line and the long text are gone, the address stays
  await expect(dialog.getByText(WAITING)).toHaveCount(0);
  await expect(dialog.getByText(ADDRESS)).toBeVisible();
  await page.clock.fastForward(3_500);
  await expect(dialog.getByText('Your NEAR is here!').last()).toBeVisible();
  await page.clock.fastForward(1_000);
  await expect(feed(page)).toBeVisible();
  await expect(feed(page).getByText('You have 0.90 NEAR')).toBeVisible();
  await expect(feed(page).getByRole('button', { name: /^Feed · 92¢/ })).toBeEnabled();
  await expect(add(page)).toHaveCount(0);
});

// spec: add-feeding › Add NEAR sheet screen › error
test('error: «We couldn\'t show your address right now…» and «Try again», which reads the address again', async ({ page }) => {
  await openAddNear(page, ownerLow({ wallet: { fail: { status: 503, code: 'chain_unreachable' } } }));
  const dialog = add(page);
  await expect(dialog.getByText("We couldn't show your address right now. Try again in a moment.")).toBeVisible();
  await expect(dialog.getByText(ADDRESS)).toHaveCount(0);
  const before = await reads(page);
  await setWorker(page, { wallet: undefined });
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByText(ADDRESS)).toBeVisible();
  expect(await reads(page)).toBe(before + 1);
});

// spec: add-feeding › Add NEAR sheet screen › success × Back, Close, Esc
test('success × Back: the sheet it was opened from, in its state', async ({ page }) => {
  await openAddNear(page);
  await add(page).getByRole('button', { name: 'Back' }).click();
  await expect(add(page)).toHaveCount(0);
  const dialog = feed(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Add 0.13 NEAR to give this meal.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add NEAR' })).toBeFocused();
});

// spec: add-feeding › Add NEAR sheet screen › success × Back, Close, Esc
test('success × Close and Esc: as Back — the sheet it was opened from, in its state, nothing sent', async ({ page }) => {
  await openAddNear(page);
  await add(page).getByRole('button', { name: 'Close' }).click();
  await expect(add(page)).toHaveCount(0);
  await expect(feed(page)).toBeVisible();
  await expect(feed(page).getByText('Add 0.13 NEAR to give this meal.')).toBeVisible();
  await expect(feed(page).getByRole('button', { name: 'Add NEAR' })).toBeFocused();
  await feed(page).getByRole('button', { name: 'Add NEAR' }).click();
  await expect(add(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add(page)).toHaveCount(0);
  await expect(feed(page)).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/9$/);
  // the sheet it returned to closes by its own Close, to the opener on the page
  await feed(page).getByRole('button', { name: 'Close' }).click();
  await expect(feed(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeFocused();
});

/** Nothing in the wallet but the project's gas: the rows are behind «Pay with NEAR», each short by its whole price */
const NO_NEAR: Partial<FeedSheetData> = {
  wallet: { state: 'none' },
  portions: [
    { near: '0.01', yocto: '10000000000000000000000', cents: 5, missing: '0.01' },
    { near: '0.05', yocto: '50000000000000000000000', cents: 23, missing: '0.05' },
    { near: '0.2', yocto: '200000000000000000000000', cents: 92, missing: '0.2' },
  ],
};

// spec: add-feeding › Add NEAR sheet screen › success × «Pay with NEAR» open
test('success × «Pay with NEAR» open: Back, Close and Esc find the disclosure open and the focus on «Add NEAR»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: ownerLow({ feedSheet: NO_NEAR }) });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const pay = feed(page).getByRole('button', { name: 'Pay with NEAR' });
  await pay.click();
  await expect(pay).toHaveAttribute('aria-expanded', 'true');
  await feed(page).getByRole('button', { name: 'Add NEAR' }).click();
  await expect(add(page)).toBeVisible();
  await add(page).getByRole('button', { name: 'Back' }).click();
  await expect(pay).toHaveAttribute('aria-expanded', 'true');
  await expect(feed(page).getByText('Add 0.01 NEAR to give this meal.')).toBeVisible();
  await expect(feed(page).getByRole('button', { name: 'Add NEAR' })).toBeFocused();
  // Esc is Back as well
  await feed(page).getByRole('button', { name: 'Add NEAR' }).click();
  await page.keyboard.press('Escape');
  await expect(pay).toHaveAttribute('aria-expanded', 'true');
  await expect(feed(page).getByRole('button', { name: 'Add NEAR' })).toBeFocused();
});

// spec: add-feeding › Feed sheet screen › мало NEAR × a failed line
test('мало NEAR × a failed line: «Add NEAR» of a short portion opens the step, and Back returns to the open sheet', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: ownerLow({ sendFeed: { status: 'failed', hatched: true } }) });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await feed(page).getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(feed(page).locator('#feed-failed')).toBeVisible();
  // the failed line stands and the other controls are live
  await expect(feed(page).getByRole('button', { name: 'Add NEAR' })).toBeEnabled();
  await feed(page).getByRole('button', { name: 'Add NEAR' }).click();
  await expect(add(page)).toBeVisible();
  await expect(add(page).getByText(ADDRESS)).toBeVisible();
  await add(page).getByRole('button', { name: 'Back' }).click();
  await expect(add(page)).toHaveCount(0);
  await expect(feed(page).getByText('Add 0.13 NEAR to give this meal.')).toBeVisible();
  await expect(feed(page).getByRole('button', { name: 'Add NEAR' })).toBeFocused();
});

// spec: add-feeding › Add NEAR sheet screen › success × a reload
test('success × a reload: the step is the tab\'s memory, the page loads without it', async ({ page }) => {
  await openAddNear(page);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(add(page)).toHaveCount(0);
  await expect(feed(page)).toHaveCount(0);
});

// spec: add-feeding › Add NEAR sheet screen › success × session ended
test('success × session ended: the watch meets the 401, nothing changes on screen, the watch stops', async ({ page }) => {
  await page.clock.install();
  await openAddNear(page);
  // the address is there, so the watch is running
  await expect(add(page).getByText(ADDRESS)).toBeVisible();
  // the watch's timer may not be set the moment the address shows: the clock goes on until the watch asks
  await expect
    .poll(async () => {
      await page.clock.fastForward(5_100);
      return reads(page);
    })
    .toBeGreaterThanOrEqual(2);
  const running = await reads(page);
  await setWorker(page, { sessionExpired: true });
  await page.clock.fastForward(5_100);
  await expect.poll(() => reads(page)).toBeGreaterThan(running);
  const settled = await reads(page);
  await expect(add(page).getByText(ADDRESS)).toBeVisible();
  await page.clock.fastForward(20_000);
  expect(await reads(page)).toBe(settled);
});

// spec: add-feeding › Add NEAR sheet screen › success × session ended
test('success × session ended: a tap that needs the session closes the sheet and the line stands', async ({ page }) => {
  await openAddNear(page, ownerLow({ wallet: { fail: { status: 500, code: 'error' } } }));
  await setWorker(page, { sessionExpired: true });
  await add(page).getByRole('button', { name: 'Try again' }).click();
  await expect(add(page)).toHaveCount(0);
  await expect(page.getByText("You've been signed out. Sign in to pick up where you left off.").first()).toBeVisible();
});

// spec: add-feeding › Add NEAR sheet screen › success × Back, Close, Esc
test('opened by another surface (the Gift sheet): Back, Close and Esc hand the player back to it', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: ownerLow() });
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  const open = () =>
    page.evaluate(() =>
      (globalThis as { __nearlingOpenAddNear?: (r: unknown) => void }).__nearlingOpenAddNear?.({
        from: 'gift',
        onBack: () => ((globalThis as { __backTo?: string }).__backTo = 'gift'),
      }),
    );
  await open();
  await expect(add(page)).toBeVisible();
  await expect(add(page).getByText(ADDRESS)).toBeVisible();
  await add(page).getByRole('button', { name: 'Back' }).click();
  await expect(add(page)).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as { __backTo?: string }).__backTo)).toBe('gift');
  await page.evaluate(() => delete (globalThis as { __backTo?: string }).__backTo);
  await open();
  await add(page).getByRole('button', { name: 'Close' }).click();
  await expect(add(page)).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as { __backTo?: string }).__backTo)).toBe('gift');
  await page.evaluate(() => delete (globalThis as { __backTo?: string }).__backTo);
  await open();
  await page.keyboard.press('Escape');
  await expect(add(page)).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as { __backTo?: string }).__backTo)).toBe('gift');
});
