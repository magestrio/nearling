import { expect, test } from '@playwright/test';
import { calls, inCard, openCard, openWith, PIXEL, setWorker, SIGNED_IN } from './helpers';
import type { WorkRecord } from '../src/seams/worker-types';

const DATE = Date.UTC(2026, 10, 7) * 1_000_000;
const RECEIPT = 'a'.repeat(24);
const RECORD: WorkRecord = { tokenId: '9', counts: { paidHires: 3, completedErrands: 5, countedSince: DATE },
  field: { wording: 'Worked on comparing train fares', sourceReportId: RECEIPT },
  receipts: [{ thoughtId: RECEIPT, tokenId: '9', debitTxHash: 'receipt-tx', kind: 'errand_find', at: Date.parse('2026-11-11T12:00:00Z') }] };
const worker = (record: WorkRecord | { fail: { status: number; code: string } } = RECORD) => ({ pets: { '9': PIXEL }, workRecord: record });

// spec: add-pet-experience › Work record screen › success
test('a direct public record compares its count with NEAR and links the receipt and Pet page', async ({ page }) => {
  await openWith(page, '/pet/9/work', { worker: worker() });
  await expect(page.getByText('Worked on comparing train fares')).toBeVisible();
  await expect(page.getByText('Paid hires:', { exact: true })).toBeVisible();
  await expect(page.getByText('3', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check receipt' })).toHaveAttribute('href', `/pet/9/verify/${RECEIPT}`);
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL('/pet/9');
  await openCard(page);
  await expect(inCard(page).getByRole('link', { name: 'View work record' })).toHaveAttribute('href', '/pet/9/work');
});

// spec: add-pet-experience › Experience events data › public record opened
test('opening a checked Work record sends the opaque event once', async ({ page }) => {
  await openWith(page, '/pet/9/work', { worker: worker() });
  await expect(page.getByText('Worked on comparing train fares')).toBeVisible();
  await expect.poll(async () => (await calls(page)).filter((name) => name.startsWith('worker:experienceRecordOpened:')).length).toBe(1);
  expect((await calls(page)).filter((name) => name.startsWith('worker:experienceRecordOpened:'))).toEqual([
    'worker:experienceRecordOpened:petId,playerId,tabId',
  ]);
});

// spec: add-pet-experience › Work record screen › empty
test('zero counted work keeps the upgrade date and no asserted receipt', async ({ page }) => {
  await openWith(page, '/pet/9/work', { worker: worker({ ...RECORD, counts: { ...RECORD.counts, paidHires: 0, completedErrands: 0 }, field: null, receipts: [] }) });
  await expect(page.getByText('No counted work yet. Earlier receipts may still exist.')).toBeVisible();
  await expect(page.getByText('Counted since Nov 7, 2026')).toBeVisible();
});

// spec: add-pet-experience › Work record screen › loading
test('a pending public read says what is being checked', async ({ page }) => {
  await openWith(page, '/pet/9/work', { worker: { ...worker(), workRecordDelayMs: 3_600_000 } });
  await expect(page.getByText("Checking Pixel's work record…").first()).toBeVisible();
});

// spec: add-pet-experience › Work record screen › error
test('an unreadable or mismatched chain view never asserts a count, and retry can recover', async ({ page }) => {
  await openWith(page, '/pet/9/work', { worker: worker(), rpc: { viewResults: { experience_view: { fail: 'RPC unavailable' } } } });
  await expect(page.getByText("Work record couldn't be checked. Try again.").first()).toBeVisible();
  await expect(page.getByText('Paid hires:')).toHaveCount(0);
  await page.evaluate(() => { const g = globalThis as { __NEARLING_FAKES__?: { rpc?: { viewResults?: Record<string, unknown> } } }; if (g.__NEARLING_FAKES__?.rpc) g.__NEARLING_FAKES__.rpc.viewResults = {}; });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Worked on comparing train fares')).toBeVisible();
});

// spec: add-pet-experience › Work record screen › unknown pet
test('a missing direct work URL reaches the existing Pet not-found screen', async ({ page }) => {
  await openWith(page, '/pet/99/work', { worker: { pets: {} } });
  await expect(page.getByRole('heading', { name: /We couldn't find this pet/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
});

// spec: add-pet-experience › Work record screen › signed-out
test('a visitor reads the same public data and Ask leads to Pet without a private session', async ({ page }) => {
  await openWith(page, '/pet/9/work', { worker: worker() });
  await expect(page.getByText('Worked on comparing train fares')).toBeVisible();
  await page.getByRole('link', { name: 'Ask Pixel' }).click();
  await expect(page).toHaveURL('/pet/9');
  expect(await calls(page)).not.toContain('worker:experience');
});

// spec: add-pet-experience › Work record screen › asleep
test('the record remains readable while asleep and Feed opens the existing sheet', async ({ page }) => {
  await openWith(page, '/pet/9/work', { auth: SIGNED_IN, worker: { ...worker(), pets: { '9': { ...PIXEL, fullness: { state: 'asleep', level: 0 } } } } });
  await expect(page.getByText('Pixel is asleep. Feed Pixel to wake them.').first()).toBeVisible();
  await expect(page.getByText('Worked on comparing train fares')).toBeVisible();
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

// spec: add-pet-experience › Work record screen › success × tab visible again
test('returning to the tab refetches a changed public record', async ({ page }) => {
  await openWith(page, '/pet/9/work', { worker: worker() });
  await expect(page.getByText('Worked on comparing train fares')).toBeVisible();
  await setWorker(page, { workRecord: { ...RECORD, field: null } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('Worked on comparing train fares')).toHaveCount(0);
});

// spec: add-pet-experience › Work record screen › success × ownership change
test('clearing memory refreshes the record in the open page', async ({ page }) => {
  await openWith(page, '/pet/9/work', { auth: SIGNED_IN, worker: { ...worker(), owned: ['9'] } });
  await expect(page.getByText('Worked on comparing train fares')).toBeVisible();
  await setWorker(page, { workRecord: { ...RECORD, field: null, counts: { ...RECORD.counts, completedErrands: 6 } } });
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear memory' }).click();
  await expect(page.getByText('Worked on comparing train fares')).toHaveCount(0);
  await expect(page.getByText('6', { exact: true })).toBeVisible();
});

// spec: add-pet-experience › Work record screen › success × accepted work while open
test('accepted work updates the open record without a tab switch', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-11T12:00:00Z') });
  await openWith(page, '/pet/9/work', { worker: worker() });
  await expect(page.getByText('5', { exact: true })).toBeVisible();
  await setWorker(page, { workRecord: { ...RECORD, counts: { ...RECORD.counts, completedErrands: 6 } } });
  await page.clock.runFor(10_000);
  await expect(page.getByText('6', { exact: true })).toBeVisible();
});

// spec: add-pet-experience › Work record screen › success × accepted hire / completed errand / 00:00 UTC
test('a slow record refresh is not displaced by the next timed refresh', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-11T12:00:00Z') });
  await openWith(page, '/pet/9/work', { worker: worker() });
  await expect(page.getByText('5', { exact: true })).toBeVisible();
  await setWorker(page, { workRecord: { ...RECORD, counts: { ...RECORD.counts, completedErrands: 6 } }, workRecordDelayMs: 12_000 });
  const readsBeforeRefresh = (await calls(page)).filter((name) => name === 'worker:workRecord').length;
  await page.clock.runFor(10_000);
  expect((await calls(page)).filter((name) => name === 'worker:workRecord')).toHaveLength(readsBeforeRefresh + 1);
  await page.clock.runFor(10_000);
  expect((await calls(page)).filter((name) => name === 'worker:workRecord')).toHaveLength(readsBeforeRefresh + 1);
  await page.clock.runFor(2_000);
  await expect(page.getByText('6', { exact: true })).toBeVisible();
});
