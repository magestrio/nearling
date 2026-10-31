import { expect, test, type Page } from '@playwright/test';
import type { PetBase } from '../src/seams/worker-types';
import { BISCUIT, calls, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const HUNGRY_PIXEL: PetBase = { ...PIXEL, fullness: { state: 'hungry', level: 0.25 } };
const ASLEEP_PIXEL: PetBase = { ...PIXEL, fullness: { state: 'asleep', level: 0 } };
const ownerWith = (pixel: PetBase = HUNGRY_PIXEL) => ({ ...OWNER, pets: { '9': pixel, '2': BISCUIT } });
const sheet = (page: Page, name = 'Feed Pixel') => page.getByRole('dialog', { name });
const SIGNED_OUT = "You've been signed out. Sign in to pick up where you left off.";
const reads = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:feedSheet').length;
const openPixel = async (page: Page, worker: Record<string, unknown> = ownerWith()) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(sheet(page)).toBeVisible();
};

// spec: add-feeding › Feed sheet screen › success (владелец) × Close
test('success (владелец) × Close: «Close» and Esc close the sheet on the same page, the focus back on the opener', async ({ page }) => {
  await openPixel(page);
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).not.toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-feeding › Feed sheet screen › лист обновляется сам × a reload
test('лист обновляется сам × a reload: the sheet is the tab\'s memory, a reload shows the page without it', async ({ page }) => {
  await openPixel(page);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
});

// spec: add-feeding › Feed sheet screen › лист обновляется сам × session ended, a tap
test('лист обновляется сам × session ended, a tap: «Try again» of the sheet closes it, the line and «Sign in» stand, nothing is sent', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...ownerWith(), feedSheet: { fail: { status: 500, code: 'error' } } } });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(sheet(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await setWorker(page, { sessionExpired: true });
  // no look has found the session ended yet: the tap meets the 401 itself
  await sheet(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page)).toHaveCount(0);
  // drawn on the page, and said by the page's live region
  await expect(page.getByText(SIGNED_OUT).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
});

// spec: add-feeding › Feed sheet screen › лист обновляется сам × session ended, no tap
test('лист обновляется сам × session ended, no tap: the poll meets the 401, nothing changes on screen, the poll stops', async ({ page }) => {
  await openPixel(page);
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await expect.poll(() => reads(page)).toBeGreaterThanOrEqual(2);
  const settled = await reads(page);
  // the sheet stands as it was, and no more reads follow
  await expect(sheet(page).getByRole('button', { name: /^Feed · 5¢/ })).toBeVisible();
  await page.waitForTimeout(500);
  await lookAgain(page);
  await page.waitForTimeout(500);
  expect(await reads(page)).toBe(settled);
});

// spec: add-feeding › Feed sheet screen › лист обновляется сам × the pet given away
test('лист обновляется сам × the pet given away: the owner\'s sheet becomes the guest\'s, with the notice and no «Ask friends»', async ({ page }) => {
  await openPixel(page);
  await expect(sheet(page).getByRole('button', { name: 'Ask friends to feed Pixel' })).toBeVisible();
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(sheet(page).getByText(/will learn your first name from Google/)).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: /Ask friends/ })).toHaveCount(0);
});

// spec: add-feeding › Feed sheet screen › лист обновляется сам × 00:00 UTC
test('лист обновляется сам × 00:00 UTC: a new day brings the snack back by `Snack rule`', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { pets: { '9': PIXEL, '2': BISCUIT }, feedSheet: { snack: { state: 'given' } } } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  const dialog = sheet(page, 'Feed Biscuit');
  await expect(dialog.getByText("You've already given Biscuit a snack today. Thank you!")).toBeVisible();
  await expect(dialog.getByRole('button', { name: /free snack/ })).toHaveCount(0);
  await setWorker(page, { feedSheet: { snack: { state: 'ready' } } });
  await lookAgain(page);
  await expect(dialog.getByRole('button', { name: 'Give Biscuit a free snack' })).toBeVisible();
  await expect(dialog.getByText(/already given/)).toHaveCount(0);
});

// spec: add-feeding › Feed sheet screen › лист обновляется сам × tab hidden and back
test('лист обновляется сам × tab hidden and back: no read while hidden, one at once on the way back', async ({ page }) => {
  await openPixel(page);
  const idle = await reads(page);
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  // longer than the poll's period
  await page.waitForTimeout(5600);
  expect(await reads(page)).toBe(idle);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => reads(page)).toBe(idle + 1);
});

// spec: add-feeding › Feed sheet screen › лист обновляется сам × another feeder's meal
test('лист обновляется сам × another feeder\'s meal: the pet is awake, no owner\'s snack, the plate and the sheet\'s head show one fullness', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPixel(page, {
    ...ownerWith(ASLEEP_PIXEL),
    feedSheet: { fullness: { state: 'asleep', level: 0 }, snack: { state: 'ready' } },
  });
  await expect(sheet(page).getByRole('button', { name: 'Give a free snack' })).toBeVisible();
  await setWorker(page, {
    pets: { '9': { ...PIXEL, fullness: { state: 'hungry', level: 0.5 } }, '2': BISCUIT },
    feedSheet: { fullness: { state: 'hungry', level: 0.5 }, snack: { state: 'none' } },
  });
  await lookAgain(page);
  await expect(sheet(page).getByRole('button', { name: 'Give a free snack' })).toHaveCount(0);
  // the plate (under the sheet) and the head of the sheet say the same word
  await expect(page.getByText('Hungry', { exact: true }).filter({ visible: true })).toHaveCount(2);
  await expect(page.getByText('Asleep', { exact: true })).toHaveCount(0);
});

// spec: add-feeding › Feed sheet screen › лист обновляется сам × a thought put the pet to sleep
test('лист обновляется сам × a thought put the pet to sleep: the sheet gets the snack, the plate follows', async ({ page }) => {
  await openPixel(page);
  await expect(sheet(page).getByRole('button', { name: 'Give a free snack' })).toHaveCount(0);
  await setWorker(page, {
    pets: { '9': ASLEEP_PIXEL, '2': BISCUIT },
    feedSheet: { fullness: { state: 'asleep', level: 0 }, snack: { state: 'ready' } },
  });
  await lookAgain(page);
  await expect(sheet(page).getByRole('button', { name: 'Give a free snack' })).toBeVisible();
  await expect(page.getByText('Asleep', { exact: true }).filter({ visible: true })).toHaveCount(1);
});

// spec: add-feeding › Feed sheet screen › success (владелец) × Close
test('the sheet follows the player to no other pet: «Go to your Pixel» from a friend\'s page leaves no sheet behind', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT }, me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 } } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(sheet(page, 'Feed Biscuit')).toBeVisible();
  await sheet(page, 'Feed Biscuit').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('link', { name: 'Go to your Pixel' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
