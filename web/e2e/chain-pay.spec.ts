import { expect, test } from '@playwright/test';
import { calls, openWith, PIXEL, SIGNED_IN } from './helpers';

const token = { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', blockchain: 'base',
  symbol: 'USDC', decimals: 6, price: 1, contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' };
const quote = { id: 'a'.repeat(32), signature: 'fixture-signature', providerReference: 'fixture-reference', quote: {
  amountIn: '250000', amountInUsd: '0.25', amountOut: '49000000000000000000000', amountOutUsd: '0.23',
  minAmountOut: '48510000000000000000000', refundFee: '10000', withdrawFee: '0', timeEstimate: 120,
} };
const accepted = { ...quote, serverTime: 'Wed, 11 Nov 2026 20:35:00 GMT', refundTo: `0x${'b'.repeat(40)}`, quote: { ...quote.quote,
  depositAddress: `0x${'c'.repeat(40)}`, depositMemo: 'pixel-9-quote',
  timeWhenInactive: '2026-11-11T20:40:00Z', deadline: '2026-11-11T20:45:00Z',
} };
const worker = { pets: { '9': { ...PIXEL, fullness: { state: 'hungry' as const, level: 0.25 } } },
  anyChainTokens: { tokens: [token] }, anyChainQuote: quote, anyChainAccept: accepted };

// spec: add-any-chain-feed › Cross-chain quote flow › feed entry
test('Feed keeps its NEAR and snack actions beside the two chain entries', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...worker, owned: ['9'] } });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const feed = page.getByRole('dialog', { name: 'Feed Pixel' });
  await expect(feed.getByRole('button', { name: 'Pay from another chain' })).toBeVisible();
  await expect(feed.getByRole('button', { name: "Send USDC to Pixel's address" })).toBeVisible();
  await expect(feed.getByRole('button', { name: /^Feed · / }).first()).toBeVisible();
  await feed.getByRole('button', { name: 'Pay from another chain' }).click();
  await expect(page.getByRole('dialog', { name: 'Pay from another chain' })).toBeVisible();
});

// spec: add-any-chain-feed › Cross-chain availability rule › services paused
test('a paused Feed lists the notice and the chain entries before «Ask friends»; only the new payment is off', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...worker, owned: ['9'], feedSheet: { crossChainPaused: true } } });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const feed = page.getByRole('dialog', { name: 'Feed Pixel' });
  const notice = feed.getByText('New cross-chain payments are paused. Deposits already sent can still arrive.').and(page.locator(':not(.ds-hidden)'));
  await expect(notice).toBeVisible();
  await expect(feed.getByRole('button', { name: 'Pay from another chain' })).toBeDisabled();
  await expect(feed.getByRole('button', { name: "Send USDC to Pixel's address" })).toBeEnabled();
  const [pay, address, ask] = await Promise.all(['Pay from another chain', "Send USDC to Pixel's address", 'Ask friends to feed Pixel']
    .map(async (name) => (await feed.getByRole('button', { name }).boundingBox())!.y));
  expect(pay).toBeLessThan(address!);
  expect(address).toBeLessThan(ask!);
});

// spec: add-any-chain-feed › Cross-chain quote flow › guest quote
// spec: add-any-chain-feed › Cross-chain pay sheet screen › success
// spec: add-any-chain-feed › Cross-chain quote flow › quote created
test('a signed-out friend gets a payable quote and one-time details without Google', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-11T20:35:00Z') });
  await openWith(page, '/pet/9?via=feed', { worker });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await page.getByRole('button', { name: 'Pay from another chain' }).click();
  const pay = page.getByRole('dialog', { name: 'Pay from another chain' });
  await pay.getByLabel('Return address').fill(`0x${'b'.repeat(40)}`);
  await pay.getByRole('button', { name: 'Get payment address' }).click();
  await expect(pay.getByText('0.04851 NEAR')).toBeVisible();
  await expect(pay.getByRole('button', { name: 'Get payment address' })).toBeVisible();
  await pay.getByRole('button', { name: 'Get payment address' }).click();
  await expect(pay.getByLabel('Send to this address')).toHaveValue(`0x${'c'.repeat(40)}`);
  await expect(pay.getByLabel('Memo to include')).toHaveValue('pixel-9-quote');
  await expect(pay.getByText('0.25 USDC')).toBeVisible();
  await expect(pay.getByRole('button', { name: 'View payment status' })).toBeVisible();
  expect(await calls(page)).not.toContain('privy:load');
});

// spec: add-any-chain-feed › Cross-chain availability rule › changed quote
test('a changed quote removes its destination and asks for a new one', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-11T20:35:00Z') });
  await openWith(page, '/pet/9?via=feed', { worker: { ...worker, anyChainAccept: { fail: { status: 409, code: 'quote_expired' } } } });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await page.getByRole('button', { name: 'Pay from another chain' }).click();
  const pay = page.getByRole('dialog', { name: 'Pay from another chain' });
  await pay.getByLabel('Return address').fill(`0x${'b'.repeat(40)}`);
  await pay.getByRole('button', { name: 'Get payment address' }).click();
  await pay.getByRole('button', { name: 'Get payment address' }).click();
  await expect(pay.getByText('This quote expired. Get a new quote before sending.').and(page.locator(':not(.ds-hidden)'))).toBeVisible();
  await expect(pay.getByLabel('Send to this address')).toHaveCount(0);
});

// spec: add-any-chain-feed › Cross-chain availability rule › services paused
test('Feed says new cross-chain payments are paused and offers no new quote, the pet address stays', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...worker, owned: ['9'], feedSheet: { crossChainPaused: true } } });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const feed = page.getByRole('dialog', { name: 'Feed Pixel' });
  await expect(feed.getByText('New cross-chain payments are paused. Deposits already sent can still arrive.')).toBeVisible();
  await expect(feed.getByRole('button', { name: 'Pay from another chain' })).toBeDisabled();
  await expect(feed.getByRole('button', { name: "Send USDC to Pixel's address" })).toBeEnabled();
});
