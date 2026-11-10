import { expect, test, type Locator, type Page } from '@playwright/test';

// the DS keeps a visually hidden live region that repeats a line; a check of what is drawn skips it
const drawn = (scope: Page | Locator, text: string | RegExp) => scope.getByText(text).and(scope.locator(':not(.ds-hidden)'));
import { calls, lookAgain, openMore, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';
import { THINK_ID, verificationFakes } from './verification.fixtures';
import type { FakeWorkerState } from '../src/seams/fakes';
import type { VerificationThought } from '../src/seams/worker-types';

test.use({ timezoneId: 'Etc/GMT-2' });
/** The Watch entry stands in the «More» menu (add-game-layout › Pet actions menu screen); the menu may still be open. */
const tapWatch = async (page: Page, name: 'Watch something' | 'Edit watch') => {
  if (!(await page.getByRole('menu', { name: 'More' }).isVisible())) await openMore(page);
  await page.getByRole('menuitem', { name }).click();
};
const saved = { target: 'NEAR price', kind: 'topic' as const, savedHourUtc: 0, paused: false,
  nextCheck: '2026-11-12T00:00:00.000Z', latestResult: 'unchanged' as const,
  latestPriceYocto: '1700000000000000000000', latestReceiptId: THINK_ID,
  upTo: { cents: 1.1, yocto: '2200000000000000000000' } };
const pointer = { ...(verificationFakes({ variant: 'errand' }).worker!.verificationThoughts![THINK_ID] as VerificationThought), nearUsdRate: '5' };
const open = async (page: Page, watch: FakeWorkerState['watch'] = saved, time = '2026-11-11T12:00:00.000Z') => {
  await page.clock.install({ time: new Date(time) });
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, verificationThoughts: { [THINK_ID]: pointer },
    pets: { ...OWNER.pets, '9': { ...PIXEL, watch: saved.target ? { target: saved.target, kind: saved.kind } : null } }, watch } });
  await tapWatch(page, 'Edit watch');
  return page.getByRole('dialog', { name: 'Watch something' });
};

// spec: add-pet-errands › Watch sheet screen › success
// spec: add-pet-errands › Daily watch flow › unchanged check
test('active target shows local check time, quiet result, exact charge and receipt', async ({ page }) => {
  const sheet = await open(page);
  await expect(sheet.getByLabel('What should Pixel watch?')).toHaveValue('NEAR price');
  await expect(drawn(sheet, 'Checks daily at 02:00')).toBeVisible();
  await expect(drawn(sheet, 'Next check: Nov 12, 2026')).toBeVisible();
  await expect(drawn(sheet, 'No change to NEAR price · 0.85¢')).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', `/pet/9/verify/${THINK_ID}`);
  expect(await calls(page)).toContain('worker:watch');
});

// spec: add-pet-errands › Watch sheet screen › empty target
// spec: add-pet-errands › Watch sheet screen › target too long
test('blank and long targets keep the field and never reach the Worker', async ({ page }) => {
  const sheet = await open(page, { ...saved, target: null, latestResult: null, latestReceiptId: null });
  const field = sheet.getByLabel('What should Pixel watch?');
  await field.fill('   ');
  await sheet.getByRole('button', { name: 'Save watch' }).click();
  await expect(drawn(sheet, 'Name a topic, release, account or page to watch.')).toBeVisible();
  const long = 'NEAR price '.repeat(46) + 'NEAR price';
  await field.fill(long);
  await sheet.getByRole('button', { name: 'Save watch' }).click();
  await expect(field).toHaveValue(long);
  await expect(drawn(sheet, 'Keep the watch target under 500 characters.')).toBeVisible();
  expect((await calls(page)).filter((name) => name === 'worker:saveWatch')).toHaveLength(0);
});

// spec: add-pet-errands › Daily watch flow › target saved
test('saving replaces the target and re-reads the public Pet screen without starting a check', async ({ page }) => {
  const sheet = await open(page, { ...saved, target: null, latestResult: null, latestReceiptId: null });
  await sheet.getByLabel('What should Pixel watch?').fill('Rust compiler releases');
  await sheet.getByRole('button', { name: 'Save watch' }).click();
  await expect(drawn(sheet, /Checks daily at/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  // the page draws the line in both layouts (the phone intro card is hidden at this width), so only the shown one counts
  await expect(drawn(page, 'Watching: Rust compiler releases').filter({ visible: true })).toHaveCount(1);
  expect((await calls(page)).filter((name) => name === 'worker:saveWatch')).toHaveLength(1);
  expect((await calls(page)).some((name) => name.includes('watchCheck'))).toBe(false);
});

// spec: add-pet-errands › Watch sheet screen › error
test('failed read keeps the typed target and Try again reads the current watch', async ({ page }) => {
  const sheet = await open(page, { fail: { status: 503, code: 'chain_unreachable' } });
  await sheet.getByLabel('What should Pixel watch?').fill('NEAR price');
  await expect(drawn(sheet, "We couldn't load Pixel's watch right now. Try again.")).toBeVisible();
  await setWorker(page, { watch: saved });
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await expect(sheet.getByLabel('What should Pixel watch?')).toHaveValue('NEAR price');
  await expect(sheet.getByRole('link', { name: 'Check this thought' })).toBeVisible();
});

// spec: add-pet-errands › Daily watch flow › new owner sees a paused watch
// spec: add-pet-errands › Daily watch flow › new owner resumes a watch
test('new owner sees the price before Resume and may stop the target', async ({ page }) => {
  const sheet = await open(page, { ...saved, paused: true, nextCheck: null });
  await expect(drawn(sheet, 'Watch paused after the gift')).toBeVisible();
  await expect(drawn(sheet, 'About 0.85¢ per completed check; up to about 1.1¢ with a second try')).toBeVisible();
  await sheet.getByRole('button', { name: 'Resume watch' }).click();
  await expect(drawn(sheet, 'Checks daily at 02:00')).toBeVisible();
  await sheet.getByRole('button', { name: 'Stop watch' }).click();
  await expect(sheet.getByLabel('What should Pixel watch?')).toHaveValue('');
});

// spec: add-pet-errands › Watch sheet screen › success × Stop watch during a stale read
test('a read started before Stop cannot restore the removed target', async ({ page }) => {
  const sheet = await open(page);
  await setWorker(page, { watchDelayMs: 1000 });
  await lookAgain(page);
  await sheet.getByRole('button', { name: 'Stop watch' }).click();
  await page.clock.fastForward(1000);
  await expect(sheet.getByLabel('What should Pixel watch?')).toHaveValue('');
  await expect(sheet.getByRole('button', { name: 'Save watch' })).toBeVisible();
});

// spec: add-pet-errands › Watch target data › previous owner changes a watch
test('gift during an open sheet refuses the old owner and returns to the public pet', async ({ page }) => {
  const sheet = await open(page);
  // Freeze the periodic owner reads: on a loaded machine one fired between the fake's change and the click, closed the sheet by
  // itself and left the click waiting for a button that was gone. The refused «Stop watch» is this test's ownership event.
  await page.clock.pauseAt(new Date('2026-11-11T12:05:00.000Z'));
  await setWorker(page, { owned: [] });
  await sheet.getByRole('button', { name: 'Stop watch' }).click();
  await expect(sheet).toHaveCount(0);
  expect((await calls(page)).filter((name) => name === 'worker:stopWatch')).toHaveLength(0);
});

// spec: add-pet-errands › Daily watch flow › first check
// spec: add-verification › Verification flow › watch check receipt
test('first and quiet receipts open their exact Verification route', async ({ page }) => {
  const fakes = verificationFakes({ variant: 'errand' });
  await page.clock.install({ time: new Date('2026-11-11T12:00:00.000Z') });
  await openWith(page, '/pet/9', { ...fakes, worker: { ...fakes.worker, ...OWNER, verificationThoughts: { [THINK_ID]: pointer }, watch: { ...saved, latestResult: 'first' } } });
  await tapWatch(page, 'Watch something');
  const sheet = page.getByRole('dialog', { name: 'Watch something' });
  await expect(drawn(sheet, 'First check saved as a starting point · 0.85¢')).toBeVisible();
  await sheet.getByRole('link', { name: 'Check this thought' }).click();
  await expect(page).toHaveURL(new RegExp(`/pet/9/verify/${THINK_ID}$`));
});

// spec: add-pet-errands › Watch sheet screen › success × reload and hidden tab return
test('reload reads the saved target; returning to a visible tab reads the latest quiet check', async ({ page }) => {
  const sheet = await open(page);
  await sheet.getByLabel('What should Pixel watch?').fill('unsaved words');
  await page.reload();
  await tapWatch(page, 'Edit watch');
  await expect(page.getByRole('dialog', { name: 'Watch something' }).getByLabel('What should Pixel watch?')).toHaveValue('NEAR price');
  await setWorker(page, { watch: { ...saved, latestResult: 'first' } });
  await lookAgain(page);
  await expect(drawn(page, 'First check saved as a starting point · 0.85¢')).toBeVisible();
});

// spec: add-pet-errands › Watch sheet screen › success × close and reopen
test('closing an invalid edit discards the draft and field error', async ({ page }) => {
  const sheet = await open(page);
  await sheet.getByLabel('What should Pixel watch?').fill(' ');
  await sheet.getByRole('button', { name: 'Save watch' }).click();
  await expect(drawn(sheet, 'Name a topic, release, account or page to watch.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await tapWatch(page, 'Edit watch');
  const reopened = page.getByRole('dialog', { name: 'Watch something' });
  await expect(reopened.getByLabel('What should Pixel watch?')).toHaveValue('NEAR price');
  await expect(drawn(reopened, 'Name a topic, release, account or page to watch.')).toHaveCount(0);
});

// spec: add-pet-errands › Daily watch flow › first check
// spec: add-pet-errands › Daily watch flow › sleeping pause
test('an open Watch sheet announces a new check and a later pause once each', async ({ page }) => {
  const sheet = await open(page);
  const status = sheet.locator('.ds-hidden[role="status"]');
  await setWorker(page, { watch: { ...saved, latestResult: 'first' } });
  await lookAgain(page);
  await expect(status).toContainText('First check saved as a starting point');
  await setWorker(page, { watch: { ...saved, latestResult: 'first', pause: 'sleeping' } });
  await lookAgain(page);
  await expect(status).toContainText("Pixel is asleep, so today's watch is paused.");
});

// spec: add-pet-errands › Watch sheet screen › success × the session ends and sign-in returns
test('expired session keeps the typed target through Google return without saving it', async ({ page }) => {
  const sheet = await open(page);
  await sheet.getByLabel('What should Pixel watch?').fill('Rust compiler releases');
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await expect(drawn(sheet, "You've been signed out. Sign in to pick up where you left off.")).toBeVisible();
  await setWorker(page, { sessionExpired: false });
  await sheet.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByRole('dialog', { name: 'Watch something' }).getByLabel('What should Pixel watch?')).toHaveValue('Rust compiler releases');
  expect((await calls(page)).filter((name) => name === 'worker:saveWatch')).toHaveLength(0);
});

// spec: add-pet-errands › Watch sheet screen › success × UTC rollover
test('the open sheet asks for the next UTC day after midnight', async ({ page }) => {
  const sheet = await open(page, saved, '2026-11-11T23:59:30.000Z');
  await expect(drawn(sheet, 'Next check: Nov 12, 2026')).toBeVisible();
  await setWorker(page, { watch: { ...saved, nextCheck: '2026-11-13T00:00:00.000Z' } });
  await page.clock.fastForward(60_000);
  await expect(drawn(sheet, 'Next check: Nov 13, 2026')).toBeVisible();
});

// spec: add-pet-errands › Watch sheet screen › success × sign-out
test('sign-out drops the open Watch sheet and its unsaved target', async ({ page }) => {
  const sheet = await open(page);
  await sheet.getByLabel('What should Pixel watch?').fill('unsaved words');
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).press('Enter');
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});

// spec: add-pet-errands › Daily watch flow › sleeping pause
test('a sleeping pet at the scheduled check: the line, no charge, and Feed opens Feed sheet and returns to the Watch sheet', async ({ page }) => {
  const sheet = await open(page, { ...saved, latestResult: null, latestReceiptId: null, latestPriceYocto: null, pause: 'sleeping' });
  await expect(drawn(sheet, "Pixel is asleep, so today's watch is paused. Feed Pixel to make a later daily check possible.")).toBeVisible();
  await expect(drawn(sheet, /^No change to|^First check/)).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Feed Pixel' }).click();
  const feed = page.getByRole('dialog', { name: 'Feed Pixel' });
  await expect(feed).toBeVisible();
  await feed.getByRole('button', { name: 'Close' }).click();
  await expect(feed).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('What should Pixel watch?')).toHaveValue('NEAR price');
});

// spec: add-pet-errands › Daily watch flow › food pause
// spec: add-pet-errands › Daily watch flow › energy pause
// spec: add-pet-errands › Daily watch flow › cap pause
// spec: add-pet-errands › Daily watch flow › services pause
test('the other blocked days say their own line, and only a hungry pet offers Feed', async ({ page }) => {
  const sheet = await open(page, { ...saved, latestResult: null, latestReceiptId: null, latestPriceYocto: null, pause: 'food' });
  await expect(drawn(sheet, "Today's watch is paused until Pixel has enough food.")).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  for (const [pause, line] of [
    ['energy', 'Pixel is resting until 02:00. Today\'s watch is skipped.'],
    ['cap', "Today's watch is paused at Pixel's spending limit. Another check can run after 00:00 UTC."],
    ['services', "Today's watch is paused while thoughts are unavailable."],
  ] as const) {
    await setWorker(page, { watch: { ...saved, latestResult: null, pause } });
    await lookAgain(page);
    await expect(drawn(sheet, line)).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Feed Pixel' })).toHaveCount(0);
  }
});

// spec: add-pet-errands › Daily watch flow › target replaced
test('a different target starts a new comparison; the same one again says nothing', async ({ page }) => {
  const sheet = await open(page);
  await sheet.getByLabel('What should Pixel watch?').fill('Rust compiler releases');
  await sheet.getByRole('button', { name: 'Save watch' }).click();
  await expect(drawn(sheet, 'Now watching Rust compiler releases. The next eligible check starts a new comparison.')).toBeVisible();
  await expect(drawn(sheet, /Today's check was used/)).toHaveCount(0);
  await sheet.getByLabel('What should Pixel watch?').fill('Rust compiler releases ');
  await expect(drawn(sheet, /^Now watching/)).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Save watch' }).click();
  await expect(drawn(sheet, /^Now watching/)).toHaveCount(0);
});

// spec: add-pet-errands › Daily watch flow › target replaced after failed check
test('replacing the target after today\'s started check failed says the day was used', async ({ page }) => {
  // the sheet opens at 2026-11-11T12:00Z: UTC day 20_403
  const sheet = await open(page, { ...saved, lastStartedDay: Math.floor(Date.UTC(2026, 10, 11) / 86_400_000), latestResult: 'failed', latestReceiptId: null, latestPriceYocto: null });
  await sheet.getByLabel('What should Pixel watch?').fill('Rust compiler releases');
  await sheet.getByRole('button', { name: 'Save watch' }).click();
  await expect(drawn(sheet, "Now watching Rust compiler releases. Today's check was used; the new target starts after 00:00 UTC.")).toBeVisible();
  await expect(drawn(sheet, /The next eligible check starts a new comparison/)).toHaveCount(0);
  // the failed check is not replayed: no check call leaves the sheet
  expect((await calls(page)).some((name) => name.includes('watchCheck'))).toBe(false);
});

// spec: add-pet-errands › Daily watch flow › watch stopped
test('Stop watch says the past stays with the pet and leaves the field empty', async ({ page }) => {
  const sheet = await open(page);
  await sheet.getByRole('button', { name: 'Stop watch' }).click();
  await expect(drawn(sheet, 'Watch stopped. Past diary entries and receipts stay with Pixel.')).toBeVisible();
  await expect(sheet.getByLabel('What should Pixel watch?')).toHaveValue('');
  await expect(sheet.getByRole('button', { name: 'Stop watch' })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Save watch' })).toBeVisible();
  expect((await calls(page)).filter((name) => name === 'worker:stopWatch')).toHaveLength(1);
});
