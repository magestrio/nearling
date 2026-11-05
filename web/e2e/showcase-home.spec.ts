import { expect, test } from '@playwright/test';
import { openWith } from './helpers';
import { SAMPLE_SHOWCASE } from '../src/seams/showcase.sample';

const since = Date.UTC(2026, 10, 5) * 1_000_000;

// spec: add-showcase › Home evidence flow › public totals
test('Home shows the added on-chain counts and opens the contract explorer', async ({ page }) => {
  await openWith(page, '/', {});
  await expect(page.locator('.ds-meadow__stats')).toContainText('312 hires');
  await expect(page.locator('.ds-meadow__stats')).toContainText('87 friend snacks');
  await expect(page.getByRole('link', { name: 'See it on the NEAR explorer' })).toHaveAttribute('href', 'https://testnet.nearblocks.io/address/nearling-e2e.testnet');
});

// spec: add-showcase › Home evidence flow › partial history
test('each counter marks the upgrade date', async ({ page }) => {
  await openWith(page, '/', { worker: { showcase: { ...SAMPLE_SHOWCASE, numbers: { ...SAMPLE_SHOWCASE.numbers!, counted_since: since } } } });
  await expect(page.locator('.ds-meadow__stat').nth(3)).toContainText('since November 5');
  await expect(page.locator('.ds-meadow__stat').nth(4)).toContainText('since November 5');
});

// spec: add-showcase › Showcase totals rule › no new activity
test('zero accepted hires and snacks remain visible with the partial label', async ({ page }) => {
  await openWith(page, '/', { worker: { showcase: { ...SAMPLE_SHOWCASE, numbers: { ...SAMPLE_SHOWCASE.numbers!, hires_completed: 0, friend_snacks: 0, counted_since: since } } } });
  await expect(page.locator('.ds-meadow__stat').nth(3)).toContainText('0 hires');
  await expect(page.locator('.ds-meadow__stat').nth(4)).toContainText('0 friend snacks');
  await expect(page.locator('.ds-meadow__stat').nth(3)).toContainText('since November 5');
});

// spec: add-showcase › Home evidence flow › totals unavailable
test('a failed copy does not leave stale totals on Home', async ({ page }) => {
  await openWith(page, '/', { worker: { showcase: { fail: { status: 503, code: 'chain_unreachable' } } } });
  await expect(page.locator('.ds-meadow__stats')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'See it on the NEAR explorer' })).toBeVisible();
});
