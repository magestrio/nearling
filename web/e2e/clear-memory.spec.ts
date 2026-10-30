import { expect, test, type Page } from '@playwright/test';
import { BISCUIT, calls, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const dialog = (page: Page) => page.getByRole('alertdialog', { name: "Clear Pixel's memory?" });
const field = (page: Page) => page.getByRole('textbox');
const FORGETS =
  'Pixel will forget your chats, its diary, and what it knows about you, the friends who fed it and the pets it helped. Our backup keeps a copy for up to 30 days. NEAR AI may keep what it already received.';
const STAYS =
  /Pixel's name, character, growth, streak, outfits and food stay, and what's public about Pixel stays public forever\. An answer to today's riddle is cleared too and won't be checked at \d\d:\d\d\. Old thought receipts can't be fully checked after this\. This can't be undone\./;
const FAILED = "We couldn't clear Pixel's memory. Nothing was erased — try again.";
const UNKNOWN = "We couldn't confirm whether Pixel's memory was cleared. Reload to see where things stand.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';
const DONE = "Pixel's memory is clear — same Pixel, fresh start.";
const NEW_OWNER = 'Pixel belongs to a new owner now, so nothing was erased.';
const ME_BISCUIT = { accountId: 'a'.repeat(64), hatched: { tokenId: '2', name: 'Biscuit' }, currentPet: { tokenId: '2', name: 'Biscuit' }, ownedCount: 1 };

const clearCalls = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:clearMemory:9');

async function openDialog(page: Page, worker: Record<string, unknown> = {}) {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, ...worker } });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await expect(dialog(page)).toBeVisible();
}

// spec: add-account › Clear memory dialog screen › success
test('success: the title, what Pixel forgets, «Clear memory» and «Keep memory»; the focus is on the safe action', async ({ page }) => {
  await openDialog(page);
  await expect(dialog(page)).toContainText(FORGETS);
  await expect(dialog(page).getByRole('button', { name: 'Clear memory' })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Keep memory' })).toBeFocused();
  // the page under the modal dialog is out of reach and stays where it is
  await expect(page.locator('.ds-only[inert]')).toHaveCount(1);
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
});

// spec: add-account › Clear memory dialog screen › что останется
test('что останется: what stays, that it stays public, the riddle answer at {time}, the receipts, and that it can\'t be undone', async ({ page }) => {
  await openDialog(page);
  await expect(dialog(page)).toContainText(STAYS);
});

// spec: add-account › Clear memory dialog screen › success × Keep memory и Esc
test('success × Keep memory и Esc: the dialog closes, nothing is sent, the focus is back on «Account»', async ({ page }) => {
  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Keep memory' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account' })).toBeFocused();
  // Esc, and «Close», do the same
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account' })).toBeFocused();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await clearCalls(page)).toEqual([]);
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
});

// spec: add-account › Memory deletion flow › стирает
test('стирает: «Clearing Pixel\'s memory…», every control is off, Esc does nothing', async ({ page }) => {
  await openDialog(page, { clearMemoryDelayMs: 1500 });
  await dialog(page).getByRole('button', { name: 'Clear memory' }).click();
  await expect(dialog(page).getByRole('button', { name: "Clearing Pixel's memory…" })).toHaveAttribute('aria-busy', 'true');
  await expect(dialog(page).getByRole('status')).toHaveText("Clearing Pixel's memory…");
  await expect(dialog(page).getByRole('button', { name: 'Keep memory' })).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible();
});

// spec: add-account › Memory deletion flow › стирает × двойной тап
test('стирает × двойной тап: one request, not two', async ({ page }) => {
  await openDialog(page, { clearMemoryDelayMs: 1000 });
  const clear = dialog(page).getByRole('button', { name: 'Clear memory' });
  await clear.dblclick();
  await expect(dialog(page)).toHaveCount(0);
  expect(await clearCalls(page)).toHaveLength(1);
});

// spec: add-account › Memory deletion flow › стёр
test('стёр: the dialog closes, an empty conversation under the event line, the pet does not speak first, the focus is on the input', async ({ page }) => {
  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Clear memory' }).click();
  await expect(dialog(page)).toHaveCount(0);
  const log = page.getByRole('log');
  await expect(log).toContainText(DONE);
  await expect(log).not.toContainText('Start with the chart, then.');
  await expect(log.getByRole('listitem')).toHaveCount(1);
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveAttribute('placeholder', 'Talk to Pixel…');
  // the page stood still long enough to be asked for a greeting, if it would ask: it doesn't
  await lookAgain(page);
  await page.waitForTimeout(300);
  expect((await calls(page)).filter((c) => c === 'worker:greeting')).toEqual([]);
  await expect(log.getByRole('listitem')).toHaveCount(1);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

// spec: add-account › Memory deletion flow › стёр × набранная реплика
test('стёр × набранная реплика: a typed and unsent line stays in the field', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await field(page).fill('And if they ask why the chart matters?');
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await dialog(page).getByRole('button', { name: 'Clear memory' }).click();
  await expect(page.getByRole('log')).toContainText(DONE);
  await expect(field(page)).toHaveValue('And if they ask why the chart matters?');
  expect((await calls(page)).filter((c) => c.startsWith('worker:say'))).toEqual([]);
});

// spec: add-account › Memory deletion flow › стёр × перезагрузка
test('стёр × перезагрузка: a pet whose memory was cleared opens with an empty conversation and no greeting', async ({ page }) => {
  const cleared = { ...OWNER, conversation: { lines: [], more: false, before: null }, greeting: { job: null }, pets: { '9': { ...PIXEL, owner: { memoryEpoch: 1 } }, '2': BISCUIT } };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: cleared });
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await expect(page.getByRole('log').getByRole('listitem')).toHaveCount(0);
  await expect(page.getByText('is thinking')).toHaveCount(0);
  await expect.poll(async () => (await calls(page)).filter((c) => c === 'worker:greeting').length).toBe(1);
  await expect(page.getByRole('log').getByRole('listitem')).toHaveCount(0);
  await expect(field(page)).toHaveAttribute('placeholder', 'Talk to Pixel…');
});

// spec: add-account › Memory deletion flow › стёр × вторая вкладка
test('стёр × вторая вкладка: another tab of the owner sees the new count and empties its conversation, with no line', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await field(page).fill('still typing');
  // the other tab cleared: the server holds an empty conversation and one more clear
  await setWorker(page, { conversation: { lines: [], more: false, before: null }, petState: { memoryEpoch: 1 } });
  await lookAgain(page);
  await expect(page.getByRole('log')).not.toContainText('Start with the chart, then.');
  await expect(page.getByRole('log').getByRole('listitem')).toHaveCount(0);
  await expect(page.getByText(DONE)).toHaveCount(0);
  await expect(field(page)).toHaveValue('still typing');
});

// spec: add-account › Memory deletion data › ответ в пути
test('ответ в пути: the memory was cleared under an answer on its way — no reply lands, the player\'s line is gone, nothing is shown', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await field(page).fill('Tell me a story');
  await field(page).press('Enter');
  await expect(page.getByText('Pixel is thinking…')).toBeVisible();
  await setWorker(page, { petState: { code: 'memory_cleared', jobKind: 'reply' }, conversation: { lines: [], more: false, before: null } });
  await expect(page.getByText('Pixel is thinking…')).toHaveCount(0);
  await expect(page.getByRole('log')).not.toContainText('Tell me a story');
  // the line is not given back to the field either: the words were erased, not refused
  await expect(field(page)).toHaveValue('');
  await expect(page.getByText('Pixel lost that thought.')).toHaveCount(0);
});

// spec: add-account › Clear memory dialog screen › error
test('error: «We couldn\'t clear Pixel\'s memory. Nothing was erased — try again.» and «Try again»; the conversation as before', async ({ page }) => {
  await openDialog(page, { clearMemory: { fail: { status: 503, code: 'chain_unreachable' } } });
  await dialog(page).getByRole('button', { name: 'Clear memory' }).click();
  const line = dialog(page).getByRole('alert');
  await expect(line).toHaveText(FAILED);
  await expect(line).toBeFocused();
  await expect(dialog(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Clear memory' })).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
});

// spec: add-account › Clear memory dialog screen › error × Try again
test('error × Try again: asks for the deletion again; it goes through', async ({ page }) => {
  await openDialog(page, { clearMemory: { fail: { status: 500, code: 'clear_failed' } } });
  await dialog(page).getByRole('button', { name: 'Clear memory' }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText(FAILED);
  await setWorker(page, { clearMemory: { ok: true } });
  await dialog(page).getByRole('button', { name: 'Try again' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText(DONE);
  expect(await clearCalls(page)).toHaveLength(2);
});

// spec: add-account › Clear memory dialog screen › error × Keep memory
test('error × Keep memory: the dialog closes, the conversation is as before the tap', async ({ page }) => {
  await openDialog(page, { clearMemory: { fail: { status: 503, code: 'auth_unavailable' } } });
  await dialog(page).getByRole('button', { name: 'Clear memory' }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText(FAILED);
  await dialog(page).getByRole('button', { name: 'Keep memory' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await expect(page.getByRole('button', { name: 'Account' })).toBeFocused();
});

// spec: add-account › Clear memory dialog screen › error × исход неизвестен и Reload
test('error × исход неизвестен и Reload: no answer — «We couldn\'t confirm…» and «Reload», no second deletion; Reload loads the page again', async ({ page }) => {
  await openDialog(page, { clearMemory: { fail: { status: 0, code: 'unreachable' } } });
  await dialog(page).getByRole('button', { name: 'Clear memory' }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText(UNKNOWN);
  await expect(dialog(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Clear memory' })).toHaveCount(0);
  await page.evaluate(() => {
    (globalThis as { __marker?: number }).__marker = 1;
  });
  await dialog(page).getByRole('button', { name: 'Reload' }).click();
  // the page loads again: the tab's own value is gone and the screen shows what the server has
  await expect.poll(() => page.evaluate(() => (globalThis as { __marker?: number }).__marker ?? 0)).toBe(0);
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await expect(dialog(page)).toHaveCount(0);
});

// spec: add-account › Clear memory dialog screen › error × 429
test('error × 429: «Lots of visitors right now. Try again in a minute.» in the dialog, «Try again» asks again', async ({ page }) => {
  await openDialog(page, { clearMemory: { fail: { status: 429, code: 'rate_limited' } } });
  await dialog(page).getByRole('button', { name: 'Clear memory' }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText(BUSY);
  await setWorker(page, { clearMemory: { ok: true } });
  await dialog(page).getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('log')).toContainText(DONE);
});

// spec: add-account › Memory deletion flow › уже не владелец
test('уже не владелец: «Pixel belongs to a new owner now, so nothing was erased.», the dialog closes, the tab is the guest\'s Pet screen', async ({ page }) => {
  await openDialog(page, { me: ME_BISCUIT });
  await setWorker(page, { owned: [], clearMemory: { fail: { status: 403, code: 'not_owner' } } });
  await dialog(page).getByRole('button', { name: 'Clear memory' }).click();
  await expect(dialog(page)).toHaveCount(0);
  // the guest's page: «Feed Pixel» in the one column, no conversation, no memory row
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page.getByRole('log')).toHaveCount(0);
  await expect(page.locator('.ds-toast')).toHaveText(NEW_OWNER);
  await expect(page.getByRole('status').filter({ hasText: NEW_OWNER })).toHaveCount(1);
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Sign out']);
  // the Toast goes after its time
  await expect(page.locator('.ds-toast')).toHaveCount(0, { timeout: 8000 });
});
