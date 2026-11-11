import { expect, test, type Page } from '@playwright/test';
import { calls, lookAgain, openWith, PIXEL, setWorker } from './helpers';
import type { OwnerDepositRead } from '../src/any-chain/types';

const id = 'b'.repeat(32);
const route = 'c'.repeat(32);
const path = `/pet/9/feed/status/${id}`;
const address = `0x${'d'.repeat(40)}`;
const source = `https://basescan.org/tx/0x${'e'.repeat(64)}`;
const publicStatus = { id, tokenId: '9', state: 'waiting_for_owner' as const, source, nearCredit: null, refund: null };
const owner: OwnerDepositRead = { deposit: { id, token_id: '9', chain: 'base',
  source_tx_hash: `0x${'e'.repeat(64)}`, asset: 'usdc', amount_units: '340000', state: 'waiting',
  address, source_explorer: source, near_credit_tx: null, source_refund_tx: null },
convertedUnits: '0', sweep: { routeId: route, amountUnits: '200000', destination: `0x${'f'.repeat(40)}`,
  refundTo: address, quote: { quote: { amountIn: '200000', amountInUsd: '0.20',
    amountOut: '40000000000000000000000', amountOutUsd: '0.19', minAmountOut: '39600000000000000000000',
    refundFee: '10000', withdrawFee: '0', timeEstimate: 19 } }, approvalHash: 'a'.repeat(64),
  expiryMs: Date.now() + 300_000, state: 'quoted', nearTxHash: null, sourceTxHash: null,
  windowEndsAt: Date.now() + 3_600_000 } };
// The status line is mirrored into a visually hidden live region; the visible one is the span.
const visibleLine = (page: Page, text: string) => page.locator('span', { hasText: text });
const signedIn = { authenticated: true, nearAccountId: 'a'.repeat(64) };
const worker = { pets: { '9': PIXEL }, owned: ['9'], anyChainDepositStatus: publicStatus,
  anyChainOwnerDeposit: owner };

// spec: add-any-chain-feed › Pet address deposit flow › owner authorization pending
// spec: add-any-chain-feed › Pet address deposit flow › deposit exceeds one sweep
// spec: add-any-chain-feed › Pet address data › owner approval leaves browser
test('the current owner sees one portion and signs its same-chain return', async ({ page }) => {
  await openWith(page, path, { auth: signedIn, worker });
  await expect(page.getByText('0.14 USDC')).toBeVisible();
  await expect(page.getByText(address)).toBeVisible();
  await expect(page.getByText('0.0396 NEAR')).toBeVisible();
  await page.getByRole('button', { name: 'Approve conversion' }).click();
  await expect.poll(async () => calls(page)).toContain('worker:anyChainSweepApprove');
});

// spec: add-any-chain-feed › Pet address deposit flow › gift before settlement
test('a gift removes the former owner’s conversion control while the sender link stays public', async ({ page }) => {
  await openWith(page, path, { auth: signedIn, worker });
  await expect(page.getByRole('button', { name: 'Approve conversion' })).toBeVisible();
  await setWorker(page, { anyChainOwnerDeposit: { fail: { status: 403, code: 'not_owner' } } });
  await lookAgain(page);
  await expect(page.getByText("This deposit belongs to Pixel's current owner.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve conversion' })).toHaveCount(0);
  await expect(page.getByText('Waiting for owner').first()).toBeVisible();
});

// spec: add-any-chain-feed › Pet address deposit flow › sender obtains status link
// spec: add-any-chain-feed › Pet address data › sender status read
test('a signed-out sender gets only the four public outcomes and a settled remainder', async ({ page }) => {
  await openWith(page, path, { worker: { pets: { '9': PIXEL }, anyChainDepositStatus: publicStatus } });
  await expect(page.getByText('Waiting for owner').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in to see this deposit' })).toBeVisible();
  await setWorker(page, { anyChainDepositStatus: { ...publicStatus, state: 'converting' } });
  await lookAgain(page);
  await expect(page.getByText('Converting').first()).toBeVisible();
  await setWorker(page, { anyChainDepositStatus: { ...publicStatus, state: 'became_food',
    nearCredit: 'https://nearblocks.io/txns/credit', settledUnits: '200000', remainingUnits: '140000' } });
  await lookAgain(page);
  await expect(page.getByText('Became food').first()).toBeVisible();
  await expect(page.getByText('0.14 USDC')).toBeVisible();
  await setWorker(page, { anyChainDepositStatus: { ...publicStatus, state: 'refunded' } });
  await lookAgain(page);
  await expect(page.getByText('Refunded').first()).toBeVisible();
  expect(await calls(page)).not.toContain('worker:anyChainOwnerDeposit');
});

// spec: add-any-chain-feed › Pet address deposit flow › conversion refund
test('a conversion refund keeps the original deposit trace and adds no food', async ({ page }) => {
  await openWith(page, path, { auth: signedIn, worker });
  await expect(page.getByRole('button', { name: 'Approve conversion' })).toBeVisible();
  await setWorker(page, { anyChainDepositStatus: { ...publicStatus, state: 'refunded', refund: source },
    anyChainOwnerDeposit: { ...owner, deposit: { ...owner.deposit, state: 'refunded', source_refund_tx: source },
      sweep: { ...owner.sweep!, state: 'refunded', sourceTxHash: owner.deposit.source_tx_hash } } });
  await lookAgain(page);
  await expect(visibleLine(page, "Refunded to Pixel's Base address. Check the deposit before trying again.")).toBeVisible();
  await expect(page.locator(`a[href="${source}"]`).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'View NEAR credit' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve conversion' })).toHaveCount(0);
});

// spec: add-any-chain-feed › Pet address deposit flow › sweep sent
test('a confirmed source sweep keeps its source references while food is pending', async ({ page }) => {
  await openWith(page, path, { auth: signedIn, worker });
  await expect(page.getByRole('button', { name: 'Approve conversion' })).toBeVisible();
  const sweepHash = `0x${'a'.repeat(64)}`;
  await setWorker(page, { anyChainDepositStatus: { ...publicStatus, state: 'converting' },
    anyChainOwnerDeposit: { ...owner, deposit: { ...owner.deposit, state: 'converting' },
      sweep: { ...owner.sweep!, state: 'sent', sourceTxHash: sweepHash } } });
  await lookAgain(page);
  await expect(visibleLine(page, 'USDC sent for conversion. Still on its way.')).toBeVisible();
  await expect(page.locator(`a[href="${source}"]`).first()).toBeVisible();
  await expect(page.locator(`a[href="https://basescan.org/tx/${sweepHash}"]`)).toBeVisible();
  await expect(page.getByRole('link', { name: 'View NEAR credit' })).toHaveCount(0);
});

// spec: add-any-chain-feed › Pet address deposit flow › sweep failed
test('a failed source sweep keeps its trace and does not claim food', async ({ page }) => {
  await openWith(page, path, { auth: signedIn, worker });
  await expect(page.getByRole('button', { name: 'Approve conversion' })).toBeVisible();
  const sweepHash = `0x${'a'.repeat(64)}`;
  await setWorker(page, { anyChainDepositStatus: { ...publicStatus, state: 'waiting_for_owner' },
    anyChainOwnerDeposit: { ...owner, sweep: { ...owner.sweep!, state: 'failed', sourceTxHash: sweepHash } } });
  await lookAgain(page);
  await expect(visibleLine(page, "Conversion failed. USDC may still be at Pixel's address. Check the chain before trying again.")).toBeVisible();
  await expect(page.locator(`a[href="${source}"]`).first()).toBeVisible();
  await expect(page.locator(`a[href="https://basescan.org/tx/${sweepHash}"]`)).toBeVisible();
  await expect(page.getByRole('link', { name: 'View NEAR credit' })).toHaveCount(0);
});
