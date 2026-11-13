import { expect, test } from '@playwright/test';
import { BISCUIT, calls, openWith, SIGNED_IN } from './helpers';
import { RECEIPT_CODE, receiptLinkFakes } from './verification.fixtures';

const ME_PIXEL = { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };

// spec: add-showcase › Public demo flow › README pet link
test('a public demo pet URL opens the existing guest page without Google', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { pets: { '2': BISCUIT } } });
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  expect((await calls(page)).filter((call) => call.startsWith('privy:'))).toEqual([]);
});

// spec: add-showcase › Public demo flow › README proof link
test('a published proof URL opens the existing anonymous receipt check', async ({ page }) => {
  await openWith(page, `/receipt/${RECEIPT_CODE}`, receiptLinkFakes());
  await expect(page.getByText("These bytes were shared by Pixel's owner. Compare their hashes with the receipt on NEAR.").filter({ visible: true })).toBeVisible();
  expect((await calls(page)).filter((call) => call.startsWith('privy:'))).toEqual([]);
});

// spec: add-showcase › Public demo flow › README numbers link
test('the README numbers URL shows Home to a visitor', async ({ page }) => {
  await openWith(page, '/?showcase=numbers', {});
  await expect(page.locator('.ds-meadow__stats')).toContainText('312 hires');
  await expect(page.getByRole('link', { name: 'See it on the NEAR explorer' })).toBeVisible();
});

// spec: add-showcase › Public demo flow › README numbers link with a session
test('the same URL keeps a signed-in player on Home through reload, while ordinary Home redirects', async ({ page }) => {
  await openWith(page, '/?showcase=numbers', { auth: SIGNED_IN, worker: { me: ME_PIXEL, owned: ['9'] } });
  await expect(page.locator('.ds-meadow__stats')).toContainText('87 friend snacks');
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/\?showcase=numbers$/);
  await expect(page.locator('.ds-meadow__stats')).toContainText('312 hires');
  await page.goto('/');
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-showcase › Public demo flow › README numbers link with a session × sign-out
test('sign-out from the public numbers returns to visitor Home', async ({ page }) => {
  await openWith(page, '/?showcase=numbers', { auth: SIGNED_IN });
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.ds-meadow__stats')).toContainText('312 hires');
});
