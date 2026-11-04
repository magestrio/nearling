import { expect, test } from '@playwright/test';
import { calls, openWith, setWorker } from './helpers';
import { RECEIPT_CODE, THINK_ID, TX_HASHES, receiptLinkFakes, verificationFakes } from './verification.fixtures';

const selected = `/pet/9/verify/${THINK_ID}`;

// spec: add-verification › Receipt link flow › eligible receipt
// spec: add-verification › Share receipt dialog screen › success
// spec: add-verification › Share receipt dialog screen › success × Cancel
// spec: add-verification › Share receipt dialog screen › success × Escape
test('eligible owner sees warning and Cancel closes without publication', async ({ page }) => {
  await openWith(page, selected, verificationFakes());
  await page.getByRole('button', { name: 'Share exact bytes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share exact bytes' });
  await expect(dialog.getByText(/Anyone with this link can download the exact request and reply/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share exact bytes' })).toBeFocused();
  await page.getByRole('button', { name: 'Share exact bytes' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect((await calls(page)).filter((name) => name.startsWith('worker:publishReceipt:'))).toHaveLength(0);
});

// spec: add-verification › Share receipt dialog screen › error
// spec: add-verification › Receipt link flow › publish
// spec: add-verification › Share receipt dialog screen › error × Try again
// spec: add-verification › Receipt link flow › publish × Copy link
// spec: add-verification › Receipt link flow › publish × Close
test('publish retry keeps its operation id and copies only this link', async ({ page }) => {
  const fakes = verificationFakes();
  fakes.worker!.publishReceipt = { fail: { status: 503, code: 'chain_unreachable' } };
  await openWith(page, selected, fakes);
  await page.getByRole('button', { name: 'Share exact bytes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share exact bytes' });
  await dialog.getByRole('button', { name: 'Publish receipt link' }).click();
  await expect(dialog.getByText("We couldn't publish this receipt link. Nothing was shared. Try again.")).toBeVisible();
  await setWorker(page, { publishReceipt: { code: RECEIPT_CODE, path: `/receipt/${RECEIPT_CODE}` } });
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByLabel('Receipt link')).toHaveValue(new RegExp(`/receipt/${RECEIPT_CODE}$`));
  const operations = (await calls(page)).filter((name) => name.startsWith('worker:publishReceipt:'));
  expect(operations).toHaveLength(2);
  expect(operations[0]).toBe(operations[1]);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
      (window as Window & { __copied?: string }).__copied = value;
    } } });
  });
  await dialog.getByRole('button', { name: 'Copy link' }).click();
  expect(await page.evaluate(() => (window as Window & { __copied?: string }).__copied)).toBe(`${new URL(page.url()).origin}/receipt/${RECEIPT_CODE}`);
  await expect(dialog.locator('.ds-toast')).toHaveText('Link copied — send it to a friend.');
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toHaveCount(0);
});

// spec: add-verification › Receipt link flow › publish × Copy link
test('failed copy announces the outcome and selects the read-only link', async ({ page }) => {
  await openWith(page, selected, verificationFakes());
  await page.getByRole('button', { name: 'Share exact bytes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share exact bytes' });
  await dialog.getByRole('button', { name: 'Publish receipt link' }).click();
  await expect(dialog.getByLabel('Receipt link')).toHaveValue(/\/receipt\//);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {
      throw new Error('denied');
    } } });
  });
  await dialog.getByRole('button', { name: 'Copy link' }).click();
  await expect(dialog.locator('.ds-toast')).toHaveText("Couldn't copy the link. Select it here to copy it.");
  await expect(dialog.getByLabel('Receipt link')).toBeFocused();
  expect(await dialog.getByLabel('Receipt link').evaluate((node) => (node as HTMLTextAreaElement).selectionStart)).toBe(0);
});

// spec: add-verification › Verification screen › signed-out
test('a 401 during publication ends the session and shows the public receipt', async ({ page }) => {
  const fakes = verificationFakes();
  fakes.worker!.publishReceipt = { fail: { status: 401, code: 'signed_out' } };
  await openWith(page, selected, fakes);
  await page.getByRole('button', { name: 'Share exact bytes' }).click();
  await page.getByRole('dialog', { name: 'Share exact bytes' }).getByRole('button', { name: 'Publish receipt link' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
  await expect(page.getByText('Only the owner of the pet that paid for this thought can see its words and check it in full.').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("We couldn't publish this receipt link. Nothing was shared. Try again.")).toHaveCount(0);
});

// spec: add-verification › Receipt link flow › ineligible receipt
test('erased and private-skill receipts have no publication control', async ({ page }) => {
  await openWith(page, selected, verificationFakes({ variant: 'memory-cleared' }));
  await expect(page.getByText("Exact bytes can't be shared for this receipt.").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share exact bytes' })).toHaveCount(0);
});

// spec: add-verification › Receipt link flow › visitor opens link
// spec: add-verification › Receipt link flow › multiple calls on one link
// spec: add-verification › Receipt link flow › independent check
// spec: add-verification › Receipt link flow › visitor opens link × Download request bytes
// spec: add-verification › Receipt link flow › visitor opens link × Download reply bytes
test('signed-out visitor sees one receipt and checks each downloaded call against NEAR', async ({ page }) => {
  await openWith(page, `/receipt/${RECEIPT_CODE}`, receiptLinkFakes());
  await expect(page.getByText("These bytes were shared by Pixel's owner. Compare their hashes with the receipt on NEAR.").filter({ visible: true })).toBeVisible();
  await expect(page.locator('.ds-receipt-row')).toHaveCount(0);
  await expect(page.getByText('Start with the chart, then. Say what surprised you about it — people follow a surprise better than a number.').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('Only the owner of the pet that paid for this thought can see its words and check it in full.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Download request bytes/ })).toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download request bytes.*Call 1/ }).click();
  expect((await download).suggestedFilename()).toBe('call-0-request.bin');
  const reply = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download reply bytes.*Call 1/ }).click();
  expect((await reply).suggestedFilename()).toBe('call-0-reply.bin');
  await expect(page.getByText('Request and reply match the receipt on NEAR').filter({ visible: true })).toBeVisible();
  const second = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download request bytes.*Call 2/ }).click();
  expect((await second).suggestedFilename()).toBe('call-1-request.bin');
  const secondReply = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download reply bytes.*Call 2/ }).click();
  expect((await secondReply).suggestedFilename()).toBe('call-1-reply.bin');
});

// spec: add-verification › Receipt link flow › independent check
test('a changed downloaded file gets a mismatch against the on-chain hash', async ({ page }) => {
  const fakes = receiptLinkFakes();
  const row = fakes.worker!.verificationThoughts![THINK_ID];
  if (!row || 'fail' in row) throw new Error('missing fixture thought');
  row.privateCalls![0]!.requestBase64 = btoa('changed request bytes');
  await openWith(page, `/receipt/${RECEIPT_CODE}`, fakes);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download request bytes.*Call 1/ }).click();
  await download;
  await expect(page.getByText("Request doesn't match the receipt on NEAR").filter({ visible: true })).toBeVisible();
});

// spec: add-verification › Receipt link flow › visitor opens link × Sign in
// spec: add-verification › Receipt link flow › visitor opens link × Back to pet
// spec: add-verification › Receipt link flow › visitor opens link × transaction link
// spec: add-verification › Receipt link flow › visitor opens link × hardware link
test('visitor navigation keeps the shared address and its public targets', async ({ page }) => {
  await openWith(page, `/receipt/${RECEIPT_CODE}`, receiptLinkFakes());
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toHaveAttribute('href', '/pet/9');
  await expect(page.getByRole('link', { name: `${TX_HASHES.receipt.slice(0, 4)}…${TX_HASHES.receipt.slice(-4)}` }).first())
    .toHaveAttribute('href', `https://testnet.nearblocks.io/txns/${TX_HASHES.receipt}`);
  await expect(page.getByRole('link', { name: 'Check the hardware on NEAR AI' }).first()).toHaveAttribute('href', /near/);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/receipt/${RECEIPT_CODE}$`));
});

// spec: add-verification › Receipt link flow › download error
// spec: add-verification › Receipt link flow › download error × Try again
test('a failed byte read leaves the link and retries only that file', async ({ page }) => {
  await openWith(page, `/receipt/${RECEIPT_CODE}`, receiptLinkFakes({ downloadError: true }));
  await page.getByRole('button', { name: /Download request bytes.*Call 1/ }).click();
  await expect(page.getByText("The bytes couldn't be downloaded just now. Try again.").filter({ visible: true })).toBeVisible();
  await setWorker(page, { receiptDownload: undefined });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Try again' }).click();
  expect((await download).suggestedFilename()).toBe('call-0-request.bin');
});

// spec: add-verification › Receipt link flow › link revoked
// spec: add-verification › Receipt link flow › link revoked × View public receipt
test('revoked link serves no bytes and opens its public receipt', async ({ page }) => {
  await openWith(page, `/receipt/${RECEIPT_CODE}`, receiptLinkFakes({ revoked: true }));
  await expect(page.getByRole('heading', { name: 'This receipt link no longer shares its words. The on-chain receipt is still public.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View public receipt' })).toHaveAttribute('href', selected);
  await expect(page.getByRole('button', { name: /Download/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'View public receipt' }).click();
  await expect(page).toHaveURL(new RegExp(`${selected}$`));
});

// spec: add-verification › Receipt link flow › unknown link
// spec: add-verification › Receipt link flow › unknown link × Go home
test('unknown link shows no receipt and returns home', async ({ page }) => {
  await openWith(page, `/receipt/${RECEIPT_CODE}`, receiptLinkFakes({ unknown: true }));
  await expect(page.getByRole('heading', { name: "This receipt link doesn't exist. Check the address and try again." })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  await page.getByRole('link', { name: 'Go home' }).click();
  // «/» sends a player with no pet on to the hatch screen
  await expect(page).toHaveURL(/\/(hatch)?$/);
});
