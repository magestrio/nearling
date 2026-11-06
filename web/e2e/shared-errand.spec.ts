import { expect, test, type Locator, type Page } from '@playwright/test';

// the DS keeps a visually hidden live region that repeats a line; a check of what is drawn skips it
const drawn = (scope: Page | Locator, text: string | RegExp) => scope.getByText(text).and(scope.locator(':not(.ds-hidden)'));
import { calls, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const CODE = 'c'.repeat(64);
const PATH = `/pet/9/errand/${CODE}`;
const JOB = 'When does the next NEAR protocol upgrade ship?';
const base = { tokenId: '9', name: 'Pixel', state: 'funding' as const, form: 'find' as const, job: JOB,
  viewer: 'visitor' as const, funded: '1350000000000000000000', needed: '4330000000000000000000', chainState: 'Funding' as const, fullness: PIXEL.fullness };
const open = (page: Page, worker: Record<string, unknown> = {}, signed = true) =>
  openWith(page, PATH, { ...(signed ? { auth: SIGNED_IN } : {}), worker: { pets: { '9': PIXEL }, sharedErrand: base, ...worker } });

// spec: add-pet-errands › Shared errand screen › success
// spec: add-pet-errands › Friend-funded errand flow › friend opens the link
test('public link shows the job and progress without starting it', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('heading', { name: `Help Pixel find out: ${JOB}` })).toBeVisible();
  await expect(drawn(page, '0.62¢ of 2¢ food reserved for this errand')).toBeVisible();
  await expect(page.locator('.ds-centerpiece__text')).toContainText("A NEAR meal uses your NEAR. A free snack uses the project's food.");
  await expect(page.locator('.ds-centerpiece__actions')).not.toContainText('A NEAR meal uses your NEAR.');
  await expect(page.getByRole('button', { name: /Feed Pixel/ })).toBeVisible();
  expect((await calls(page)).some((name) => name.includes('sendErrand') || name.includes('prepareSharedErrand'))).toBe(false);
});

// spec: add-pet-errands › Shared errand screen › signed-out
test('signed-out link keeps the public job and starts sign-in with a feed return', async ({ page }) => {
  await open(page, {}, false);
  await expect(drawn(page, JOB)).toBeVisible();
  await page.getByRole('button', { name: 'Sign in to feed Pixel' }).click();
  await expect(page).toHaveURL(new RegExp(`${PATH}$`));
  await expect(page.getByRole('dialog', { name: 'Feed Pixel' })).toBeVisible();
});

// spec: add-feeding › Feed by link flow › owner signs in from a shared errand
test('owner returning from sign-in sees funding progress without a linked Feed control', async ({ page }) => {
  await open(page, { ...OWNER }, false);
  await page.getByRole('button', { name: 'Sign in to feed Pixel' }).click();
  await expect(page).toHaveURL(new RegExp(`${PATH}$`));
  await expect(drawn(page, "Friends' food pays for this job")).toBeVisible();
  await expect(page.locator('.ds-centerpiece__text')).toContainText("Friends' food pays for this job");
  await expect(page.getByRole('dialog', { name: 'Feed Pixel' })).toHaveCount(0);
});

// spec: add-pet-errands › Shared errand screen › owner views a waiting job
test('owner may share and close but has no linked Feed control', async ({ page }) => {
  await open(page, { ...OWNER });
  await expect(drawn(page, "Friends' food pays for this job")).toBeVisible();
  await expect(page.locator('.ds-centerpiece__text')).toContainText("Friends' food pays for this job");
  await expect(page.locator('.ds-centerpiece__actions')).not.toContainText("Friends' food pays for this job");
  await expect(page.getByRole('button', { name: 'Share job' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close job' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toHaveCount(0);
});

// spec: add-pet-errands › Friend-funded errand flow › link shared
// spec: add-pet-errands › Friend-funded errand flow › copy failed
test('Share job copies the link and words, then offers selectable manual copy when the browser refuses', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
  });
  await open(page, { ...OWNER });
  await page.getByRole('button', { name: 'Share job' }).click();
  const copy = page.getByLabel('Copy this link and send it to a friend:');
  await expect(copy).toBeVisible();
  expect(await copy.inputValue()).toContain(PATH);
  expect(await copy.inputValue()).toContain(JOB);
});

// spec: add-pet-errands › Shared errand screen › asleep
// spec: add-pet-errands › Shared errand screen › funded while waking
test('an asleep pet waits, and a fully funded waking pet asks for no more food', async ({ page }) => {
  const asleep = { state: 'asleep' as const, level: 0 };
  await open(page, { pets: { '9': { ...PIXEL, fullness: asleep } }, sharedErrand: { ...base, fullness: asleep } });
  await expect(drawn(page, 'Pixel is asleep. A meal or an available free snack can wake Pixel; this job will wait.')).toBeVisible();
  await setWorker(page, { sharedErrand: { ...base, fullness: asleep, funded: base.needed } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(drawn(page, 'Enough food is reserved. Pixel is waking up; the job will start when ready.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toHaveCount(0);
});

// spec: add-pet-errands › Shared errand screen › empty
// spec: add-pet-errands › Shared errand screen › error
test('closed and failed reads never offer a feed or submit a job', async ({ page }) => {
  await open(page, { sharedErrand: { tokenId: '9', name: 'Pixel', state: 'empty' } });
  await expect(drawn(page, 'This shared errand is no longer here. Food already given stays with Pixel.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toBeVisible();
  await setWorker(page, { sharedErrand: { fail: { status: 503, code: 'chain_unreachable' } } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(drawn(page, "We couldn't load this errand right now. Try again.")).toBeVisible();
  expect((await calls(page)).some((name) => name.includes('sendErrand'))).toBe(false);
});

// spec: add-pet-errands › Friend-funded errand flow › owner asks to close an unsettled job
// spec: add-pet-errands › Friend-funded errand flow › owner confirms closing an unsettled job
test('owner confirmation signs a fresh close approval and revokes the link after Worker confirmation', async ({ page }) => {
  await open(page, { ...OWNER });
  await page.getByRole('button', { name: 'Close job' }).click();
  await expect(drawn(page, 'Close this job? Food already given will stay with Pixel for ordinary use.')).toBeVisible();
  expect(await calls(page)).not.toContain('worker:closeSharedErrand');
  await page.getByRole('button', { name: 'Confirm close' }).click();
  await expect(drawn(page, 'This shared errand is no longer here. Food already given stays with Pixel.')).toBeVisible();
  expect(await calls(page)).toContain('worker:closeSharedErrand');
});

// spec: add-pet-errands › Shared errand screen › funding closed
test('a funded job closes the owner confirmation that was open', async ({ page }) => {
  await open(page, { ...OWNER });
  await page.getByRole('button', { name: 'Close job' }).click();
  await setWorker(page, { sharedErrand: { ...base, viewer: 'owner', state: 'running', chainState: 'Running' } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(drawn(page, 'This job is underway or finished. Visit Pixel to feed it normally.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm close' })).toHaveCount(0);
  expect(await calls(page)).not.toContain('worker:closeSharedErrand');
});

// spec: add-pet-errands › Friend-funded errand flow › owner confirms closing an unsettled job
test('unknown close outcome keeps Closing job until the chain-backed read confirms closure', async ({ page }) => {
  await open(page, { ...OWNER, closeSharedErrand: { fail: { status: 503, code: 'close_unknown' } } });
  await page.getByRole('button', { name: 'Close job' }).click();
  await page.getByRole('button', { name: 'Confirm close' }).click();
  await expect(drawn(page, 'Closing job…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await setWorker(page, { sharedErrand: { tokenId: '9', name: 'Pixel', state: 'empty' } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(drawn(page, 'This shared errand is no longer here. Food already given stays with Pixel.')).toBeVisible();
  expect((await calls(page)).filter((name) => name === 'worker:closeSharedErrand')).toHaveLength(1);
});

// spec: add-pet-errands › Friend-funded errand flow › owner close fails
test('rejected close keeps the reserve and offers a fresh Try again', async ({ page }) => {
  await open(page, { ...OWNER, closeSharedErrand: { fail: { status: 409, code: 'close_refused' } } });
  await page.getByRole('button', { name: 'Close job' }).click();
  await page.getByRole('button', { name: 'Confirm close' }).click();
  await expect(drawn(page, "We couldn't close this job. Try again.")).toBeVisible();
  await setWorker(page, { closeSharedErrand: { ok: true } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(drawn(page, 'This shared errand is no longer here. Food already given stays with Pixel.')).toBeVisible();
  expect((await calls(page)).filter((name) => name === 'worker:closeSharedErrand')).toHaveLength(2);
});

// spec: add-pet-errands › Shared errand screen › funding closed
// spec: add-pet-errands › Errand access data › someone else asks for the report
test('closed funding has no linked Feed; a visitor sees no private report or receipt', async ({ page }) => {
  await open(page, { sharedErrand: { ...base, state: 'reported', funded: base.needed, chainState: 'Settled', report: 'private report', receiptId: 'a'.repeat(24) } });
  await expect(drawn(page, 'This job is underway or finished. Visit Pixel to feed it normally.')).toBeVisible();
  await expect(drawn(page, 'private report')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toHaveCount(0);
});

// spec: add-pet-errands › Friend-funded errand flow › sponsor opens the report
test('a signed-in sponsor sees the report and its receipt after the one job finishes', async ({ page }) => {
  const receiptId = 'a'.repeat(24);
  await open(page, { sharedErrand: { ...base, state: 'reported', viewer: 'sponsor', funded: base.needed,
    chainState: 'Settled', report: 'The protocol upgrade date has not been announced.', receiptId, sources: [] },
    verificationThoughts: { [receiptId]: { id: receiptId, tokenId: '9', payingTokenId: null, kind: 'errand', status: 'billed',
      debitTxHash: 'H'.repeat(44), at: 0, model: 'Qwen/Qwen3.8-27B', priceYocto: '280000000000000000000', nearUsdRate: '5',
      workerTokenId: null, skilled: false, adapterUsed: false, erased: false, calls: [], viewer: 'guest', withoutReply: false, searches: 2 } } });
  await expect(drawn(page, 'The protocol upgrade date has not been announced.')).toBeVisible();
  await expect(drawn(page, '2 searches · 0.14¢')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', `/pet/9/verify/${receiptId}`);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toHaveCount(0);
});

// spec: add-pet-errands › Friend-funded errand flow › shared job came back empty
test('a paid search without a report gives sponsors its charge and receipt without rerunning', async ({ page }) => {
  const receiptId = 'a'.repeat(24);
  await open(page, { sharedErrand: { ...base, state: 'reported', viewer: 'sponsor', funded: base.needed,
    chainState: 'Settled', report: null, receiptId, sources: [] },
    verificationThoughts: { [receiptId]: { id: receiptId, tokenId: '9', payingTokenId: null, kind: 'errand', status: 'billed',
      debitTxHash: 'H'.repeat(44), at: 0, model: 'Qwen/Qwen3.8-27B', priceYocto: '280000000000000000000', nearUsdRate: '5',
      workerTokenId: null, skilled: false, adapterUsed: false, erased: false, calls: [], viewer: 'guest', withoutReply: true, searches: 2 } } });
  await expect(drawn(page, 'Pixel came back without a report. Its searches used 0.14¢ of food.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check this thought' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toHaveCount(0);
});

const pointer = (receiptId: string, searches: number) => ({ [receiptId]: { id: receiptId, tokenId: '9', payingTokenId: null, kind: 'errand', status: 'billed',
  debitTxHash: 'H'.repeat(44), at: 0, model: 'Qwen/Qwen3.8-27B', priceYocto: '280000000000000000000', nearUsdRate: '5',
  workerTokenId: null, skilled: false, adapterUsed: false, erased: false, calls: [], viewer: 'guest', withoutReply: true, searches } });

// spec: add-pet-errands › Shared errand screen › funded before start
test('food that covers the allowance before the job starts closes the link to more food and leads to ordinary feeding', async ({ page }) => {
  await open(page, { sharedErrand: { ...base, funded: base.needed } });
  await expect(page.getByRole('heading', { name: `Help Pixel find out: ${JOB}` })).toBeVisible();
  await expect(drawn(page, '2¢ of 2¢ food reserved for this errand')).toBeVisible();
  await expect(drawn(page, 'Enough food is already reserved for this errand.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Feed Pixel/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toHaveAttribute('href', '/pet/9');
});

// spec: add-pet-errands › Friend-funded errand flow › funded while waking
test('a funded job on a pet still shown asleep waits and asks for no more food, then shows the closed link once it starts', async ({ page }) => {
  const asleep = { state: 'asleep' as const, level: 0 };
  const funded = { ...base, fullness: asleep, funded: base.needed };
  await open(page, { sharedErrand: funded });
  await expect(drawn(page, 'Enough food is reserved. Pixel is waking up; the job will start when ready.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toHaveCount(0);
  expect((await calls(page)).some((name) => name.includes('sendErrand') || name.includes('prepareSharedErrand'))).toBe(false);
  await setWorker(page, { sharedErrand: { ...funded, state: 'running', fullness: PIXEL.fullness, chainState: 'Running' } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(drawn(page, 'This job is underway or finished. Visit Pixel to feed it normally.')).toBeVisible();
});

// spec: add-pet-errands › Friend-funded errand flow › shared job stopped before a search
test('a run that failed without a paid call tells the sponsor nothing was spent and offers no food; a stranger sees the closed link', async ({ page }) => {
  const failed = { ...base, state: 'failed' as const, viewer: 'sponsor' as const, chainState: 'Funding' as const, report: null, receiptId: null };
  await open(page, { sharedErrand: failed });
  await expect(drawn(page, "Pixel couldn't finish this errand. Nothing was spent.")).toBeVisible();
  await expect(page.getByRole('button', { name: /Feed Pixel/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check this thought' })).toHaveCount(0);
  await setWorker(page, { sharedErrand: { ...failed, viewer: 'visitor' } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(drawn(page, 'This job is underway or finished. Visit Pixel to feed it normally.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Feed Pixel/ })).toHaveCount(0);
});

// spec: add-pet-errands › Friend-funded errand flow › shared job's failed call cost food
test('a paid failed call with no search tells the sponsor what the try cost, with its receipt', async ({ page }) => {
  const receiptId = 'a'.repeat(24);
  await open(page, { sharedErrand: { ...base, state: 'failed', viewer: 'sponsor', funded: base.needed, chainState: 'Settled', report: null, receiptId, sources: [] },
    verificationThoughts: pointer(receiptId, 0) });
  await expect(drawn(page, "Pixel couldn't reach search. The try used 0.14¢ of food.")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', `/pet/9/verify/${receiptId}`);
  await expect(drawn(page, 'Pixel came back without a report.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Feed Pixel/ })).toHaveCount(0);
});

// spec: add-pet-errands › Friend-funded errand flow › shared job came back empty
test('searches that ran without a report are told as the server states them: a failed row with a receipt', async ({ page }) => {
  const receiptId = 'a'.repeat(24);
  await open(page, { sharedErrand: { ...base, state: 'failed', viewer: 'sponsor', funded: base.needed, chainState: 'Settled', report: null, receiptId, sources: [] },
    verificationThoughts: pointer(receiptId, 2) });
  await expect(drawn(page, 'Pixel came back without a report. Its searches used 0.14¢ of food.')).toBeVisible();
  await expect(drawn(page, "Pixel couldn't reach search.")).toHaveCount(0);
});

// spec: add-pet-errands › Friend-funded errand flow › link reopened
test('the link after its one job ran says so, shows the report and has no control to run it again', async ({ page }) => {
  const receiptId = 'a'.repeat(24);
  await open(page, { sharedErrand: { ...base, state: 'reported', viewer: 'sponsor', funded: base.needed, chainState: 'Settled',
    report: 'The protocol upgrade date has not been announced.', receiptId, sources: [] }, verificationThoughts: pointer(receiptId, 2) });
  await expect(drawn(page, 'This job is underway or finished. Visit Pixel to feed it normally.')).toBeVisible();
  await expect(drawn(page, 'The protocol upgrade date has not been announced.')).toBeVisible();
  await expect(drawn(page, 'This shared job has already run.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Feed Pixel|Send|Share job|Close job/ })).toHaveCount(0);
  const before = await calls(page);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(drawn(page, 'This shared job has already run.')).toBeVisible();
  expect((await calls(page)).filter((name) => name.includes('sendErrand') || name.includes('prepareSharedErrand')).length)
    .toBe(before.filter((name) => name.includes('sendErrand') || name.includes('prepareSharedErrand')).length);
});

// spec: add-feeding › Feed by link flow › friend opens feeding from a shared errand
// spec: add-pet-errands › Friend-funded errand flow › friend adds a NEAR meal
test('friend feeds from the link and the thank-you remains until Done', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /Feed Pixel/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Feed Pixel' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: /^Feed · 5¢/ }).click();
  await expect(drawn(sheet, 'You fed Pixel! Your NEAR is reserved for this errand.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(drawn(page, 'You fed Pixel! Your NEAR is reserved for this errand.')).toBeVisible();
});

const OLD_HASH = 'b'.repeat(64);
const OLD_RESERVE = { jobHash: OLD_HASH, amountYocto: '1700000000000000000000' };
const oldOwner = { ...PIXEL, owner: { oldSharedReserve: OLD_RESERVE } };

// spec: add-pet-errands › Friend-funded errand flow › old reserve after memory clear and gift
// spec: add-gift › Gift ownership data › cleared running job survives gift
test('new owner sees only the word-free old reserve and releases it with one signed approval', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': oldOwner } } });
  await expect(drawn(page, /0\.0017 NEAR of food waits for an old job/)).toBeVisible();
  await expect(drawn(page, 'Secret named job')).toHaveCount(0);
  await page.getByRole('button', { name: 'Release' }).click();
  await expect(drawn(page, '0.0017 NEAR of food is ready for Pixel.')).toBeVisible();
  expect((await calls(page)).filter((name) => name === 'worker:releaseSharedReserve')).toHaveLength(1);
});

// spec: add-pet-errands › Friend-funded errand flow › old reserve release rejected
test('rejected Release keeps the reserve; a fresh Try again succeeds', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': oldOwner }, releaseSharedReserve: { fail: { status: 409, code: 'close_refused' } } } });
  await page.getByRole('button', { name: 'Release' }).click();
  await expect(drawn(page, "We couldn't release this food. Try again.")).toBeVisible();
  await expect(drawn(page, /0\.0017 NEAR of food waits for an old job/)).toBeVisible();
  await setWorker(page, { releaseSharedReserve: { ok: true } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(drawn(page, '0.0017 NEAR of food is ready for Pixel.')).toBeVisible();
});
