import { expect, test, type Page } from '@playwright/test';
import { calls, openWith, privyCalls, UA } from './helpers';

const PHONE = { width: 390, height: 844 };
const dialog = (page: Page) => page.getByRole('dialog');
const TITLE = 'Open in your browser to sign in';
const WHY = "Google sign-in doesn't work inside some apps. Your spot is saved in the link.";
const COPIED = 'Link copied — paste it into Safari.';
const opened = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('open:'));

test.describe('Android, inside X', () => {
  test.use({ userAgent: UA.xOnAndroid, viewport: PHONE });

  // spec: add-account › Open in browser sheet screen › success (Android)
  // spec: add-account › Sign-in flow › встроенный браузер
  test('встроенный браузер: instead of Google the sheet — title, why, «Open in browser»; the pet on screen does not change', async ({ page }) => {
    await openWith(page, '/pet/2', {});
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(dialog(page).getByRole('heading', { name: TITLE })).toBeVisible();
    await expect(dialog(page)).toContainText(WHY);
    await expect(dialog(page).getByRole('button', { name: 'Open in browser' })).toBeVisible();
    expect(await privyCalls(page)).toEqual([]);
    await expect(page.locator('.ds-only[inert]')).toHaveCount(1);
    await expect(page).toHaveURL(/\/pet\/2$/);
  });

  // spec: add-account › Open in browser sheet screen › success (Android)
  test('success (Android): «Open in browser» hands the same page to the system as an `intent://` link, with the mark of the app', async ({ page }) => {
    await openWith(page, '/pet/2?c=friend', {});
    await page.getByRole('button', { name: 'Feed Biscuit' }).click();
    await page.getByRole('button', { name: 'Open in browser' }).click();
    const [call] = await opened(page);
    expect(call).toMatch(/^open:intent:\/\/127\.0\.0\.1:5199\/pet\/2\?/);
    expect(call).toContain('ib=x');
    expect(call).toContain('c=friend');
    // nothing of the tapped action or the session in it
    expect(call).not.toMatch(/feed|token|session/i);
  });

  // spec: add-account › Open in browser sheet screen › success (Android) × Close и Esc
  test('success (Android) × Close и Esc: both close it; the page as before', async ({ page }) => {
    await openWith(page, '/pet/2', {});
    await page.getByRole('button', { name: 'Sign in' }).click();
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
    expect(await privyCalls(page)).toEqual([]);
  });

  // spec: add-account › Open in browser sheet screen › error
  test('error: the page still on screen 2 seconds after the tap — «Copy this link and paste it into your browser:» and the link in a field', async ({ page }) => {
    await page.clock.install();
    await openWith(page, '/pet/2', {});
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Open in browser' }).click();
    await page.clock.runFor(1900);
    await expect(dialog(page).getByRole('textbox')).toHaveCount(0);
    await page.clock.runFor(200);
    const field = dialog(page).getByLabel('Copy this link and paste it into your browser:');
    await expect(field).toBeVisible();
    await expect(field).toHaveValue(/\/pet\/2\?ib=x$/);
    await expect(field).toHaveAttribute('readonly', '');
    await expect(dialog(page).getByRole('button', { name: 'Open in browser' })).toHaveCount(0);
    // the focus is in the field, its text selected, for the player to copy by hand
    await expect(field).toBeFocused();
  });

  // spec: add-account › Open in browser sheet screen › error × страница ушла за 2 секунды
  test('error × страница ушла за 2 секунды: the page went away — no field, the timer is cancelled', async ({ page }) => {
    await page.clock.install();
    await openWith(page, '/pet/2', {});
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Open in browser' }).click();
    await page.clock.runFor(800);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.clock.runFor(5000);
    await expect(dialog(page).getByRole('textbox')).toHaveCount(0);
    await expect(dialog(page).getByRole('button', { name: 'Open in browser' })).toBeVisible();
  });
});

test.describe('iPhone, inside X', () => {
  test.use({ userAgent: UA.xOnIphone, viewport: PHONE, permissions: ['clipboard-read', 'clipboard-write'] });

  // spec: add-account › Open in browser sheet screen › success (iPhone)
  test('success (iPhone): «Copy link», then «Link copied — paste it into Safari.»; the clipboard holds the link to the same place', async ({ page }) => {
    await openWith(page, '/pet/2', {});
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(dialog(page).getByRole('heading', { name: TITLE })).toBeVisible();
    await expect(dialog(page)).toContainText(WHY);
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(dialog(page).locator('.ds-note')).toHaveText(COPIED);
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/\/pet\/2\?ib=x$/);
    expect(await opened(page)).toEqual([]);
  });

  // spec: add-account › Sign-in flow › открыл в браузере
  test('открыл в браузере: the link opens the same page as for any visitor with no session; the action is not continued', async ({ page, browser }) => {
    await openWith(page, '/pet/2', {});
    await page.getByRole('button', { name: 'Feed Biscuit' }).click();
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(dialog(page).locator('.ds-note')).toHaveText(COPIED);
    const link = await page.evaluate(() => navigator.clipboard.readText());
    // a real browser: a fresh context with no session and no in-app mark in its user agent
    const real = await (await browser.newContext({ userAgent: UA.iphone })).newPage();
    await openWith(real, new URL(link).pathname + new URL(link).search, {});
    await expect(real.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
    await expect(real.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
    await expect(real.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(real.getByRole('dialog')).toHaveCount(0);
    expect(await privyCalls(real)).toEqual([]);
    expect((await calls(real)).filter((c) => c.startsWith('worker:say'))).toEqual([]);
    // the tap on «Sign in» there starts the sign-in (`вход начат`): no sheet for a browser that is not in-app
    await real.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => privyCalls(real)).toEqual(['privy:load', 'privy:login']);
  });

  // spec: add-account › Open in browser sheet screen › error
  test('error: the link was not copied — «Copy this link and paste it into Safari:» and the link in a read-only field', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } });
    });
    await openWith(page, '/pet/2', {});
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Copy link' }).click();
    const field = dialog(page).getByLabel('Copy this link and paste it into Safari:');
    await expect(field).toBeVisible();
    await expect(field).toHaveValue(/\/pet\/2\?ib=x$/);
    await expect(field).toHaveAttribute('readonly', '');
    await expect(dialog(page).getByText(COPIED)).toHaveCount(0);
  });
});
