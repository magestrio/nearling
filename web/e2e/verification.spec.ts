import { expect, test } from '@playwright/test';
import { openWith, setWorker } from './helpers';
import { MISSING_ID, OLD_ID, THINK_ID, TX_HASHES, verificationFakes } from './verification.fixtures';
import { OWNER } from './helpers';
import { sampleDiary } from '../src/seams/diary.sample';
import type { FakeState } from '../src/seams/fakes';
import type { VerificationThought } from '../src/seams/worker-types';

const TOO_OLD = 'Too old to check here. This page can only read about a day back on NEAR — the explorer has the whole history.';

// spec: add-verification › Verification flow › watch check receipt
// spec: add-pet-errands › Daily watch flow › named content changed
test('a changed watch Diary entry links its receipt and opens Verification', async ({ page }) => {
  const proof = verificationFakes({ variant: 'errand' });
  await page.clock.install({ time: new Date('2026-10-31T12:00:00.000Z') });
  await openWith(page, '/pet/9/diary', { ...proof, worker: { ...proof.worker, ...OWNER,
    diary: { ...sampleDiary(), watch: [{ target: 'NEAR price', change: 'The named price changed.', sources: ['https://near.org'], priceYocto: '1700000000000000000000', receiptId: THINK_ID }] } } });
  const entry = page.getByText('Pixel checked NEAR price: The named price changed.');
  await expect(entry).toBeVisible();
  await page.getByRole('link', { name: 'Check this thought' }).last().click();
  await expect(page).toHaveURL(new RegExp(`/pet/9/verify/${THINK_ID}$`));
});

// spec: add-verification › Verification screen › loading
test('loading: the record is read from NEAR before a checked mark is drawn', async ({ page }) => {
  await openWith(page, '/pet/9/verify', verificationFakes({ loading: true }));
  await expect(page.getByText("Reading this pet's record on NEAR…")).toBeVisible();
  await expect(page.getByRole('img', { name: 'Seal of character' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toHaveAttribute('href', '/pet/9');
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
});

// spec: add-verification › Verification screen › error
test('error: a token absent on NEAR offers Home', async ({ page }) => {
  await openWith(page, '/pet/9/verify', verificationFakes({ missing: true }));
  await expect(page.getByRole('heading', { name: "We couldn't find this pet on NEAR. The link may be broken." })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  await page.getByRole('link', { name: 'Go home' }).click();
  // «/» sends a player with no pet on to the hatch screen
  await expect(page).toHaveURL(/\/(hatch)?$/);
});

// spec: add-verification › Verification screen › success
test('success: public record, newest-first receipts, exact transaction and source targets', async ({ page }) => {
  await openWith(page, '/pet/9/verify', verificationFakes());
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  const rows = page.locator('.ds-receipt-row');
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toHaveAttribute('href', `/pet/9/verify/${'0'.repeat(24)}`);
  await expect(rows.nth(1)).toHaveAttribute('href', `/pet/9/verify/${THINK_ID}`);
  await expect(page.getByText('Sealed at hatch. This character matches the fingerprint Pixel got on NEAR on Oct 26, 2026.')).toBeVisible();
  await expect(page.locator('.ds-record-item').filter({ hasText: 'Thinking cap' }).first())
    .toContainText('Wearing now · saved by the game, not on NEAR');
  const outfitNames = await page.locator('.ds-record-item').filter({ hasText: /Thinking cap|Daisy crown|Party hat/ })
    .allTextContents();
  expect(outfitNames.map((name) => name.match(/Thinking cap|Daisy crown|Party hat/)?.[0]))
    .toEqual(['Thinking cap', 'Daisy crown', 'Party hat']);
  await expect(page.getByRole('link', { name: `${TX_HASHES.birth.slice(0, 4)}…${TX_HASHES.birth.slice(-4)}` }))
    .toHaveAttribute('href', `https://testnet.nearblocks.io/txns/${TX_HASHES.birth}`);
  await expect(page.getByRole('link', { name: /github.com\/magestrio\/nearling/ })).toHaveAttribute('href', 'https://github.com/magestrio/nearling');
  await expect(page.getByRole('link', { name: "See every pet's receipts on the explorer" })).toHaveAttribute('href', 'https://testnet.nearblocks.io/address/nearling-e2e.testnet');
  await rows.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/pet/9/verify/${THINK_ID}$`));
});

// spec: add-verification › Verification screen › мысль не найдена
test('a missing thought keeps the public record and receipt rows', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${MISSING_ID}`, verificationFakes());
  await expect(page.getByText("We couldn't find that thought. Here's Pixel's record instead.")).toBeVisible();
  await expect(page.locator('.ds-receipt-row')).toHaveCount(10);
});

// spec: add-verification › Verification screen › empty
test('empty: a newborn has its record and no receipt rows', async ({ page }) => {
  await openWith(page, '/pet/9/verify', verificationFakes({ empty: true }));
  await expect(page.getByText("No thoughts yet. Each of Pixel's thoughts gets a receipt here.")).toBeVisible();
  await expect(page.locator('.ds-receipt-row')).toHaveCount(0);
  await expect(page.getByText('Became a teen — clever')).toHaveCount(0);
});

// spec: add-verification › Verification screen › чек слишком старый
test('old receipt has no marks and links its exact transaction on the explorer', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${OLD_ID}`, verificationFakes({ old: true }));
  await expect(page.getByText('Too old to check here. This page can only read about a day back on NEAR — the explorer has the whole history.').first()).toBeVisible();
  await expect(page.locator('.ds-receipt .ds-mark')).toHaveCount(0);
  await expect(page.locator('.ds-receipt').filter({ visible: true }).getByRole('link', { name: 'See it on the explorer' }))
    .toHaveAttribute('href', `https://testnet.nearblocks.io/txns/${TX_HASHES.old}`);
});

// spec: add-verification › Verification screen › чек слишком старый
test('an old record item keeps its explorer target and has no hatch-match line', async ({ page }) => {
  const fakes = verificationFakes({ old: true });
  fakes.rpc!.outcomes![TX_HASHES.birth] = { fail: 'UNKNOWN_TRANSACTION' };
  await openWith(page, '/pet/9/verify', fakes);
  await expect(page.getByText(TOO_OLD).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'See it on the explorer' }).first())
    .toHaveAttribute('href', `https://testnet.nearblocks.io/txns/${TX_HASHES.birth}`);
  await expect(page.getByText(/Sealed at hatch\. This character matches/)).toHaveCount(0);
});

// spec: add-verification › Seal of character rule › check unavailable
// spec: add-verification › Seal of character rule › check unavailable × Try again on Verification
test('an unreadable chain leaves no proof and Try again reads the current record', async ({ page }) => {
  const fakes = verificationFakes();
  const pet = fakes.rpc!.viewResults!.pet_view;
  fakes.rpc!.viewResults!.pet_view = { fail: 'rpc unavailable' };
  await openWith(page, '/pet/9/verify', fakes);
  await expect(page.getByText("We can't check Pixel's character on NEAR just now. Try again.").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole('img', { name: 'Seal of character' })).toHaveCount(0);
  await expect(page.locator('.ds-record')).toHaveCount(0);
  await page.evaluate((chainPet) => {
    const state = (globalThis as { __NEARLING_FAKES__?: FakeState }).__NEARLING_FAKES__!;
    state.rpc!.viewResults!.pet_view = chainPet;
  }, pet);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('img', { name: 'Seal of character' })).toBeVisible();
});

// spec: add-verification › Verification screen › signed-out
test('signed-out receipt is public and Sign in returns to this selected thought', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ signedOut: true }));
  await expect(page.getByText('Only the owner of the pet that paid for this thought can see its words and check it in full.').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('Character sealed at hatch').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(/Signed by key/).filter({ visible: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/pet/9/verify/${THINK_ID}$`));
  await expect(page.getByText('Start with the chart, then. Say what surprised you about it — people follow a surprise better than a number.').filter({ visible: true }).first()).toBeVisible();
});

// spec: add-verification › Verification screen › asleep
test('asleep keeps the record and sends Back to the sleeping Pet screen', async ({ page }) => {
  await openWith(page, '/pet/9/verify', verificationFakes({ asleep: true }));
  await expect(page.getByText('Pixel is asleep — its record on NEAR is all still here. A meal wakes it up.')).toBeVisible();
  await expect(page.locator('.ds-receipt-row')).toHaveCount(10);
  await expect(page.getByRole('link', { name: 'Back to Pixel' }).last()).toHaveAttribute('href', '/pet/9');
});

// spec: add-verification › Verification flow › открыл чек
test('an open receipt announces checking before its transaction outcome arrives', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'checking' }));
  await expect(page.getByText('Checking…').filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator('.ds-receipt').getByText(/Grown-up · clever, sociable · Thinking cap · calm · 7 of 10 · 12 memories/)
    .filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator('.ds-receipt .ds-mark')).toHaveCount(0);
});

// spec: add-verification › Verification flow › проверка сошлась
test('an owner checks all five marks against the selected receipt', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'checked' }));
  for (const line of ['Character sealed at hatch', "This receipt's request holds that character",
    'Request and reply match the receipt on NEAR', 'Token counts and cut-off match the signed reply', 'Signed by key']) {
    await expect(page.locator('.ds-receipt').getByText(line).filter({ visible: true }).first()).toBeVisible();
  }
  await expect(page.getByRole('link', { name: 'Check the hardware on NEAR AI' }).filter({ visible: true }).first()).toBeVisible();
});

// spec: add-verification › Verification flow › не владелец
test('a signed-in guest sees public marks without request or reply bytes', async ({ page }) => {
  const fakes = verificationFakes();
  fakes.worker!.owned = [];
  await openWith(page, `/pet/9/verify/${THINK_ID}`, fakes);
  await expect(page.getByText('Only the owner of the pet that paid for this thought can see its words and check it in full.').filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator('.ds-receipt .ds-mark').filter({ visible: true })).toHaveCount(2);
});

// spec: add-verification › Verification flow › подаренный питомец
test('a new current owner can check an older thought in full', async ({ page }) => {
  const fakes = verificationFakes();
  fakes.auth!.nearAccountId = 'b'.repeat(64);
  fakes.rpc!.viewResults!.pet_view = { ...fakes.rpc!.viewResults!.pet_view as Record<string, unknown>, owner_id: 'b'.repeat(64) };
  await openWith(page, `/pet/9/verify/${THINK_ID}`, fakes);
  await expect(page.locator('.ds-receipt').getByText('Request and reply match the receipt on NEAR').filter({ visible: true }).first()).toBeVisible();
});

// spec: add-verification › Verification flow › не владелец
// spec: add-verification › Verification flow › не владелец × pet gift
test('an open verification page removes private words after a gift from another device', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-04T12:00:00Z') });
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes());
  await expect(page.getByText('Start with the chart, then. Say what surprised you about it — people follow a surprise better than a number.').filter({ visible: true }).first()).toBeVisible();
  await page.evaluate(() => { (globalThis as { __NEARLING_FAKES__?: FakeState }).__NEARLING_FAKES__!.worker!.owned = []; });
  await page.clock.fastForward(30_000);
  await expect(page.getByText('Only the owner of the pet that paid for this thought can see its words and check it in full.').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('Start with the chart, then. Say what surprised you about it — people follow a surprise better than a number.')).toHaveCount(0);
});

// spec: add-verification › Verification screen › signed-out
test('an authenticated verification read that gets 401 opens the public signed-out state', async ({ page }) => {
  const fakes = verificationFakes();
  fakes.worker!.verificationUnauthorized = true;
  await openWith(page, `/pet/9/verify/${THINK_ID}`, fakes);
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
  await expect(page.getByText('Only the owner of the pet that paid for this thought can see its words and check it in full.').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(TOO_OLD)).toHaveCount(0);
});

// spec: add-verification › Verification flow › чек ещё не в сети
// spec: add-verification › Verification flow › чек ещё не в сети × 00:00 UTC
test('a pending receipt is reread at UTC midnight while the page stays open', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-04T23:59:50Z') });
  const fakes = verificationFakes({ variant: 'pending' });
  const settled = verificationFakes();
  await openWith(page, `/pet/9/verify/${THINK_ID}`, fakes);
  await expect(page.getByText(/Not on NEAR yet\. You can check Pixel/).filter({ visible: true }).first()).toBeVisible();
  await setWorker(page, { verificationThoughts: settled.worker!.verificationThoughts });
  await page.clock.fastForward(10_000);
  await expect(page.getByText('Request and reply match the receipt on NEAR').filter({ visible: true }).first()).toBeVisible();
});

// spec: add-verification › Verification screen › success
test('the decorative verification figure is still', async ({ page }) => {
  await openWith(page, '/pet/9/verify', verificationFakes());
  await expect(page.getByRole('heading', { name: 'Pixel' })).toBeVisible();
  await expect(page.locator('.pet-figure[data-still]').first()).toBeVisible();
});

// spec: add-verification › Verification flow › не сошлось
test('only the mismatching reply mark fails', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'mismatch' }));
  await expect(page.locator('.ds-receipt .ds-mark--fail').filter({ visible: true }).first()).toContainText("Reply doesn't match the receipt on NEAR");
  await expect(page.locator('.ds-receipt .ds-mark--fail').filter({ visible: true })).toHaveCount(1);
});

for (const [variant, line, route] of [
  ['request-mismatch', "Request doesn't match the receipt on NEAR", `/pet/9/verify/${THINK_ID}`],
  ['signature-mismatch', "Signature doesn't match the signed reply", `/pet/9/verify/${THINK_ID}`],
  ['price-mismatch', "Price doesn't match the receipt on NEAR", `/pet/9/verify/${THINK_ID}`],
  ['fee-mismatch', "Hire fee doesn't match the receipt on NEAR", `/pet/5/verify/${THINK_ID}`],
  ['skill-mismatch', "Skill mark doesn't match the receipt on NEAR", `/pet/5/verify/${THINK_ID}`],
] as const) {
  // spec: add-verification › Verification flow › не сошлось
  test(`the ${variant} mark names only its failed evidence`, async ({ page }) => {
    await openWith(page, route, verificationFakes({ variant }));
    await expect(page.locator('.ds-receipt .ds-mark--fail').filter({ visible: true }).first()).toContainText(line);
  });
}

// spec: add-verification › Verification flow › токены не сошлись
test('signed usage disagreement names the token mark', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'tokens-mismatch' }));
  await expect(page.locator('.ds-receipt .ds-mark--fail').filter({ visible: true }).first()).toContainText("This receipt's token counts don't match the signed reply.");
});

// spec: add-verification › Verification flow › поток
test('a gateway signer has the key caveat and no hardware link', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'stream' }));
  await expect(page.getByText("Signed by this key — this page doesn't say whose key it is.").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check the hardware on NEAR AI' })).toHaveCount(0);
});

// spec: add-verification › Verification flow › чек ещё не в сети
test('a pending thought exposes its kept words but no receipt marks', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'pending' }));
  await expect(page.locator('.ds-receipt .ds-mark')).toHaveCount(0);
  await expect(page.getByText(/Not on NEAR yet\. You can check Pixel/).filter({ visible: true }).first()).toBeVisible();
});

// spec: add-verification › Verification flow › чек ещё не в сети, память стёрта
test('a pending thought whose words were cleared says so and has no word marks', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'pending-cleared' }));
  await expect(page.locator('.ds-receipt .ds-mark')).toHaveCount(0);
  await expect(page.getByText("This receipt is still being recorded on NEAR, and these words were cleared. You can check Pixel's pet record now; after the receipt lands, only its public hashes and signature can be checked.").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("Exact bytes can't be shared for this receipt.").filter({ visible: true }).first()).toBeVisible();
});

// spec: add-verification › Verification flow › заплатил проект
test('a project-paid thought has no receipt marks', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'project-paid' }));
  await expect(page.locator('.ds-receipt .ds-mark')).toHaveCount(0);
  await expect(page.getByText(/Paid by the game · no receipt\. You can check Pixel/).filter({ visible: true }).first()).toBeVisible();
});

// spec: add-verification › Verification flow › память стёрта
test('erased words leave only public character and signature marks', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'memory-cleared' }));
  await expect(page.getByText(/These words were cleared\. You can still check the public receipt/).filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator('.ds-receipt .ds-mark').filter({ visible: true })).toHaveCount(2);
});

// spec: add-verification › Verification flow › два вызова
test('two calls share one price and carry their own proof marks', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'two-calls' }));
  await expect(page.getByText(/Both calls ·/).filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator('.ds-receipt-call').filter({ visible: true })).toHaveCount(2);
  await expect(page.getByText('Thinking — ran out of room').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('Quick re-ask').filter({ visible: true }).first()).toBeVisible();
});

// spec: add-verification › Verification flow › ответ работника
test('a worker answer shows the adjacent hire fee and returns to the worker', async ({ page }) => {
  await openWith(page, `/pet/5/verify/${THINK_ID}`, verificationFakes({ variant: 'worker' }));
  await expect(page.getByText('Nori answered for Pixel · fee 0.38¢ · answer 0.08¢').filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator('.ds-receipt-row[aria-current="page"] .ds-receipt-row__price')).toHaveText('0.08¢');
  await expect(page.getByRole('link', { name: 'Back to Nori' })).toHaveAttribute('href', '/pet/5');
});

// spec: add-verification › Verification flow › вопрос найма
test('the hiring question belongs to the paying pet and names the worker', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'hire-question' }));
  await expect(page.getByText("Pixel's question for Nori · 0.08¢").filter({ visible: true }).first()).toBeVisible();
});

// spec: add-verification › Verification flow › пустой ответ
test('a paid empty answer keeps its receipt and explains the missing reply', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'empty-reply' }));
  await expect(page.getByText('No reply to show from this call. It was still paid for, so it has a receipt.').filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator('.ds-receipt .ds-mark').filter({ visible: true }).first()).toBeVisible();
});

// spec: add-verification › Verification flow › skilled answer
test('a payer checks a skilled reply without seeing its private request', async ({ page }) => {
  await openWith(page, `/pet/5/verify/${THINK_ID}`, verificationFakes({ variant: 'skilled' }));
  const receipt = page.locator('.ds-receipt').filter({ visible: true }).first();
  await expect(receipt.getByText('Reply matches the receipt on NEAR')).toBeVisible();
  await expect(receipt.getByText('Token counts and cut-off match the signed reply')).toBeVisible();
  await expect(receipt.getByText('A private skill shaped this answer, so its full request stays hidden — even from you.')).toBeVisible();
  await expect(receipt.getByText('The signature and the receipt here are real.')).toBeVisible();
  await expect(receipt.getByText('How do you make a room care about a chart in one sentence?')).toHaveCount(0);
});

// spec: add-verification › Verification flow › skilled answer, another viewer
test('another viewer sees a skilled receipt without its words', async ({ page }) => {
  const fakes = verificationFakes({ variant: 'skilled-public' });
  const signer = (fakes.worker!.verificationThoughts![THINK_ID] as VerificationThought).calls[0]!.signer;
  await openWith(page, `/pet/5/verify/${THINK_ID}`, fakes);
  const receipt = page.locator('.ds-receipt').filter({ visible: true }).first();
  await expect(receipt.getByText('Only the owner of the pet that paid for this thought can see its words. A private skill shaped it, so nobody can check its request in full.')).toBeVisible();
  await expect(receipt.getByText('Lead with the one number')).toHaveCount(0);
  await expect(receipt.getByText('Reply matches the receipt on NEAR')).toHaveCount(0);
  await expect(receipt.locator(`[title="${signer}"]`)).toHaveText(`${signer.slice(0, 4)}…${signer.slice(-4)}`);
});

// spec: add-verification › Verification flow › errand report
test('an errand names its form, searches, calls and report-only character mark', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'errand' }));
  const receipt = page.locator('.ds-receipt').filter({ visible: true }).first();
  await expect(receipt.getByText(/Find out · 2 searches · saved by the game/)).toBeVisible();
  await expect(receipt.getByText('Web search', { exact: true })).toHaveCount(2);
  await expect(receipt.getByText('Report', { exact: true })).toBeVisible();
  await expect(receipt.locator('.ds-receipt-call').last().getByText("This receipt's request holds that character")).toBeVisible();
  await expect(receipt.locator('.ds-receipt-call').first().getByText("This receipt's request holds that character")).toHaveCount(0);
  await expect(receipt.getByText('Find out: When does the next NEAR protocol upgrade ship?')).toBeVisible();
});

// spec: add-verification › Verification flow › errand report with a cut search
test('a game-stopped search has hashes and no signature or tokens', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'errand-cut' }));
  const receipt = page.locator('.ds-receipt').filter({ visible: true }).first();
  const stopped = receipt.locator('.ds-receipt-call').nth(1);
  await expect(stopped.getByText('Stopped by the game')).toBeVisible();
  await expect(stopped.getByText(/tokens in/)).toHaveCount(0);
  await expect(stopped.getByText(/Signed by key/)).toHaveCount(0);
  await expect(stopped.locator('.ds-mono')).toHaveCount(2);
  await expect(receipt.getByText("The game stopped this call when Pixel began a search it hadn't paid for. A stopped call has no signature or token counts.")).toBeVisible();
});

// spec: add-verification › Verification flow › errand with no search twice
test('two searches without a report have one paid receipt and no report mark', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'errand-none' }));
  const receipt = page.locator('.ds-receipt').filter({ visible: true }).first();
  await expect(receipt.getByText("Neither call ran a search, so there's no report to show. Both were still paid for, so they have a receipt.")).toBeVisible();
  await expect(receipt.getByText(/Both calls ·/)).toBeVisible();
  await expect(receipt.getByText("This receipt's request holds that character")).toHaveCount(0);
});

// spec: add-verification › Verification flow › errand report with a skill
test('a skilled errand checks reply only and has no worker header', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes({ variant: 'errand-skill' }));
  const receipt = page.locator('.ds-receipt').filter({ visible: true }).first();
  await expect(receipt.getByText("Pixel's skill shaped this report, so its full request isn't kept — this page checks the reply and its token counts.")).toBeVisible();
  await expect(receipt.getByText('Reply matches the receipt on NEAR').first()).toBeVisible();
  await expect(receipt.getByText('Back to Nori')).toHaveCount(0);
  await expect(receipt.getByText(/fee /)).toHaveCount(0);
  await expect(receipt.getByText('Find out: When does the next NEAR protocol upgrade ship?')).toHaveCount(0);
});

// spec: add-verification › Verification flow › не владелец
test('an errand visitor sees form, count and call labels but no job', async ({ page }) => {
  const fakes = verificationFakes({ variant: 'errand' });
  fakes.worker!.owned = [];
  await openWith(page, `/pet/9/verify/${THINK_ID}`, fakes);
  const receipt = page.locator('.ds-receipt').filter({ visible: true }).first();
  await expect(receipt.getByText(/Find out · 2 searches · saved by the game/)).toBeVisible();
  await expect(receipt.getByText('Report', { exact: true })).toBeVisible();
  await expect(receipt.getByText('Find out: When does the next NEAR protocol upgrade ship?')).toHaveCount(0);
});

// spec: add-verification › Verification flow › аппаратная проверка
test('hardware link opens the NEAR AI page without passing thought words', async ({ page }) => {
  await openWith(page, `/pet/9/verify/${THINK_ID}`, verificationFakes());
  const link = page.getByRole('link', { name: 'Check the hardware on NEAR AI' }).filter({ visible: true }).first();
  await expect(link).toHaveAttribute('target', '_blank');
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^https:\/\/cloud\.near\.ai\/verify\?model=/);
  expect(href).not.toContain('chart%20nobody');
  await expect(page.getByText("This page checks the signature, not whose key it is. NEAR AI's page checks the key against the model's secure hardware — but only keys in use right now.").filter({ visible: true }).first()).toBeVisible();
});
