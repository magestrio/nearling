import { expect, test } from '@playwright/test';
import { calls, openWith, OWNER } from './helpers';

const placeOf = (page: import('@playwright/test').Page) => page.evaluate(() => sessionStorage.getItem('nearling.returnPlace'));

// spec: add-pet › Pet screen › signed-out
test('signed-out: the pet in its state, its name and fullness, no conversation; «Feed Biscuit» and «Sign in»', async ({ page }) => {
  await openWith(page, '/pet/2', {});
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  await expect(page.getByText('Full', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: "Check it's really Biscuit" })).toHaveAttribute('href', '/pet/2/verify');
  await expect(page.getByRole('button', { name: 'Pause motion' })).toBeVisible();
  await expect(page.getByRole('log')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

// spec: add-pet › Pet screen › signed-out
test('signed-out: a sleeping pet says «Biscuit is asleep — food from you would wake Biscuit up.»', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { pets: { '2': { tokenId: '2', name: 'Biscuit', stage: 'adult', fullness: { state: 'asleep', level: 0 }, mood: null } } } });
  await expect(page.getByRole('paragraph').filter({ hasText: 'Biscuit is asleep — food from you would wake Biscuit up.' })).toBeVisible();
  await expect(page.getByText('Asleep', { exact: true })).toBeVisible();
});

// spec: add-pet › Pet screen › signed-out × загрузка страницы без запроса к Privy
test('signed-out × загрузка страницы без запроса к Privy: a visitor\'s page load makes no call to Privy', async ({ page }) => {
  await openWith(page, '/pet/2', {});
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect((await calls(page)).filter((c) => c.startsWith('privy:'))).toEqual([]);
});

// spec: add-pet › Pet screen › signed-out × тап Sign in
test('signed-out × тап Sign in: the place and `signin` wait in the tab, Privy gets `/`, the sign-in starts from the same tap', async ({ page }) => {
  await openWith(page, '/pet/2?from=9', {});
  await page.getByRole('button', { name: 'Sign in' }).click();
  expect((await calls(page)).filter((c) => c.startsWith('privy:'))).toEqual(['privy:load', 'privy:login']);
  // the fake signs in at once: the tab is led back to the pet
  await expect(page).toHaveURL(/\/pet\/2\?from=9$/);
  expect(await placeOf(page)).toBeNull();
});

// spec: add-pet › Pet screen › signed-out × тап Feed без входа
test('signed-out × тап Feed без входа: the place and the action `feed` wait in the tab and the sign-in starts', async ({ page }) => {
  await page.addInitScript(() => {
    const seen: Array<string | null> = [];
    (globalThis as { __PLACES__?: unknown }).__PLACES__ = seen;
    const original = history.replaceState.bind(history);
    history.replaceState = (data, unused, url) => {
      if (String(url) === '/') seen.push(sessionStorage.getItem('nearling.returnPlace'));
      original(data, unused, url);
    };
  });
  await openWith(page, '/pet/2', {});
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  expect((await calls(page)).filter((c) => c.startsWith('privy:'))).toEqual(['privy:load', 'privy:login']);
  const places = await page.evaluate(() => (globalThis as { __PLACES__?: Array<string | null> }).__PLACES__ ?? []);
  expect(JSON.parse(places[0]!)).toEqual({ path: '/pet/2', action: 'feed' });
});

// spec: add-pet › Pet screen › signed-out (вошёл владелец)
test('signed-out (вошёл владелец): after the sign-in the page is the owner\'s — the field and the conversation', async ({ page }) => {
  await openWith(page, '/pet/9', { worker: OWNER });
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
});
