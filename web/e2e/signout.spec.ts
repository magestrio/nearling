import { expect, test, type Page } from '@playwright/test';
import { BISCUIT, calls, CLOSED_NEW, openWith, OWNER, PIXEL, privyCalls, SIGNED_IN } from './helpers';

const HOOK = 'This pet pays for its own thoughts. When the money runs out, it falls asleep.';
const LINE = "You're signed out. See you soon!";
const UNREACHABLE = "We can't reach the game right now. Try again in a moment.";
const ME_PIXEL = { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };

const signOut = async (page: Page) => {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
};

// spec: add-account › Sign-out flow › вышел
test('вышел: Home without a session with «You\'re signed out. See you soon!»; no conversation and no pet of the owner is left', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await signOut(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  // the Toast, said by the page's Live once the page has mounted, and the focus on the h1
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: LINE })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeFocused();
  await expect(page.getByText('Start with the chart, then.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
  // Privy's session and the server's both ended
  expect(await privyCalls(page)).toContain('privy:logout');
  expect(await calls(page)).toContain('worker:endSession');
});

// spec: add-account › Sign-out flow › вышел
test('phone sign-out leaves the Home heading below the Toast', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await signOut(page);
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  const toast = await page.locator('.ds-toast').boundingBox();
  const heading = await page.getByRole('heading', { level: 1, name: HOOK }).boundingBox();
  expect(toast).not.toBeNull();
  expect(heading).not.toBeNull();
  expect(toast!.y + toast!.height).toBeLessThanOrEqual(heading!.y);
});

// spec: add-account › Sign-out flow › вышел × стирает текст во вкладке
test('вышел × стирает текст во вкладке: the typed line and the return record with its text are gone from the tab', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await page.evaluate(() => sessionStorage.setItem('nearling.returnPlace', JSON.stringify({ path: '/pet/9', action: 'signin', text: 'half a line' })));
  await page.getByPlaceholder('Talk to Pixel…').fill('half a line');
  await signOut(page);
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('nearling.returnPlace'))).toBeNull();
  await expect(page.getByText('half a line')).toHaveCount(0);
});

// spec: add-account › Sign-out data › server not reached
test('server not reached: the sign-out request fails — the player still sees «вышел»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, endSession: { fail: { status: 0, code: 'unreachable' } } } });
  await signOut(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  await expect(page.getByText(LINE).first()).toBeVisible();
  expect(await calls(page)).toContain('worker:endSession');
  expect(await privyCalls(page)).toContain('privy:logout');
});

// spec: add-account › Sign-out data › server not reached
test('server not reached: the server is down, so Home can\'t load either — «вышел» all the same, under the connection line', async ({ page }) => {
  const down = { fail: { status: 0, code: 'unreachable' } };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, endSession: down, signIn: down } });
  await signOut(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByText(UNREACHABLE).first()).toBeVisible();
  // the Toast, the page's Live with both lines, and the focus on the h1
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: LINE }).filter({ hasText: UNREACHABLE })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeFocused();
  // the Toast has its band: the connection line under it stays readable
  const toast = await page.locator('.ds-toast').boundingBox();
  const banner = await page.locator('.ds-banner').boundingBox();
  expect(toast!.y + toast!.height).toBeLessThanOrEqual(banner!.y);
});

// spec: add-account › Home screen › signed-out (вход закрыт) × выход при закрытом входе
// spec: add-account › Sign-out flow › вышел
test('выход при закрытом входе: Home\'s closed view with the line', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, signIn: CLOSED_NEW } });
  await signOut(page);
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Played here before? Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toHaveCount(0);
});

// spec: add-account › Sign-out flow › вышел × Back после выхода
test('вышел × Back после выхода: Back leads to a visitor\'s page — no Account, no conversation', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { pets: { '9': PIXEL, '2': BISCUIT }, owned: ['9'], me: ME_PIXEL } });
  await page.getByRole('link', { name: 'Go to your Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await signOut(page);
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
});

// spec: add-account › Sign-out flow › вышел × перезагрузка
test('вышел × перезагрузка: a reload shows Home without the line', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await signOut(page);
  await expect(page.getByText(LINE).first()).toBeVisible();
  // the browser holds no session now: the fakes of the reloaded page start signed out
  await page.evaluate(() => sessionStorage.setItem('e2e-signed-out', '1'));
  await page.addInitScript(() => {
    const g = globalThis as { __NEARLING_FAKES__?: { auth?: { authenticated?: boolean } } };
    if (sessionStorage.getItem('e2e-signed-out') && g.__NEARLING_FAKES__) g.__NEARLING_FAKES__.auth = { authenticated: false };
  });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: HOOK })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toBeVisible();
  await expect(page.getByText(LINE)).toHaveCount(0);
});
