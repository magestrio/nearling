import { expect, test } from '@playwright/test';
import { calls, CLOSED_ALL, CLOSED_NEW, openWith, privyCalls, setWorker, SIGNED_IN } from './helpers';

const HOOK = 'This pet pays for its own thoughts. When the money runs out, it falls asleep.';
const LEAD = 'Hatch a pet that talks with you, remembers you and grows up.';
const OPENING = 'Opening the game…';
const UNREACHABLE = "We can't reach the game right now. Try again in a moment.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';
const CLOSED_NEW_WORDS = "We're full for new players this month. Sign-ups open again on December 1 — until then, you can still look around.";
const CLOSED_ALL_WORDS = 'Sign-in is closed for everyone until December 1. You can still look around, and any pet you have is safe.';
const ME_PIXEL = { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };
const FOREVER = 3_600_000;

// spec: add-account › Home screen › loading
test('loading: «Opening the game…» and both buttons off until the check ends', async ({ page }) => {
  await openWith(page, '/', { worker: { delayMs: FOREVER } });
  await expect(page.getByText(OPENING)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hatch your pet' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
});

// spec: add-account › Home screen › loading × кнопки неактивны
test('loading × кнопки неактивны: a signed-in player waiting for their current pet has them off too, and no link to the Hatch screen', async ({ page }) => {
  await openWith(page, '/', { auth: SIGNED_IN, worker: { me: ME_PIXEL, delayMs: FOREVER } });
  await expect(page.getByText(OPENING)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hatch your pet' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toHaveCount(0);
});

// spec: add-account › Home screen › error
test('error: the hook stays, «Hatch your pet» and «Sign in» are off, the connection line and «Try again» stand at the top', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: { fail: { status: 0, code: 'unreachable' } } } });
  await expect(page.getByText(UNREACHABLE).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hatch your pet' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  // heard: the page's live region says it
  await expect(page.getByRole('status').filter({ hasText: UNREACHABLE })).toHaveCount(1);
});

// spec: add-account › Home screen › error × кнопки неактивны
test('error × кнопки неактивны: a tap on either does nothing — no Google, no Hatch screen', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: { fail: { status: 0, code: 'unreachable' } } } });
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click({ force: true });
  await page.getByRole('button', { name: 'Hatch your pet' }).click({ force: true });
  await expect(page).toHaveURL(/\/$/);
  expect(await privyCalls(page)).toEqual([]);
});

// spec: add-account › Home screen › error × Try again
test('error × Try again: asks the sign-in state again, and the entries come back', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: { fail: { status: 0, code: 'unreachable' } } } });
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await setWorker(page, { signIn: { state: 'open' } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  await expect(page.getByText(UNREACHABLE)).toHaveCount(0);
});

// spec: add-account › Home screen › error × Try again
test('error × Try again: the exchange that got no answer is asked again', async ({ page }) => {
  await openWith(page, '/', { auth: SIGNED_IN, worker: { me: ME_PIXEL, session: { fail: { status: 0, code: 'unreachable' } } } });
  await expect(page.getByText(UNREACHABLE).first()).toBeVisible();
  await setWorker(page, { session: { ok: true } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-account › Home screen › error × 429
test('error × 429: «Lots of visitors right now. Try again in a minute.» with «Try again»', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: { fail: { status: 429, code: 'rate_limited' } } } });
  await expect(page.getByText(BUSY).first()).toBeVisible();
  await expect(page.getByText(UNREACHABLE)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

// spec: add-account › Home screen › success
test('success: a signed-in player is led to their current pet at once, and never sees the page', async ({ page }) => {
  await openWith(page, '/', { auth: SIGNED_IN, worker: { me: ME_PIXEL, owned: ['9'] } });
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
});

// spec: add-account › Home screen › success
test('success: a signed-in player with no pet of their own goes to the Hatch screen', async ({ page }) => {
  await openWith(page, '/', { auth: SIGNED_IN });
  await expect(page).toHaveURL(/\/hatch$/);
  await expect(page.getByLabel('Name your pet')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toHaveCount(0);
});

// spec: add-account › Home screen › success
test('success: a session that ended before anything was shown is a visitor\'s Home', async ({ page }) => {
  await openWith(page, '/', { auth: SIGNED_IN, worker: { expiredAfterExchange: true } });
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  await expect(page).toHaveURL(/\/$/);
});

// spec: add-account › Home screen › signed-out
test('signed-out: the hook, the lead, «Hatch your pet» and «Sign in»', async ({ page }) => {
  await openWith(page, '/', {});
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  await expect(page.getByText(LEAD)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toHaveAttribute('href', '/hatch');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  // a visitor's load makes no call to Privy
  expect(await privyCalls(page)).toEqual([]);
});

// spec: add-account › Home screen › signed-out × Hatch your pet
test('signed-out × Hatch your pet: the Hatch screen\'s «signed-out», with no sign-in check', async ({ page }) => {
  await openWith(page, '/', {});
  await page.getByRole('link', { name: 'Hatch your pet' }).click();
  await expect(page).toHaveURL(/\/hatch$/);
  await expect(page.getByRole('button', { name: 'Sign in with Google to hatch your pet' })).toBeVisible();
  expect(await privyCalls(page)).toEqual([]);
});

// spec: add-account › Home screen › signed-out × Sign in
test('signed-out × Sign in: begins the sign-in with no place in the tab', async ({ page }) => {
  await openWith(page, '/', { worker: { me: ME_PIXEL, owned: ['9'] } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
  expect(await page.evaluate(() => sessionStorage.getItem('nearling.returnPlace'))).toBeNull();
  const all = await calls(page);
  expect(all.indexOf('worker:signInState')).toBeLessThan(all.indexOf('privy:login'));
});

// spec: add-account › Home screen › signed-out (вход закрыт)
test('signed-out (вход закрыт): the hook, the closed words and «Played here before? Sign in» in the entries\' place, no «Keep looking»', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: CLOSED_NEW } });
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  await expect(page.getByText(CLOSED_NEW_WORDS)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Played here before? Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Keep looking' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

// spec: add-account › Home screen › signed-out (вход закрыт) × Played here before
test('signed-out (вход закрыт) × Played here before: begins the sign-in for a returning player', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: CLOSED_NEW } });
  await page.getByRole('button', { name: 'Played here before? Sign in' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
});

// spec: add-account › Home screen › signed-out (вход закрыт) × закрыт для всех
test('signed-out (вход закрыт) × закрыт для всех: the words alone — no button, no entries', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: CLOSED_ALL } });
  await expect(page.getByText(CLOSED_ALL_WORDS)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toHaveCount(0);
});

// spec: add-account › Home screen › signed-out × Go home с Hatch screen
test('signed-out × Go home с Hatch screen: «Go home» of a closed Hatch screen lands on Home', async ({ page }) => {
  await openWith(page, '/hatch', { worker: { hatchStatus: { open: false, reason: 'service' } } });
  await page.getByRole('link', { name: 'Go home' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toBeVisible();
});

// spec: add-account › Home screen › signed-out × Go home с Pet screen
test('signed-out × Go home с Pet screen: «Go home» of a dead link lands on Home', async ({ page }) => {
  await openWith(page, '/pet/77', {});
  await page.getByRole('link', { name: 'Go home' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});
