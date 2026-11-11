import { expect, test } from '@playwright/test';
import { calls, openWith, PIXEL } from './helpers';

const addresses = { tokenId: '9', minimumFoodYocto: '10000000000000000000000', addresses: [
  { chain: 'base' as const, address: `0x${'c'.repeat(40)}`, asset: 'base-usdc',
    contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amountUsdc: '0.03',
    waitSeconds: 120, path: 'base:9' },
  { chain: 'solana' as const, address: '7BvUeXf9o1PaY6tq4JQdS8Lw7ZcH3rK2mN5gT1yF6aR', asset: 'sol-usdc',
    contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amountUsdc: '0.03',
    waitSeconds: 120, path: 'solana:9' },
] };
const worker = { pets: { '9': PIXEL }, anyChainAddresses: addresses };

// spec: add-any-chain-feed › Pet address deposit flow › address entry
// spec: add-any-chain-feed › Pet address sheet screen › success
test('a visitor sees the two pet-bound addresses without Google', async ({ page }) => {
  await openWith(page, '/pet/9?via=feed', { worker });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await page.getByRole('button', { name: "Send USDC to Pixel's address" }).click();
  await expect(page.getByText('0.03 USDC').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy Base address' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy Solana address' })).toBeVisible();
  expect(await calls(page)).not.toContain('privy:load');
});

// spec: add-any-chain-feed › Pet address deposit flow › sender obtains status link
// spec: add-any-chain-feed › Pet address data › sender transaction lookup
test('a source hash produces an opaque public status link', async ({ page }) => {
  const id = 'b'.repeat(32);
  await openWith(page, '/pet/9?via=feed', { worker: { ...worker, anyChainTrack: {
    id, url: `/pet/9/feed/status/${id}`, status: { state: 'waiting_for_owner',
      source: 'https://basescan.org/tx/source', nearCredit: null, refund: null },
  } } });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await page.getByRole('button', { name: "Send USDC to Pixel's address" }).click();
  await page.getByRole('link', { name: 'Track this deposit' }).click();
  await page.getByLabel('Your transfer ID').fill(`0x${'a'.repeat(64)}`);
  await page.getByRole('button', { name: 'Track this deposit' }).click();
  await expect(page.getByText('Waiting for owner')).toBeVisible();
  await expect(page.getByLabel('Link to this deposit’s status')).toHaveValue(new RegExp(`/pet/9/feed/status/${id}$`));
  expect(await calls(page)).not.toContain('privy:load');
});
