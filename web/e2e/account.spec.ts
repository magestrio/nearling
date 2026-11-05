import { expect, test } from '@playwright/test';
import { BISCUIT, CLOSED_NEW, openWith, OWNER, PIXEL, SIGNED_IN, UA } from './helpers';

const ASLEEP = { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 } };
const ME_PIXEL = { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };

// spec: add-account › Account menu screen › success (владелец)
test('success (владелец): «Signed in as {email}», «Clear Pixel\'s memory» and «Sign out»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await page.getByRole('button', { name: 'Account' }).click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(page.getByText('Signed in as sam@example.com')).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(["Clear Pixel's memory", 'Sign out']);
  await expect(page.getByRole('button', { name: 'Account' })).toHaveAttribute('aria-expanded', 'true');
  // the focus lands on the first item; the arrows, Home and End move between the items
  await expect(menu.getByRole('menuitem', { name: "Clear Pixel's memory" })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: "Clear Pixel's memory" })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem', { name: "Clear Pixel's memory" })).toBeFocused();
});

// spec: add-account › Account menu screen › success (владелец) × Account и Esc
test('success (владелец) × Account и Esc: Esc closes the menu and the focus is back on «Account»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  const account = page.getByRole('button', { name: 'Account' });
  await account.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(account).toBeFocused();
  await expect(account).not.toHaveAttribute('aria-expanded', 'true');
  // a second tap opens it again; Tab closes it and the focus goes on
  await account.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

// spec: add-account › Account menu screen › success (владелец) × Clear memory
test('success (владелец) × Clear memory: the menu closes and the Clear memory dialog opens on its safe action; «Keep memory» returns to «Account»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  const dialog = page.getByRole('alertdialog', { name: "Clear Pixel's memory?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep memory' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Keep memory' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account' })).toBeFocused();
});

// spec: add-account › Account menu screen › success (владелец) × питомец спит
test('success (владелец) × питомец спит: the memory row is there for a sleeping pet too', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': ASLEEP, '2': BISCUIT } } });
  await expect(page.getByText('Asleep', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menuitem', { name: "Clear Pixel's memory" })).toBeVisible();
});

// spec: add-account › Account menu screen › success
test('success: a friend\'s pet — «Signed in as {email}» and «Sign out», no memory row', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { ...OWNER, me: ME_PIXEL } });
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByText('Signed in as sam@example.com')).toBeVisible();
  await expect(page.getByRole('menuitem')).toHaveText(['Sign out']);
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
});

// spec: add-account › Account menu screen › success × Hatch screen
test('success × Hatch screen: the Account button stands in the Hatch screen\'s header, its menu has no memory row', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByText('Signed in as sam@example.com')).toBeVisible();
  await expect(page.getByRole('menuitem')).toHaveText(['Sign out']);
});

// spec: add-account › Account menu screen › success
test('success: a visitor has no Account button', async ({ page }) => {
  await openWith(page, '/pet/2', {});
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
});

// spec: add-account › Account menu screen › success
test('success: signed-in catalog and hire board keep the ordinary Account menu', async ({ page }) => {
  await openWith(page, '/adapters', { auth: SIGNED_IN });
  const account = page.getByRole('button', { name: 'Account' });
  await expect(account).toBeVisible();
  await account.click();
  await expect(page.getByRole('menuitem')).toHaveText(['Sign out']);
  await page.keyboard.press('Escape');
  await expect(account).toBeFocused();
  await page.goto('/hire');
  await expect(page).toHaveURL('/hire');
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Sign out']);
});

// spec: add-account › Sign-in flow › вход закрыт
test('catalog and hire board use the shared Sign-in closed sheet', async ({ page }) => {
  await openWith(page, '/adapters', { worker: { signIn: CLOSED_NEW } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('dialog')).toContainText("We're full for new players this month.");
  await page.getByRole('button', { name: 'Keep looking' }).click();
  await page.goto('/hire');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('dialog')).toContainText("We're full for new players this month.");
});

test.describe('account screens inside X on Android', () => {
  test.use({ userAgent: UA.xOnAndroid, viewport: { width: 390, height: 844 } });

  // spec: add-account › Sign-in flow › встроенный браузер
  test('catalog and hire board offer the shared Open in browser sheet', async ({ page }) => {
    await openWith(page, '/adapters');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('dialog')).toContainText('Open in your browser to sign in');
    await page.getByRole('button', { name: 'Close' }).click();
    await page.goto('/hire');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('dialog')).toContainText('Open in your browser to sign in');
  });
});
