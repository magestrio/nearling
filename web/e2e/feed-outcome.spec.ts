import { expect, test, type Page } from '@playwright/test';
import { BISCUIT, calls, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const HUNGRY_PIXEL = { ...PIXEL, fullness: { state: 'hungry' as const, level: 0.25 } };
const sheet = (page: Page, name = 'Feed Pixel') => page.getByRole('dialog', { name });
const reads = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:feedSheet').length;
const count = async (page: Page, call: string) => (await calls(page)).filter((c) => c === call).length;
const open = async (page: Page, feedSheet: unknown) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': HUNGRY_PIXEL, '2': BISCUIT }, feedSheet: feedSheet as never } });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
};
const SIGNED_OUT = "You've been signed out. Sign in to pick up where you left off.";
const STILL = 'Still checking — this can take a moment.';
const FAILED_MEAL = "That meal didn't reach Pixel, so its NEAR stays in your wallet. Try again.";
/** The owner's page with Pixel hungry, the clock the test's, a send that takes `sendMs`; the sheet open. */
async function sending(page: Page, worker: Record<string, unknown> = {}) {
  await page.clock.install();
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': HUNGRY_PIXEL, '2': BISCUIT }, ...worker } });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(sheet(page).getByRole('button', { name: /^Feed · 23¢/ })).toBeEnabled();
}

// spec: add-feeding › Feeding outcome rule › отправлено
// spec: add-feeding › Feeding outcome rule › отправлено × repeat tap
test('отправлено: «Feeding Pixel…» on the tapped row, the other rows inactive, a repeat tap sends no second portion', async ({ page }) => {
  await sending(page, { feedSendDelayMs: 12_000 });
  const dialog = sheet(page);
  await dialog.getByRole('button', { name: /^Feed · 23¢/ }).click();
  const pending = dialog.getByRole('button', { name: 'Feeding Pixel…' });
  await expect(pending).toBeVisible();
  await expect(pending).toHaveAttribute('aria-busy', 'true');
  // the tapped row keeps the focus (DS › Sheet › After an outcome)
  await expect(pending).toBeFocused();
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: /^Feed · 92¢/ })).toBeDisabled();
  // the sheet says it on its live region
  await expect(dialog.getByRole('status').filter({ hasText: 'Feeding Pixel…' })).toHaveCount(1);
  // aria-disabled: a repeat tap, with the pointer or the keyboard, does nothing
  await pending.click({ force: true });
  await pending.press('Enter');
  await page.clock.fastForward(1000);
  expect(await count(page, 'worker:buildFeed:0.05')).toBe(1);
  expect(await count(page, 'worker:sendFeed')).toBe(1);
});

// spec: add-feeding › Feeding outcome rule › не прошло
test('не прошло: the line, «Try again» with the focus, the tapped row marked, the others active, the pet as it was', async ({ page }) => {
  await sending(page, { sendFeed: { status: 'failed', hatched: true } });
  const dialog = sheet(page);
  await dialog.getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(dialog.locator('#feed-failed')).toHaveText(FAILED_MEAL);
  // the sheet's live region says it too
  await expect(dialog.getByRole('status').filter({ hasText: FAILED_MEAL })).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeFocused();
  await expect(dialog.getByRole('button', { name: /^Feed · 23¢/ })).toHaveAttribute('aria-describedby', 'feed-failed');
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: /^Feed · 92¢/ })).toBeEnabled();
  await expect(page.getByText('Hungry', { exact: true }).first()).toBeVisible();
  // the NEAR never left: no confirmation, no «Yum!»
  await expect(page.getByText(/Yum!/)).toHaveCount(0);
});

// spec: add-feeding › Feeding outcome rule › не прошло
test('не прошло: a snack that did not go through says so in its own words', async ({ page }) => {
  const asleep = { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 } };
  await sending(page, { pets: { '9': asleep, '2': BISCUIT }, snack: { status: 'failed', hatched: true }, feedSheet: { snack: { state: 'ready' } } });
  await sheet(page).getByRole('button', { name: 'Give a free snack' }).click();
  await expect(sheet(page).locator('#feed-failed')).toHaveText("That snack didn't reach Pixel. Try again.");
  await expect(sheet(page).getByRole('button', { name: 'Try again' })).toBeFocused();
});

// spec: add-feeding › Feeding outcome rule › не прошло × Try again
test('не прошло × Try again: the same portion from the start, a new build and a new signature', async ({ page }) => {
  await sending(page, { sendFeed: { status: 'failed', hatched: true } });
  const dialog = sheet(page);
  await dialog.getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
  await setWorker(page, { sendFeed: { status: 'ok', hatched: true }, pets: { '9': PIXEL, '2': BISCUIT } });
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByText('Yum! Pixel is fuller now.').last()).toBeVisible();
  expect(await count(page, 'worker:buildFeed:0.05')).toBe(2);
  expect(await count(page, 'worker:sendFeed')).toBe(2);
});

// spec: add-feeding › Feeding outcome rule › исход неизвестен
test('исход неизвестен: at 10 s «Feeding Pixel…» becomes «Still checking…», the portions stay inactive, then the confirmation', async ({ page }) => {
  await sending(page, { feedSendDelayMs: 20_000, pets: { '9': PIXEL, '2': BISCUIT } });
  const dialog = sheet(page);
  await dialog.getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(dialog.getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
  await page.clock.fastForward(9_000);
  await expect(dialog.getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
  await page.clock.fastForward(1_500);
  await expect(dialog.getByRole('button', { name: STILL })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Feeding Pixel…' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: /^Feed · 92¢/ })).toBeDisabled();
  await page.clock.fastForward(10_000);
  await expect(dialog.getByText('Yum! Pixel is fuller now.').last()).toBeVisible();
});

// spec: add-feeding › Feeding outcome rule › исход неизвестен
test('исход неизвестен: a snack says the same at 10 s', async ({ page }) => {
  const asleep = { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 } };
  await sending(page, { pets: { '9': asleep, '2': BISCUIT }, feedSendDelayMs: 20_000, feedSheet: { snack: { state: 'ready' } } });
  await sheet(page).getByRole('button', { name: 'Give a free snack' }).click();
  await expect(sheet(page).getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
  await page.clock.fastForward(10_500);
  await expect(sheet(page).getByRole('button', { name: STILL })).toBeVisible();
});

// spec: add-feeding › Feeding outcome rule › исход неизвестен
test('исход неизвестен: `unknown` from the server repeats /send every 5 s until it is known, never a new build', async ({ page }) => {
  await sending(page, { sendFeed: { status: 'unknown', hatched: true } });
  await sheet(page).getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(sheet(page).getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
  await expect.poll(() => count(page, 'worker:sendFeed')).toBe(1);
  await page.clock.fastForward(5_100);
  await expect.poll(() => count(page, 'worker:sendFeed')).toBe(2);
  await page.clock.fastForward(5_100);
  await expect.poll(() => count(page, 'worker:sendFeed')).toBe(3);
  await expect(sheet(page).getByRole('button', { name: STILL })).toBeVisible();
  await setWorker(page, { sendFeed: { status: 'ok', hatched: true }, pets: { '9': PIXEL, '2': BISCUIT } });
  await page.clock.fastForward(5_100);
  await expect(sheet(page).getByText('Yum! Pixel is fuller now.').last()).toBeVisible();
  expect(await count(page, 'worker:buildFeed:0.05')).toBe(1);
});

// spec: add-feeding › Feeding outcome rule › closed on its way
// spec: add-feeding › Feeding transaction data › outcome with the sheet closed
test('closed on its way: the meal goes on, no message follows, and the page shows the fullness within seconds', async ({ page }) => {
  await sending(page, { feedSendDelayMs: 12_000 });
  await sheet(page).getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(sheet(page).getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Pixel, hungry' })).toBeVisible();
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT } });
  await page.clock.fastForward(12_500);
  await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
  // no «Yum!», no thanks, no word of a failure, no sheet
  await expect(page.getByText(/Yum!|didn't reach|Still checking/)).toHaveCount(0);
  await expect(sheet(page)).toHaveCount(0);
  expect(await count(page, 'worker:sendFeed')).toBe(1);
});

// spec: add-feeding › Feeding transaction data › outcome with the sheet closed
test('outcome with the sheet closed: a guest\'s page, which has no poll, learns the outcome too', async ({ page }) => {
  await page.clock.install();
  const asleep = { ...BISCUIT, fullness: { state: 'asleep' as const, level: 0 } };
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { pets: { '9': PIXEL, '2': asleep }, feedSendDelayMs: 12_000 } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await sheet(page, 'Feed Biscuit').getByRole('button', { name: /^Feed · 5¢/ }).click();
  await sheet(page, 'Feed Biscuit').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('img', { name: 'Biscuit, asleep' })).toBeVisible();
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT } });
  await page.clock.fastForward(12_500);
  await expect(page.getByRole('img', { name: 'Biscuit, full' })).toBeVisible();
  await expect(page.getByText(/You fed Biscuit/)).toHaveCount(0);
});

// spec: add-feeding › Feeding transaction data › outcome with the sheet closed
test('outcome with the sheet closed: a reload while it is on its way — the tab watches the outcome from `myFeed`', async ({ page }) => {
  await page.clock.install();
  const withRow = { ...HUNGRY_PIXEL, myFeed: { id: 'F'.repeat(44), source: 'near' as const } };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': withRow, '2': BISCUIT }, feedOutcome: { status: 'unknown', hatched: true } } });
  await expect(page.getByRole('img', { name: 'Pixel, hungry' })).toBeVisible();
  await expect.poll(() => count(page, 'worker:feedOutcome')).toBe(1);
  await setWorker(page, { feedOutcome: { status: 'ok', hatched: true }, pets: { '9': PIXEL, '2': BISCUIT } });
  await page.clock.fastForward(5_100);
  await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
});

// spec: add-feeding › Feeding outcome rule › closed on its way × session ended
test('closed on its way × session ended: the sheet stays, no message, the tab stops asking, the next tap gets the line', async ({ page }) => {
  await sending(page, { sendFeed: { status: 'unknown', hatched: true } });
  const dialog = sheet(page);
  await dialog.getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect.poll(() => count(page, 'worker:sendFeed')).toBe(1);
  await setWorker(page, { sessionExpired: true });
  await page.clock.fastForward(5_100);
  await expect.poll(() => count(page, 'worker:sendFeed')).toBe(2);
  const asked = await count(page, 'worker:sendFeed');
  await page.clock.fastForward(20_000);
  expect(await count(page, 'worker:sendFeed')).toBe(asked);
  // nothing changed on the sheet and nothing was said
  await expect(dialog).toBeVisible();
  await expect(page.getByText(/Yum!|didn't reach/)).toHaveCount(0);
  await expect(page.getByText(SIGNED_OUT)).toHaveCount(0);
  // the next tap: the line of `Session expiry flow`
  await dialog.getByRole('button', { name: 'Ask friends to feed Pixel' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText(SIGNED_OUT).first()).toBeVisible();
});

// spec: add-feeding › Feeding outcome rule › reopened on its way
test('reopened on its way: «Still checking…» at once, the portions and the snack inactive, then the outcome in the sheet', async ({ page }) => {
  await sending(page, { feedSendDelayMs: 40_000 });
  await sheet(page).getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(sheet(page).getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const dialog = sheet(page);
  await expect(dialog.getByText(STILL).first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: /^Feed · 23¢/ })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: /^Feed · 92¢/ })).toBeDisabled();
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT } });
  await page.clock.fastForward(40_500);
  await expect(dialog.getByText('Yum! Pixel is fuller now.').last()).toBeVisible();
});

// spec: add-feeding › Feeding outcome rule › reopened on its way × the first read held
test('reopened on its way × the first read held: «Still checking…» at once, before the sheet is read, with nothing to tap', async ({ page }) => {
  await sending(page, { feedSendDelayMs: 40_000 });
  await sheet(page).getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(sheet(page).getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);
  // the network behind the server is slow: the sheet's read is held, as `GET …/feed` is on a hash the network has not finished
  await setWorker(page, { feedSheetDelayMs: 30_000 });
  const before = await reads(page);
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const dialog = sheet(page);
  await expect(dialog.getByText(STILL).first()).toBeVisible();
  await expect(dialog.getByRole('status').filter({ hasText: STILL })).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: /^Feed · / })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /free snack/ })).toHaveCount(0);
  // the read has been asked and is still out
  await expect.poll(() => reads(page)).toBe(before + 1);
  await page.clock.fastForward(30_500);
  await expect(dialog.getByRole('button', { name: /^Feed · 23¢/ })).toBeDisabled();
  await expect(dialog.getByText(STILL).first()).toBeVisible();
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT }, feedSheetDelayMs: 0 });
  await page.clock.fastForward(10_000);
  await expect(dialog.getByText('Yum! Pixel is fuller now.').last()).toBeVisible();
});

// spec: add-feeding › Feeding outcome rule › reopened on its way × the network does not read
test('reopened on its way × the network does not read: «Still checking…», never «Nothing was spent»; the outcome follows the first sheet that reads', async ({ page }) => {
  await sending(page, { feedSendDelayMs: 40_000 });
  await sheet(page).getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(sheet(page).getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await setWorker(page, { feedSheet: { chain: false } });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const dialog = sheet(page);
  await expect(dialog.getByText(STILL).first()).toBeVisible();
  await expect(dialog.getByText(/Nothing was spent|We can't feed Pixel right now/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Feed · / })).toHaveCount(0);
  // the poll finds the network still out: the line stands
  await page.clock.fastForward(5_100);
  await expect(dialog.getByText(STILL).first()).toBeVisible();
  await expect(dialog.getByText(/Nothing was spent/)).toHaveCount(0);
  // the meal is confirmed while the sheet cannot be read; the network comes back and the sheet draws the outcome
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT } });
  await page.clock.fastForward(36_000);
  await expect(dialog.getByText(STILL).first()).toBeVisible();
  await setWorker(page, { feedSheet: {} });
  await page.clock.fastForward(5_100);
  await expect(dialog.getByText('Yum! Pixel is fuller now.').last()).toBeVisible();
});

// spec: add-feeding › Own pet feeding flow › разбудил × a reload with the meal on its way
test('разбудил × a reload with the meal on its way: the asleep pet\'s meal, confirmed with the sheet reopened, closes it', async ({ page }) => {
  await page.clock.install();
  const asleep = { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 }, myFeed: { id: 'F'.repeat(44), source: 'near' as const } };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': asleep, '2': BISCUIT }, feedOutcome: { status: 'unknown', hatched: true } } });
  await expect(page.getByRole('img', { name: 'Pixel, asleep' })).toBeVisible();
  await expect.poll(() => count(page, 'worker:feedOutcome')).toBe(1);
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(sheet(page).getByText(STILL).first()).toBeVisible();
  await setWorker(page, { feedOutcome: { status: 'ok', hatched: true }, pets: { '9': PIXEL, '2': BISCUIT } });
  await page.clock.fastForward(5_100);
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText(/Yum!/)).toHaveCount(0);
});

// spec: add-feeding › Feeding outcome rule › reopened on its way × another pet
test('reopened on its way × another pet: a sheet open on another pet says «Still checking…» and then only redraws', async ({ page }) => {
  await page.clock.install();
  await openWith(page, '/pet/2', {
    auth: SIGNED_IN,
    worker: { owned: ['9'], pets: { '9': HUNGRY_PIXEL, '2': BISCUIT }, feedSendDelayMs: 12_000 },
  });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await sheet(page, 'Feed Biscuit').getByRole('button', { name: /^Feed · 5¢/ }).click();
  await sheet(page, 'Feed Biscuit').getByRole('button', { name: 'Close' }).click();
  await page.evaluate(() => (globalThis as { __nearlingOpenFeed?: (r: unknown) => void }).__nearlingOpenFeed?.({ tokenId: '9', name: 'Pixel', label: 'your Pixel', elsewhere: true }));
  const dialog = sheet(page, 'Feed your Pixel');
  await expect(dialog.getByText(STILL).first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeDisabled();
  await page.clock.fastForward(12_500);
  // the meal was Biscuit's: no message here, the sheet reads again and is the own pet's
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeEnabled();
  await expect(dialog.getByText(/Yum!|You fed/)).toHaveCount(0);
});

// spec: add-feeding › Feeding connection rule › сеть NEAR недоступна
test('сеть NEAR недоступна: a portion tapped while the network behind the server is out draws the same sheet, nothing was spent', async ({ page }) => {
  await sending(page, { buildFeed: { fail: { status: 503, code: 'chain_unreachable' } } });
  await sheet(page).getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(sheet(page).getByText("We can't feed Pixel right now. Nothing was spent — try again in a moment.")).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: /^Feed · / })).toHaveCount(0);
  await setWorker(page, { buildFeed: undefined });
  await sheet(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page).getByRole('button', { name: /^Feed · 23¢/ })).toBeEnabled();
});

// spec: add-feeding › Feed sheet screen › мало NEAR
test('мало NEAR: a portion the wallet could not cover at the tap redraws the sheet from the server\'s answer', async ({ page }) => {
  const portions = [
    { near: '0.01', yocto: '10000000000000000000000', cents: 5, missing: null },
    { near: '0.05', yocto: '50000000000000000000000', cents: 23, missing: '0.04' },
    { near: '0.2', yocto: '200000000000000000000000', cents: 92, missing: '0.19' },
  ];
  const short = { chain: true, viewer: 'owner', name: 'Pixel', fullness: HUNGRY_PIXEL.fullness, portions, wallet: { state: 'some', balance: '10000000000000000000000' }, snack: { state: 'none' }, hatched: true, friend: null, pending: null };
  await sending(page, { buildFeed: { fail: { status: 409, code: 'short', body: { code: 'short', sheet: short } } } });
  await sheet(page).getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(sheet(page).getByText('Add 0.04 NEAR to give this meal.')).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: /^Feed · 23¢/ })).toBeDisabled();
  await expect(sheet(page).getByText(/didn't reach/)).toHaveCount(0);
});

// spec: add-feeding › Feeding transaction data › прислана не та порция
test('прислана не та порция: a transaction of another portion is not signed and not sent; the player sees «не прошло»', async ({ page }) => {
  // what the server sends is not one `pet_feed` of the tapped portion (every way it can differ is `feedTx.test.ts`'s)
  await sending(page, { buildFeed: { tx: 'AAAA' } });
  await sheet(page).getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(sheet(page).locator('#feed-failed')).toHaveText(FAILED_MEAL);
  expect(await count(page, 'worker:sendFeed')).toBe(0);
});

// the sheet's own refresh stays quiet while a meal is on its way
// spec: add-feeding › Feed sheet screen › лист обновляется сам
test('лист обновляется сам: a reopened sheet and a tab coming back read again without disturbing the line that stands', async ({ page }) => {
  await sending(page, { feedSendDelayMs: 40_000 });
  await sheet(page).getByRole('button', { name: /^Feed · 23¢/ }).click();
  await expect(sheet(page).getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
  const before = await reads(page);
  await lookAgain(page);
  await page.waitForTimeout(300);
  expect(await reads(page)).toBe(before);
  await expect(sheet(page).getByRole('button', { name: 'Feeding Pixel…' })).toBeVisible();
});

// spec: add-feeding › Feed sheet screen › error
test('error: «We couldn\'t open feeding right now…» and «Try again», which reads the sheet again; the pet stays as it was', async ({ page }) => {
  await open(page, { fail: { status: 500, code: 'error' } });
  const dialog = sheet(page);
  await expect(dialog.getByText("We couldn't open feeding right now. Try again in a moment.")).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Feed · / })).toHaveCount(0);
  // the pet on the page is in its last known state
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(page.getByText('Hungry', { exact: true }).first()).toBeVisible();
  const before = await reads(page);
  await setWorker(page, { feedSheet: {} });
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeVisible();
  expect(await reads(page)).toBe(before + 1);
  await expect(dialog.getByText("We couldn't open feeding right now.")).toHaveCount(0);
});

// spec: add-feeding › Feed sheet screen › error
test('error on a phone: the sheet has no answer of its own, its head shows the fullness of the page\'s plate (frame feed-error)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, { fail: { status: 500, code: 'error' } });
  const dialog = sheet(page);
  await expect(dialog.getByText("We couldn't open feeding right now. Try again in a moment.")).toBeVisible();
  await expect(dialog.getByText('Hungry', { exact: true })).toBeVisible();
});

// spec: add-feeding › Feeding connection rule › сеть NEAR недоступна
test('сеть NEAR недоступна: «We can\'t feed Pixel right now. Nothing was spent…», no portion or snack to tap, «Try again» reads the state again', async ({ page }) => {
  await open(page, { chain: false });
  const dialog = sheet(page);
  await expect(dialog.getByText("We can't feed Pixel right now. Nothing was spent — try again in a moment.")).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Feed · / })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /free snack/ })).toHaveCount(0);
  const before = await reads(page);
  await setWorker(page, { feedSheet: {} });
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeEnabled();
  expect(await reads(page)).toBe(before + 1);
});
