import { expect, test, type Page } from '@playwright/test';
import { calls, CLOSED_ALL, CLOSED_NEW, openWith, privyCalls, setWorker, UA } from './helpers';

const placeOf = (page: Page) => page.evaluate(() => sessionStorage.getItem('nearling.returnPlace'));
const NEW_WORDS = "We're full for new players this month. Sign-ups open again on December 1 — until then, you can still look around.";
const ALL_WORDS = 'Sign-in is closed for everyone until December 1. You can still look around, and any pet you have is safe.';
const MAU_LINE = "Looks like you haven't played here this month, so we can't sign you in until December 1. You can still look around.";
const dialog = (page: Page) => page.getByRole('dialog');

// spec: add-account › Sign-in closed sheet screen › success (закрыт для новых)
test('closed for new players: the sheet says so and until when, «Played here before? Sign in» and «Keep looking»', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { signIn: CLOSED_NEW } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText(NEW_WORDS);
  await expect(dialog(page).getByRole('button', { name: 'Played here before? Sign in' })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Keep looking' })).toBeVisible();
});

// spec: add-account › Sign-in closed sheet screen › success (закрыт для всех)
test('closed for everyone: the sheet says so, «Keep looking» alone, no «Played here before? Sign in»', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { signIn: CLOSED_ALL } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog(page)).toContainText(ALL_WORDS);
  await expect(dialog(page).getByRole('button', { name: 'Keep looking' })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Played here before? Sign in' })).toHaveCount(0);
});

// spec: add-account › Sign-in flow › вход закрыт
test('вход закрыт: instead of Google the sheet, and `sign_in_blocked` with reason mau', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { signIn: CLOSED_NEW } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(dialog(page)).toContainText(NEW_WORDS);
  expect(await privyCalls(page)).toEqual([]);
  expect(await calls(page)).toContain('worker:signInState');
  // the page under it is out of reach, and not changed
  await expect(page.locator('.ds-only[inert]')).toHaveCount(1);
  await expect(page).toHaveURL(/\/pet\/2$/);
});

// spec: add-account › Sign-in flow › вход закрыт для всех
test('вход закрыт для всех: instead of Google the sheet with «Keep looking» only', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { signIn: CLOSED_ALL } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog(page)).toContainText(ALL_WORDS);
  await expect(dialog(page).getByRole('button')).toHaveCount(2); // «Close» and «Keep looking»
  expect(await privyCalls(page)).toEqual([]);
});

// spec: add-account › Sign-in closed sheet screen › success (закрыт для новых) × Keep looking
test('success (закрыт для новых) × Keep looking: closes, the page, the address and the tab\'s place as before', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { signIn: CLOSED_NEW } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await page.getByRole('button', { name: 'Keep looking' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/2$/);
  expect(await placeOf(page)).toBeNull();
  expect(await privyCalls(page)).toEqual([]);
  // the focus is back on the control that opened it
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeFocused();
});

// spec: add-account › Sign-in closed sheet screen › success (закрыт для всех) × Keep looking
test('success (закрыт для всех) × Keep looking: closes by the button, by Close and by Esc; no sign-in', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { signIn: CLOSED_ALL } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Keep looking' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  expect(await privyCalls(page)).toEqual([]);
});

// spec: add-account › Sign-in closed sheet screen › success (закрыт для новых) × Played here before? Sign in с действием Feed
test('success (закрыт для новых) × Played here before? Sign in с действием Feed: the sign-in starts and the tapped «Feed» waits in the tab', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { signIn: CLOSED_NEW } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await page.evaluate(() => {
    const original = history.replaceState.bind(history);
    const seen: Array<string | null> = [];
    (globalThis as { __PLACES__?: unknown }).__PLACES__ = seen;
    history.replaceState = (data, unused, url) => {
      if (String(url) === '/') seen.push(sessionStorage.getItem('nearling.returnPlace'));
      original(data, unused, url);
    };
  });
  await page.getByRole('button', { name: 'Played here before? Sign in' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
  const places = await page.evaluate(() => (globalThis as { __PLACES__?: Array<string | null> }).__PLACES__ ?? []);
  expect(JSON.parse(places[0]!)).toEqual({ path: '/pet/2', action: 'feed' });
  await expect(page).toHaveURL(/\/pet\/2$/);
});

// spec: add-account › Sign-in flow › вход начат × вход закрылся после открытия вкладки
test('вход начат × вход закрылся после открытия вкладки: the gate is read at the tap, so the sheet comes instead of Google', async ({ page }) => {
  await openWith(page, '/pet/2', {});
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await setWorker(page, { signIn: CLOSED_NEW });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog(page)).toContainText(NEW_WORDS);
  expect(await privyCalls(page)).toEqual([]);
});

test.describe('in an in-app browser', () => {
  test.use({ userAgent: UA.xOnAndroid });

  // spec: add-account › Sign-in flow › вход закрыт × встроенный браузер
  test('вход закрыт × встроенный браузер: the closed sheet first, then Open in browser sheet from «Played here before? Sign in»', async ({ page }) => {
    await openWith(page, '/pet/2', { worker: { signIn: CLOSED_NEW } });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(dialog(page)).toContainText(NEW_WORDS);
    await expect(dialog(page).getByRole('button', { name: 'Open in browser' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Played here before? Sign in' }).click();
    await expect(dialog(page)).toContainText('Open in your browser to sign in');
    expect(await privyCalls(page)).toEqual([]);
  });
});

// spec: add-account › Sign-in flow › новый после Google
test('новый после Google: «Looks like you haven\'t played here this month…» under the action; no session, the same screen', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { session: { refused: { reason: 'mau', until: CLOSED_NEW.until } } } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await expect(page.getByText(MAU_LINE).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  // the browser's Privy session is ended by the refusal
  expect((await calls(page)).filter((c) => c === 'privy:logout')).toHaveLength(1);
});

// spec: add-account › Sign-in flow › новый после Google × действие не продолжается
test('новый после Google × действие не продолжается: «Feed» tapped before Google is not run, no sheet opens', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { session: { refused: { reason: 'mau', until: CLOSED_NEW.until } } } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByText(MAU_LINE).first()).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  expect(await placeOf(page)).toBeNull();
  // a new tap clears the line
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(MAU_LINE).first()).toBeVisible();
});

// spec: add-account › Sign-in flow › закрылся для всех после Google
test('закрылся для всех после Google: the sheet «closed for everyone», no session, the same screen', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { session: { refused: { reason: 'ceiling', until: CLOSED_ALL.until } } } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog(page)).toContainText(ALL_WORDS);
  await expect(dialog(page).getByRole('button', { name: 'Played here before? Sign in' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/pet\/2$/);
  await page.getByRole('button', { name: 'Keep looking' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText(MAU_LINE)).toHaveCount(0);
});
