import { expect, test, type Page } from '@playwright/test';
import type { FakeWorkerState } from '../src/seams/fakes';
import type { OutfitSlug } from '../src/seams/worker-types';
import { calls, lookAgain, openDiary, openPet, openWith, reloadHolding, setWardrobePet, setWorker, SIGNED_IN, WARDROBE_OWNS, wardrobeWorker } from './helpers';

const SCARF: OutfitSlug = 'cozy-scarf';
/** what Pixel has once the Cozy scarf is written to the chain */
const OWNS: OutfitSlug[] = [...WARDROBE_OWNS, SCARF];
const SCARF_LINE = 'Pixel earned the Cozy scarf for a 3-day streak.';
const ERROR = "Couldn't put it on just now. The Cozy scarf is waiting in Pixel's wardrobe.";
const SIGNED_OUT = "You've been signed out. Sign in to pick up where you left off.";
const DOWN = { fail: { status: 0, code: 'unreachable' } };
const ASLEEP_PET = { fullness: { state: 'asleep' as const, level: 0 } };
const HUNGRY_PET = { fullness: { state: 'hungry' as const, level: 0.25 } };

const dialog = (page: Page) => page.getByRole('dialog', { name: 'New outfit!' });
const heading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Pixel' });
/** the pet of the page behind the notice (the one in the notice stands inside the dialog) */
const pageWears = (page: Page, slug: string) => page.locator(`[data-illustration][data-outfit="${slug}"]`);
const field = (page: Page) => page.getByPlaceholder('Talk to Pixel…');
const wears = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('worker:wear:'));
const seen = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('worker:seenOutfit:'));
const settleMs = (page: Page) => page.waitForTimeout(700);
/** the error line as the dialog draws it: its status region says it too, visually hidden */
const errorLine = (page: Page) => dialog(page).getByText(ERROR, { exact: true }).and(page.locator(':not(.ds-hidden)'));

/** Pixel as the Wardrobe tests have it, with the unseen notices (and the items they are about) laid over its owner view. */
const withNotices = (notices: OutfitSlug[] = [SCARF], pet: Parameters<typeof wardrobeWorker>[0] = {}, extra: Partial<FakeWorkerState> = {}): FakeWorkerState =>
  wardrobeWorker(pet, { notices, outfits: OWNS }, {}, extra);

async function openNotice(page: Page, notices: OutfitSlug[] = [SCARF], pet: Parameters<typeof wardrobeWorker>[0] = {}, extra: Partial<FakeWorkerState> = {}, route = '/pet/9') {
  await openWith(page, route, { auth: SIGNED_IN, worker: withNotices(notices, pet, extra) });
  await expect(dialog(page)).toBeVisible();
}

/** A look at the pet finds an earned item written to the chain meanwhile. */
async function deliver(page: Page, notices: OutfitSlug[] = [SCARF], pet: Parameters<typeof wardrobeWorker>[0] = {}) {
  await setWardrobePet(page, pet, { notices, outfits: OWNS });
  await lookAgain(page);
}

// spec: add-wardrobe › New outfit notice screen › success × a streak and a riddle item
test('success × a streak and a riddle item: the title, the item and what earned it, «Wear it» and «Later», the pet in the new item; the server is told once', async ({ page }) => {
  test.setTimeout(60_000);
  const cases: Array<[OutfitSlug, string, string]> = [
    [SCARF, 'Cozy scarf', SCARF_LINE],
    ['daisy-crown', 'Daisy crown', 'Pixel earned the Daisy crown for a 1-day streak.'],
    ['thinking-cap', 'Thinking cap', 'Pixel earned the Thinking cap for the first solved riddle.'],
  ];
  for (const [slug, name, line] of cases) {
    await openNotice(page, [slug]);
    await expect(dialog(page).getByRole('heading', { name: 'New outfit!' })).toBeFocused();
    await expect(dialog(page).getByText(line, { exact: true })).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Wear it' })).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Later' })).toBeVisible();
    await expect(dialog(page).getByRole('img', { name: `Pixel, full, wearing the ${name}` })).toBeVisible();
    // the page behind stands as it was and is out of reach
    await expect(page.locator('.ds-only[inert]')).toHaveCount(1);
    expect(await seen(page)).toEqual([`worker:seenOutfit:${slug}`]);
  }
});

// spec: add-wardrobe › New outfit notice screen › success × Wear it
test('success × Wear it: the button is pending until the answer, then the notice goes and the pet is in the new item', async ({ page }) => {
  await openNotice(page, [SCARF], {}, { wearDelayMs: 1000 });
  await expect(pageWears(page, 'thinking-cap')).toHaveCount(1);
  await dialog(page).getByRole('button', { name: 'Wear it' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Wear it' })).toHaveAttribute('aria-busy', 'true');
  // a repeat tap, Close and Esc do nothing while it is on its way
  await dialog(page).getByRole('button', { name: 'Wear it' }).click({ force: true });
  await dialog(page).getByRole('button', { name: 'Close' }).click({ force: true });
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await expect(pageWears(page, SCARF)).toHaveCount(1);
  await expect(page.getByRole('img', { name: 'Pixel, full, wearing the Cozy scarf' })).toBeVisible();
  expect(await wears(page)).toEqual(['worker:wear:cozy-scarf']);
});

// spec: add-wardrobe › New outfit notice screen › success × Later, Close, Esc, the scrim
test('success × Later, Close, Esc, the scrim: each closes the notice, the pet keeps its outfit, the focus goes to the page\'s h1 and the item waits in the wardrobe', async ({ page }) => {
  test.setTimeout(90_000);
  const closers: Record<string, (p: Page) => Promise<void>> = {
    Later: (p) => dialog(p).getByRole('button', { name: 'Later' }).click(),
    Close: (p) => dialog(p).getByRole('button', { name: 'Close' }).click(),
    Esc: (p) => p.keyboard.press('Escape'),
    scrim: (p) => p.locator('.ds-sheet__scrim').click({ position: { x: 4, y: 4 } }),
  };
  for (const [how, close] of Object.entries(closers)) {
    await openNotice(page);
    await close(page);
    await expect(dialog(page), how).toHaveCount(0);
    await expect(heading(page), how).toBeFocused();
    await expect(pageWears(page, 'thinking-cap'), how).toHaveCount(1);
    expect(await wears(page), how).toEqual([]);
    // a look at the pet does not bring it back: it is shown
    await lookAgain(page);
    await settleMs(page);
    await expect(dialog(page), how).toHaveCount(0);
  }
  await page.getByRole('link', { name: 'Wardrobe' }).click();
  await expect(page.getByRole('button', { name: 'Wear Cozy scarf' })).toBeVisible();
});

// spec: add-wardrobe › New outfit notice screen › success × two at once
test('success × two at once: the second notice comes after the first closes', async ({ page }) => {
  await openNotice(page, ['daisy-crown', SCARF]);
  await expect(dialog(page).getByText('Pixel earned the Daisy crown for a 1-day streak.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await dialog(page).getByRole('button', { name: 'Later' }).click();
  await expect(dialog(page).getByText(SCARF_LINE, { exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Later' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await settleMs(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(await seen(page)).toEqual(['worker:seenOutfit:daisy-crown', 'worker:seenOutfit:cozy-scarf']);
});

// spec: add-wardrobe › New outfit notice screen › success × over Diary screen
test('success × over Diary screen: the notice opens over the Diary, the Diary stays under it, and the focus goes back to its h1', async ({ page }) => {
  await openDiary(page, {}, { ...withNotices() });
  await expect(dialog(page)).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  await dialog(page).getByRole('button', { name: 'Later' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  await expect(page.getByRole('heading', { level: 1, name: "Pixel's diary" })).toBeFocused();
});

// spec: add-wardrobe › New outfit notice screen › success × over Diary screen
test('success × over Diary screen: a Diary that is due opens first and the notice is over it', async ({ page }) => {
  await openPet(page, { diaryUnread: true, notices: [SCARF], outfits: OWNS });
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  await expect(dialog(page)).toBeVisible();
});

// spec: add-wardrobe › New outfit notice screen › success × a Feed sheet open
test('success × a Feed sheet open: the notice comes over it, Esc closes the notice and not the sheet', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withNotices([], HUNGRY_PET) });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const sheet = page.getByRole('dialog', { name: 'Feed Pixel' });
  await expect(sheet).toBeVisible();
  await deliver(page, [SCARF], HUNGRY_PET);
  await expect(dialog(page)).toBeVisible();
  await expect(sheet).toBeAttached();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(sheet).toBeVisible();
  // the focus goes back into the sheet it came from, not to the page behind it
  await expect(sheet.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

// spec: add-wardrobe › New outfit notice screen › success × a menu open
test('success × a menu open: the notice comes over the Account menu', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withNotices([]) });
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await deliver(page);
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Later' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

// spec: add-wardrobe › New outfit notice screen › success × a line being typed
test('success × a line being typed: the notice waits, the player keeps typing, and it opens once the field is empty', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withNotices([]) });
  await field(page).fill('Tell me about the chart');
  await deliver(page);
  await settleMs(page);
  await expect(dialog(page)).toHaveCount(0);
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue('Tell me about the chart');
  await field(page).fill('');
  await expect(dialog(page)).toBeVisible();
});

// spec: add-wardrobe › New outfit notice screen › success × a line left in the field
test('success × a line left in the field: the focus elsewhere does not let the notice take it; it opens once the field is empty', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withNotices([]) });
  await field(page).fill('Tell me about the chart');
  await field(page).blur();
  await deliver(page);
  await settleMs(page);
  await expect(dialog(page)).toHaveCount(0);
  await field(page).fill('');
  await expect(dialog(page)).toBeVisible();
});

// spec: add-wardrobe › New outfit notice screen › success × a riddle answer in the Diary's field
test('success × a riddle answer in the Diary\'s field: the notice waits for the field to be empty', async ({ page }) => {
  await openDiary(page, {}, { ...withNotices([]) });
  const riddle = page.getByLabel("What has hands but can't clap?");
  await riddle.fill('a clock');
  await deliver(page);
  await settleMs(page);
  await expect(dialog(page)).toHaveCount(0);
  await expect(riddle).toHaveValue('a clock');
  await riddle.fill('');
  await expect(dialog(page)).toBeVisible();
});

// spec: add-wardrobe › New outfit notice screen › success × the Clear memory dialog open
test('success × the Clear memory dialog open: the notice waits until the dialog closes', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withNotices([]) });
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  const clear = page.getByRole('alertdialog', { name: "Clear Pixel's memory?" });
  await expect(clear).toBeVisible();
  await deliver(page);
  await settleMs(page);
  await expect(dialog(page)).toHaveCount(0);
  await clear.getByRole('button', { name: 'Keep memory' }).click();
  await expect(clear).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();
});

// spec: add-wardrobe › New outfit notice screen › success × the owner on Wardrobe screen
test('success × the owner on Wardrobe screen: no notice there; it opens at the next Pet screen', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { auth: SIGNED_IN, worker: withNotices() });
  await page.locator('.ds-item button:not([disabled])').first().waitFor();
  await settleMs(page);
  await expect(dialog(page)).toHaveCount(0);
  await lookAgain(page);
  await settleMs(page);
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to Pixel' }).first().click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(dialog(page)).toBeVisible();
});

// spec: add-wardrobe › New outfit notice screen › success × the pet asleep
test('success × the pet asleep: the notice opens over the asleep Pet screen, the pet asleep in it, and «Wear it» works', async ({ page }) => {
  await openNotice(page, [SCARF], ASLEEP_PET);
  await expect(dialog(page).getByRole('img', { name: 'Pixel, asleep, wearing the Cozy scarf' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Wear it' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Pixel, asleep, wearing the Cozy scarf' })).toBeVisible();
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
  expect(await wears(page)).toEqual(['worker:wear:cozy-scarf']);
});

// spec: add-wardrobe › New outfit notice screen › success × a reload
test('success × a reload: the notice is gone, the item waits in the wardrobe', async ({ page }) => {
  await openNotice(page);
  await reloadHolding(page);
  await expect(field(page)).toBeVisible();
  await settleMs(page);
  await expect(dialog(page)).toHaveCount(0);
  expect(await seen(page)).toEqual([]);
  await page.getByRole('link', { name: 'Wardrobe' }).click();
  await expect(page.getByRole('button', { name: 'Wear Cozy scarf' })).toBeVisible();
});

// spec: add-wardrobe › New outfit notice screen › success × the session expiring
test('success × the session expiring: a tap on «Wear it» closes the notice and the page says the session ended; nothing is worn', async ({ page }) => {
  test.setTimeout(60_000);
  // the request itself meets the ended session
  await openNotice(page);
  await setWorker(page, { sessionExpired: true });
  await dialog(page).getByRole('button', { name: 'Wear it' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByText(SIGNED_OUT).first()).toBeVisible();
  await expect(pageWears(page, 'thinking-cap')).toHaveCount(1);
  // the session was known ended before the tap: nothing is sent
  await openNotice(page);
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await settleMs(page);
  await dialog(page).getByRole('button', { name: 'Wear it' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByText(SIGNED_OUT).first()).toBeVisible();
  expect(await wears(page)).toEqual([]);
});

// spec: add-wardrobe › New outfit notice screen › success × the pet given away
test('success × the pet given away: the page turns the guest\'s and the notice goes with it', async ({ page }) => {
  await openNotice(page);
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page.locator('.ds-only[inert]')).toHaveCount(0);
});

// spec: add-wardrobe › New outfit notice screen › success × the item already worn
test('success × the item already worn: «Wear it» changes nothing and the notice closes', async ({ page }) => {
  await openNotice(page, ['thinking-cap']);
  await expect(dialog(page).getByText('Pixel earned the Thinking cap for the first solved riddle.', { exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Wear it' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(pageWears(page, 'thinking-cap')).toHaveCount(1);
  expect(await wears(page)).toEqual(['worker:wear:thinking-cap']);
});

// spec: add-wardrobe › New outfit notice screen › error × Wear it unanswered
test('error × Wear it unanswered: the line in the text\'s place, the pet in its former outfit, «Later» alone with the focus', async ({ page }) => {
  await openNotice(page, [SCARF], {}, { wear: DOWN });
  await dialog(page).getByRole('button', { name: 'Wear it' }).click();
  await expect(errorLine(page)).toBeVisible();
  await expect(dialog(page).getByText(SCARF_LINE)).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Wear it' })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Later' })).toBeFocused();
  await expect(dialog(page).getByRole('status')).toHaveText(ERROR);
  await expect(dialog(page).getByRole('img', { name: 'Pixel, full, wearing the Thinking cap' })).toBeVisible();
  // the pet of the page behind wears it too: two pets in the cap, none in the scarf
  await expect(pageWears(page, 'thinking-cap')).toHaveCount(2);
  await expect(pageWears(page, SCARF)).toHaveCount(0);
});

// spec: add-wardrobe › New outfit notice screen › error × Later
test('error × Later: Later, Close, Esc and the scrim close it, the former outfit stays and the item waits in the wardrobe', async ({ page }) => {
  test.setTimeout(90_000);
  const closers: Record<string, (p: Page) => Promise<void>> = {
    Later: (p) => dialog(p).getByRole('button', { name: 'Later' }).click(),
    Close: (p) => dialog(p).getByRole('button', { name: 'Close' }).click(),
    Esc: (p) => p.keyboard.press('Escape'),
    scrim: (p) => p.locator('.ds-sheet__scrim').click({ position: { x: 4, y: 4 } }),
  };
  for (const [how, close] of Object.entries(closers)) {
    await openNotice(page, [SCARF], {}, { wear: DOWN });
    await dialog(page).getByRole('button', { name: 'Wear it' }).click();
    await expect(errorLine(page), how).toBeVisible();
    await close(page);
    await expect(dialog(page), how).toHaveCount(0);
    await expect(heading(page), how).toBeFocused();
    await expect(pageWears(page, 'thinking-cap'), how).toHaveCount(1);
  }
  await page.getByRole('link', { name: 'Wardrobe' }).click();
  await expect(page.getByRole('button', { name: 'Wear Cozy scarf' })).toBeVisible();
});

// spec: add-wardrobe › Earned outfit flow › наряд за серию × the notice on the open Pet screen
test('наряд за серию × the notice on the open Pet screen: the written streak item opens its notice on the screen that is open, with no reload', async ({ page }) => {
  await openPet(page);
  await page.evaluate(() => {
    (globalThis as { __stood?: boolean }).__stood = true;
  });
  await settleMs(page);
  await expect(dialog(page)).toHaveCount(0);
  await deliver(page);
  await expect(dialog(page).getByText(SCARF_LINE, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as { __stood?: boolean }).__stood)).toBe(true);
  expect(await seen(page)).toEqual(['worker:seenOutfit:cozy-scarf']);
});

// spec: add-wardrobe › Earned outfit flow › выдача записана позже
test('выдача записана позже: the streak is on the open Diary, the item is written later, and its notice comes at that moment with no reload', async ({ page }) => {
  await openDiary(page, {}, { ...withNotices([]) });
  await page.evaluate(() => {
    (globalThis as { __stood?: boolean }).__stood = true;
  });
  await settleMs(page);
  await expect(dialog(page)).toHaveCount(0);
  await deliver(page);
  await expect(dialog(page)).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  expect(await page.evaluate(() => (globalThis as { __stood?: boolean }).__stood)).toBe(true);
});

