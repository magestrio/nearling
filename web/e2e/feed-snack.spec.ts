import { expect, test, type Page } from '@playwright/test';
import type { FeedSheetData, PetBase } from '../src/seams/worker-types';
import { BISCUIT, calls, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

// the date and the time of a snack line are the player's local ones: the zone is the test's
test.use({ timezoneId: 'UTC' });

const ASLEEP_PIXEL: PetBase = { ...PIXEL, fullness: { state: 'asleep', level: 0 } };
const ASLEEP_BISCUIT: PetBase = { ...BISCUIT, fullness: { state: 'asleep', level: 0 } };
const HUNGRY_PIXEL: PetBase = { ...PIXEL, fullness: { state: 'hungry', level: 0.25 } };
const sheet = (page: Page, name = 'Feed Pixel') => page.getByRole('dialog', { name });
const count = async (page: Page, call: string) => (await calls(page)).filter((c) => c === call).length;
const UNTIL = '2026-11-01T00:00:00.000Z';

const ownerAsleep = (extra: Record<string, unknown> = {}) => ({ ...OWNER, pets: { '9': ASLEEP_PIXEL, '2': BISCUIT }, feedSheet: { fullness: ASLEEP_PIXEL.fullness, snack: { state: 'ready' } }, ...extra });
const guestOf = (feedSheet: Partial<FeedSheetData>, extra: Record<string, unknown> = {}) => ({ pets: { '9': PIXEL, '2': ASLEEP_BISCUIT }, feedSheet, ...extra });
async function openOwner(page: Page, worker: Record<string, unknown>) {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(sheet(page)).toBeVisible();
}
async function openGuest(page: Page, worker: Record<string, unknown>) {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(sheet(page, 'Feed Biscuit')).toBeVisible();
}
const SNACK_TEXT = /snack/i;

// spec: add-feeding › Owner snack flow › даёт перекус
// spec: add-feeding › Own pet feeding flow › разбудил
test('даёт перекус (владелец): «Feeding Pixel…», then the sheet closes by itself and Pixel wakes on the page', async ({ page }) => {
  await page.clock.install();
  await openOwner(page, ownerAsleep({ feedSendDelayMs: 2000 }));
  await sheet(page).getByRole('button', { name: 'Give a free snack' }).click();
  await expect(sheet(page).getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
  // the portions are inactive while it goes
  await expect(sheet(page).getByRole('button', { name: /^Feed · 5¢/ })).toBeDisabled();
  await setWorker(page, { pets: { '9': HUNGRY_PIXEL, '2': BISCUIT } });
  await page.clock.fastForward(2500);
  await expect(sheet(page)).toHaveCount(0);
  // nothing was signed or built: the server sent it
  expect(await count(page, 'worker:buildFeed:0.01')).toBe(0);
  expect(await count(page, 'worker:snack')).toBe(1);
  await expect(page.getByRole('img', { name: /^Pixel, (hungry|waking up)/ })).toBeVisible();
  await expect(page.getByText(/Yum!/)).toHaveCount(0);
});

/** Nothing in the wallet but the project's gas: every portion is out of reach, the smallest short by the whole 0.01 */
const NO_NEAR: Partial<FeedSheetData> = {
  wallet: { state: 'none' },
  portions: [
    { near: '0.01', yocto: '10000000000000000000000', cents: 5, missing: '0.01' },
    { near: '0.05', yocto: '50000000000000000000000', cents: 23, missing: '0.05' },
    { near: '0.2', yocto: '200000000000000000000000', cents: 92, missing: '0.2' },
  ],
};

// spec: add-feeding › Feed sheet screen › без NEAR × the owner
// spec: add-feeding › Feed sheet screen › без NEAR
test('без NEAR (владелец): «Give a free snack» leads, «Pay with NEAR» opens to inactive rows with no balance, «Ask friends to feed Pixel» stands', async ({ page }) => {
  await openOwner(page, ownerAsleep({ feedSheet: { fullness: ASLEEP_PIXEL.fullness, snack: { state: 'ready' }, ...NO_NEAR } }));
  const dialog = sheet(page);
  const snack = dialog.getByRole('button', { name: 'Give a free snack' });
  const pay = dialog.getByRole('button', { name: 'Pay with NEAR' });
  await expect(snack).toBeEnabled();
  await expect(pay).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('button', { name: /^Feed · / })).toHaveCount(0);
  // the snack leads: above «Pay with NEAR»
  const [snackBox, payBox] = await Promise.all([snack.boundingBox(), pay.boundingBox()]);
  expect(snackBox!.y).toBeLessThan(payBox!.y);
  await pay.click();
  await expect(pay).toHaveAttribute('aria-expanded', 'true');
  for (const price of ['5¢', '23¢', '92¢']) await expect(dialog.getByRole('button', { name: new RegExp(`^Feed · ${price}`) })).toBeDisabled();
  await expect(dialog.getByText('Add 0.01 NEAR to give this meal.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add NEAR' })).toBeVisible();
  await expect(dialog.getByText(/You have/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Ask friends to feed Pixel' })).toBeVisible();
});

// spec: add-feeding › Feed by link flow › даёт перекус
// spec: add-feeding › Feed by link flow › друг покормил
test('даёт перекус (гость): «Feeding Biscuit…», then the thanks with the name; the sleeping pet wakes on the screen', async ({ page }) => {
  await page.clock.install();
  await openGuest(page, guestOf({ snack: { state: 'ready' } }, { feedSendDelayMs: 2000 }));
  const dialog = sheet(page, 'Feed Biscuit');
  await dialog.getByRole('button', { name: 'Give Biscuit a free snack' }).click();
  await expect(dialog.getByRole('button', { name: 'Feeding Biscuit…' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeDisabled();
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT } });
  await page.clock.fastForward(2500);
  await expect(dialog.getByText('You fed Biscuit! Biscuit will remember you, Maya.').last()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
  await expect(page.getByRole('img', { name: 'Biscuit, full' })).toBeVisible();
});

// spec: add-feeding › Snack rule › питомец владельца не спит
test('питомец владельца не спит: no snack and no line in its place; the meal and the link stay', async ({ page }) => {
  await openOwner(page, { ...OWNER, pets: { '9': HUNGRY_PIXEL, '2': BISCUIT }, feedSheet: { snack: { state: 'none' } } });
  const dialog = sheet(page);
  await expect(dialog.getByText(SNACK_TEXT)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Ask friends to feed Pixel' })).toBeVisible();
});

// spec: add-feeding › Snack rule › перекус владельцу ещё не готов
test('перекус владельцу ещё не готов: the date and the time in its place, the meal and the link stay', async ({ page }) => {
  await openOwner(page, ownerAsleep({ feedSheet: { fullness: ASLEEP_PIXEL.fullness, snack: { state: 'not_ready', at: '2026-11-12T21:40:00.000Z' } } }));
  const dialog = sheet(page);
  await expect(dialog.getByText("Pixel's next free snack is ready Nov 12 at 9:40 PM. Until then, a meal or a friend can wake Pixel up.")).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Give a free snack' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Ask friends to feed Pixel' })).toBeVisible();
});

// spec: add-feeding › Snack rule › друг уже давал перекус сегодня
test('друг уже давал перекус сегодня: its line instead of the snack; the meal stays', async ({ page }) => {
  await openGuest(page, guestOf({ snack: { state: 'given' } }));
  const dialog = sheet(page, 'Feed Biscuit');
  await expect(dialog.getByText("You've already given Biscuit a snack today. Thank you!")).toBeVisible();
  await expect(dialog.getByRole('button', { name: /free snack/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeEnabled();
});

// spec: add-feeding › Snack rule › друг сегодня уже кормил многих
test('друг сегодня уже кормил многих: its line with the time of 00:00 UTC in the player\'s clock', async ({ page }) => {
  await openGuest(page, guestOf({ snack: { state: 'shared_all', until: UNTIL } }));
  await expect(sheet(page, 'Feed Biscuit').getByText("You've shared all your free snacks for today — thank you! More at 00:00.")).toBeVisible();
  await expect(sheet(page, 'Feed Biscuit').getByRole('button', { name: /^Feed · 5¢/ })).toBeEnabled();
});

// spec: add-feeding › Snack rule › три перекуса за сутки
test('три перекуса за сутки: its line with the time of 00:00 UTC in the player\'s clock', async ({ page }) => {
  await openGuest(page, guestOf({ snack: { state: 'pet_full', until: UNTIL } }));
  await expect(sheet(page, 'Feed Biscuit').getByText('Biscuit has had all the snacks for today. More at 00:00.')).toBeVisible();
  await expect(sheet(page, 'Feed Biscuit').getByRole('button', { name: /free snack/ })).toHaveCount(0);
});

// spec: add-feeding › Feeding connection rule › перекусы на паузе
test('перекусы на паузе: the paused line in the snack\'s place; the meal and the link work', async ({ page }) => {
  await openOwner(page, ownerAsleep({ feedSheet: { fullness: ASLEEP_PIXEL.fullness, snack: { state: 'paused' } } }));
  const dialog = sheet(page);
  await expect(dialog.getByText('Free snacks are paused on our side while we top up. Check back soon!')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Give a free snack' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Ask friends to feed Pixel' })).toBeVisible();
});

// spec: add-feeding › Snack rule › друг уже давал перекус сегодня
test('a snack taken meanwhile (`409 snack_gone`) redraws the sheet with the line, and nothing is sent twice', async ({ page }) => {
  const gone: FeedSheetData = {
    chain: true,
    viewer: 'guest',
    name: 'Biscuit',
    fullness: ASLEEP_BISCUIT.fullness,
    portions: ['0.01', '0.05', '0.2'].map((near, i) => ({ near: near as '0.01', yocto: '1', cents: [5, 23, 92][i]!, missing: null })),
    wallet: { state: 'some', balance: '310000000000000000000000' },
    snack: { state: 'given' },
    hatched: true,
    friend: null,
    pending: null,
  };
  await openGuest(page, guestOf({ snack: { state: 'ready' } }, { snack: { fail: { status: 409, code: 'snack_gone', body: { code: 'snack_gone', sheet: gone } } } }));
  const dialog = sheet(page, 'Feed Biscuit');
  await dialog.getByRole('button', { name: 'Give Biscuit a free snack' }).click();
  await expect(dialog.getByText("You've already given Biscuit a snack today. Thank you!")).toBeVisible();
  await expect(dialog.getByRole('button', { name: /free snack/ })).toHaveCount(0);
  await expect(dialog.getByText(/didn't reach|Feeding/)).toHaveCount(0);
  expect(await count(page, 'worker:snack')).toBe(1);
});
