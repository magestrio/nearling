import { expect, test } from '@playwright/test';

// Init has no capability behavior, so this spec carries no spec anchor: it proves the dev-only day-1
// route and the three seams (Worker, RPC, Privy) work against their fakes.

test.beforeEach(async ({ page }) => {
  // Nothing outside the local dev server is reachable: no fonts, no Privy, no RPC.
  await page.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => route.abort());
});

test('the day-1 route signs in through the fake Privy, returns to its place, creates a wallet and sends a transfer', async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__ = {
      worker: { version: 'v-e2e' },
      rpc: { viewResult: '0.1.0', txHash: 'TxHashFromTheFakeRpc' },
    };
  });

  await page.goto('/__day1');
  await expect(page.getByTestId('worker')).toHaveText('e2e v-e2e');
  await expect(page.getByTestId('contract')).toHaveText('nearling-e2e.testnet version 0.1.0');
  await expect(page.getByTestId('account')).toHaveText('none');

  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  // The sign-in began at `/` (the only address Privy sees), then the tab went back to where it was.
  await expect(page).toHaveURL(/\/__day1$/);
  await expect(page.getByText('signed in: true')).toBeVisible();

  await page.getByRole('button', { name: 'Create NEAR wallet' }).click();
  await expect(page.getByTestId('account')).toHaveText('a'.repeat(64));

  await page.getByRole('button', { name: /^Send 0\.001 NEAR to / }).click();
  await expect(page.getByText('transfer sent')).toBeVisible();
  await expect(page.getByTestId('log').last()).toHaveText('TxHashFromTheFakeRpc');
});

test('the home page shows no day-1 controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(0);
});
