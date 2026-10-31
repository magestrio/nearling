import { expect, test, type Page } from '@playwright/test';
import type { FeedSheetData } from '../src/seams/worker-types';
import { BISCUIT, CLOSED_NEW, openWith, PIXEL, setWorker, SIGNED_IN } from './helpers';

const HUNGRY_BISCUIT = { ...BISCUIT, fullness: { state: 'hungry' as const, level: 0.25 } };
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Feed Biscuit' });
const NOTICE =
  "Biscuit will learn your first name from Google, and so will its owner and the AI that writes Biscuit's replies. What you give is saved with Biscuit for good — anyone can see who gave it.";
/** Nothing in the wallet but the project's gas: every portion is out of reach, the smallest short by the whole 0.01 */
const NO_NEAR: Partial<FeedSheetData> = {
  wallet: { state: 'none' },
  portions: [
    { near: '0.01', yocto: '10000000000000000000000', cents: 5, missing: '0.01' },
    { near: '0.05', yocto: '50000000000000000000000', cents: 23, missing: '0.05' },
    { near: '0.2', yocto: '200000000000000000000000', cents: 92, missing: '0.2' },
  ],
};
const guest = (extra: Record<string, unknown> = {}) => ({ pets: { '9': PIXEL, '2': HUNGRY_BISCUIT }, ...extra });

// spec: add-feeding › Feed sheet screen › success (гость)
// spec: add-feeding › Feeder name rule › уведомление
test('success (гость): the notice above the portions, the balance and «Give Biscuit a free snack»; a tap is the consent', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: guest() });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(NOTICE)).toBeVisible();
  for (const price of ['5¢', '23¢', '92¢']) await expect(dialog.getByRole('button', { name: new RegExp(`^Feed · ${price}`) })).toBeEnabled();
  await expect(dialog.getByText('You have 0.31 NEAR')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Give Biscuit a free snack' })).toBeVisible();
  // no «Ask friends» for a guest, and the notice stands above the portions
  await expect(dialog.getByRole('button', { name: /Ask friends/ })).toHaveCount(0);
  const [notice, portion] = await Promise.all([dialog.getByText(NOTICE).boundingBox(), dialog.getByRole('button', { name: /^Feed · 5¢/ }).boundingBox()]);
  expect(notice!.y).toBeLessThan(portion!.y);
});

// spec: add-feeding › Feed sheet screen › без NEAR
test('без NEAR: the snack leads, NEAR behind «Pay with NEAR»; opened, the rows are off with «Add 0.01 NEAR…», «Add NEAR» and no balance', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: guest({ feedSheet: NO_NEAR }) });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  const dialog = sheet(page);
  await expect(dialog.getByText(NOTICE)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Give Biscuit a free snack' })).toBeVisible();
  const pay = dialog.getByRole('button', { name: 'Pay with NEAR' });
  await expect(pay).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('button', { name: /^Feed · / })).toHaveCount(0);
  await pay.click();
  await expect(pay).toHaveAttribute('aria-expanded', 'true');
  for (const price of ['5¢', '23¢', '92¢']) await expect(dialog.getByRole('button', { name: new RegExp(`^Feed · ${price}`) })).toBeDisabled();
  await expect(dialog.getByText('Add 0.01 NEAR to give this meal.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add NEAR' })).toBeVisible();
  // no other NEAR or wallet words
  await expect(dialog.getByText(/You have/)).toHaveCount(0);
});

// spec: add-feeding › Feed sheet screen › без NEAR × the sheet refreshed with «Pay with NEAR» open
test('без NEAR × the sheet refreshed with «Pay with NEAR» open: it stays open', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: guest({ feedSheet: NO_NEAR }) });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  const dialog = sheet(page);
  const pay = dialog.getByRole('button', { name: 'Pay with NEAR' });
  await pay.click();
  const reads = async () => (await page.evaluate(() => (globalThis as { __NEARLING_CALLS__?: string[] }).__NEARLING_CALLS__ ?? [])).filter((c) => c === 'worker:feedSheet').length;
  const before = await reads();
  // the tab comes back: one more read, a new answer that redraws the sheet
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(reads).toBeGreaterThan(before);
  await expect(pay).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByText('Add 0.01 NEAR to give this meal.')).toBeVisible();
});

// spec: add-feeding › Feed by link flow › гость без входа тапает «Feed {name}»
test('гость без входа тапает «Feed {name}»: Google, then the same Pet screen with the sheet open in its state', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: guest() });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page).toHaveURL(/\/pet\/2$/);
  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(NOTICE)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeEnabled();
  expect(await page.evaluate(() => (globalThis as { __NEARLING_CALLS__?: string[] }).__NEARLING_CALLS__ ?? [])).toContain('worker:session:fresh:link');
});

// spec: add-feeding › Feed by link flow › гость без входа тапает «Feed {name}»
test('гость без входа тапает «Feed {name}»: a wallet with no NEAR after the sign-in opens «без NEAR»', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: guest({ feedSheet: NO_NEAR }) });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(sheet(page).getByRole('button', { name: 'Pay with NEAR' })).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: 'Give Biscuit a free snack' })).toBeVisible();
});

const ASLEEP_BISCUIT = { ...BISCUIT, fullness: { state: 'asleep' as const, level: 0 } };
const tapMeal = async (page: Page, worker: Record<string, unknown>) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await sheet(page).getByRole('button', { name: /^Feed · 5¢/ }).click();
};

// spec: add-feeding › Feed by link flow › друг покормил
// spec: add-feeding › Feed by link flow › друг уже вылупил питомца
test('друг покормил: the thanks with the friend\'s name and «Done»; the sleeping pet wakes on the screen; Done closes the sheet', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: guest({ pets: { '9': PIXEL, '2': ASLEEP_BISCUIT } }) });
  await expect(page.getByRole('img', { name: 'Biscuit, asleep' })).toBeVisible();
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT } });
  await sheet(page).getByRole('button', { name: /^Feed · 5¢/ }).click();
  const dialog = sheet(page);
  await expect(dialog.getByText('You fed Biscuit! Biscuit will remember you, Maya.').last()).toBeVisible();
  await expect(dialog.getByRole('status').filter({ hasText: 'You fed Biscuit!' })).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Get your own pet' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: /^Biscuit, (waking up|full)/ })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Biscuit, full' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/pet\/2$/);
});

// spec: add-feeding › Feed by link flow › у друга нет своего питомца
test('у друга нет своего питомца: «Get your own pet» under the thanks leads to the Hatch screen from this pet', async ({ page }) => {
  await tapMeal(page, guest({ feedSheet: { hatched: false }, sendFeed: { status: 'ok', hatched: false, friend: 'Maya' } }));
  const dialog = sheet(page);
  await expect(dialog.getByText('You fed Biscuit! Biscuit will remember you, Maya.').last()).toBeVisible();
  const own = dialog.getByRole('link', { name: 'Get your own pet' });
  await expect(own).toBeVisible();
  await expect(own).toHaveAttribute('href', '/hatch?from=2');
  await expect(own).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Done' })).toHaveCount(0);
  await own.click();
  await expect(page).toHaveURL(/\/hatch\?from=2$/);
});

// spec: add-feeding › Feeder name rule › имя не подошло
test('имя не подошло: the meal goes, the feeder reads «You fed Biscuit! Biscuit will remember you.»', async ({ page }) => {
  await tapMeal(page, guest({ sendFeed: { status: 'ok', hatched: true } }));
  const dialog = sheet(page);
  await expect(dialog.getByText('You fed Biscuit! Biscuit will remember you.').last()).toBeVisible();
  await expect(dialog.getByText(/remember you,/)).toHaveCount(0);
});

// spec: add-feeding › Feed sheet screen › без NEAR
test('без NEAR: after a spent top-up the line says 0.02, exactly as the server sent it', async ({ page }) => {
  const spent: Partial<FeedSheetData> = { ...NO_NEAR, portions: NO_NEAR.portions!.map((p) => ({ ...p, missing: '0.02' })) };
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: guest({ feedSheet: spent }) });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await sheet(page).getByRole('button', { name: 'Pay with NEAR' }).click();
  await expect(sheet(page).getByText('Add 0.02 NEAR to give this meal.')).toBeVisible();
  await expect(sheet(page).getByText(/You have/)).toHaveCount(0);
});

// spec: add-feeding › Feed sheet screen › success (владелец)
test('{balance}: under 0.001 it reads 0.000', async ({ page }) => {
  const portions = (['0.01', '0.05', '0.2'] as const).map((near, i) => ({ near, yocto: '1', cents: [5, 23, 92][i]!, missing: near }));
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: guest({ feedSheet: { portions, wallet: { state: 'some', balance: '5000000000000000000' } } }) });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(sheet(page).getByText('You have 0.000 NEAR')).toBeVisible();
});

// spec: add-feeding › Feed sheet screen › success (гость)
test('success (гость) on the phone: the sheet remounts nothing, the pet stays the 3D pet with «Pause motion», the focus back on «Feed Biscuit»', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: guest() });
  const figure = page.locator('[data-illustration]');
  await expect(figure).toHaveAttribute('data-view', '3d');
  await figure.locator('canvas').evaluate((el) => el.setAttribute('data-kept', ''));
  const opener = page.getByRole('button', { name: 'Feed Biscuit' });
  await opener.click();
  await expect(sheet(page)).toBeVisible();
  // past the moment R3F forces the loss on a canvas that unmounted
  await page.waitForTimeout(1000);
  await expect(figure.locator('canvas[data-kept]')).toHaveCount(1);
  await expect(figure).toHaveAttribute('data-view', '3d');
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(figure).toHaveAttribute('data-view', '3d');
  await expect(page.getByRole('button', { name: 'Pause motion' })).toBeVisible();
  await expect(opener).toBeFocused();
});

// spec: add-feeding › Feed by link flow › гость без входа тапает «Feed {name}» × refused after Google
test('гость без входа тапает «Feed {name}» × refused after Google: the queued action is dropped, no sheet', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: guest({ session: { refused: { reason: 'mau', until: CLOSED_NEW.until } } }) });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByText("Looks like you haven't played here this month, so we can't sign you in until December 1. You can still look around.")).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as { __NEARLING_CALLS__?: string[] }).__NEARLING_CALLS__ ?? [])).not.toContain('worker:feedSheet');
});
