import { expect, test, type Page } from '@playwright/test';
import { calls, lookAgain, openWardrobe, openWith, reloadHolding, setWardrobePet, setWorker, SIGNED_IN, WARDROBE_OWNS, wardrobeWorker } from './helpers';

const SHORT = 'Pixel needs a little more food before buying this.';
const PAUSED = "Shopping is paused on our side while we top up. Pixel's outfits still work.";
const FAILED = "That didn't go through. Nothing was spent — try again.";
const WEARING = 'Pixel is wearing the Smart glasses!';
const PHONE = { width: 390, height: 844 };
const NEWBORN = { stage: 'baby' as const, fullness: { state: 'hungry' as const, level: 0.25 }, worn: null };
const ASLEEP_PET = { fullness: { state: 'asleep' as const, level: 0 } };
const BUYS = ['Smart glasses', 'Bow tie', 'Headphones'];
/** the first poll while a purchase is on its way comes after 1.5 s, the ordinary one after 5 s */
const A_POLL = 3500;

const tile = (page: Page, name: string) => page.getByRole('button', { name });
const buy = (page: Page, name = 'Smart glasses') => tile(page, `Buy · 0.76¢ ${name}`);
const buying = (page: Page, name = 'Smart glasses') => tile(page, `Buying… ${name}`);
const line = (page: Page, text: string) => page.getByText(text, { exact: true }).and(page.locator(':not(.ds-hidden)'));
const wornAlt = (page: Page, item: string | null) => page.getByRole('img', { name: item === null ? 'Pixel, full' : `Pixel, full, wearing the ${item}` });
const buyCalls = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('worker:buy:'));
const reads = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:wardrobe').length;

/** The purchase lands as the server tells it: the chain holds the item, the pet wears it, the read gives its outcome. */
async function land(page: Page, item = 'smart-glasses', id = 'buy-1') {
  await setWardrobePet(page, { worn: item as 'smart-glasses' }, { outfits: [...WARDROBE_OWNS, item as 'smart-glasses'] });
  await setWorker(page, { wardrobe: { buying: null, outcome: { id, item, status: 'bought', code: null } } });
}
/** The server refused the purchase after the tap: the read gives its outcome, nothing was spent. */
async function refuse(page: Page, item = 'smart-glasses', id = 'buy-1') {
  await setWorker(page, { wardrobe: { buying: null, outcome: { id, item, status: 'failed', code: 'short' } } });
}

// spec: add-wardrobe › Wardrobe screen › empty × Buy on starter food
test('empty × Buy on starter food: every Buy is off, the food line describes it and a tap buys nothing', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker(NEWBORN, { outfits: [] }, { short: true }));
  await expect(page.getByText(SHORT).first()).toBeVisible();
  for (const name of [...BUYS, 'Party hat']) {
    await expect(buy(page, name)).toHaveAttribute('aria-disabled', 'true');
    await expect(buy(page, name)).toHaveAttribute('aria-describedby', 'buy-line');
  }
  await buy(page).click({ force: true });
  await page.waitForTimeout(300);
  expect(await buyCalls(page)).toEqual([]);
  await expect(buying(page)).toHaveCount(0);
});

// spec: add-wardrobe › Wardrobe screen › empty × Buy well fed
test('empty × Buy well fed: a pet with no outfit and food enough buys on one tap, «Buying…» and no confirmation', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker(NEWBORN, { outfits: [] }, { short: false }));
  await expect(page.getByText(SHORT)).toHaveCount(0);
  await buy(page, 'Party hat').click();
  await expect(buying(page, 'Party hat')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await buyCalls(page)).toEqual(['worker:buy:party-hat']);
});

// spec: add-wardrobe › Wardrobe screen › asleep × Buy
test('asleep × Buy: every Buy is off, described by the asleep line, and a tap buys nothing; Wear stays on', async ({ page }) => {
  await openWardrobe(page);
  await setWardrobePet(page, ASLEEP_PET);
  await lookAgain(page);
  await expect(page.getByText('Pixel fell asleep.', { exact: false }).first()).toBeVisible();
  for (const name of BUYS) {
    await expect(buy(page, name)).toHaveAttribute('aria-disabled', 'true');
    await expect(buy(page, name)).toHaveAttribute('aria-describedby', 'asleep-line');
  }
  await buy(page).click({ force: true });
  await page.waitForTimeout(300);
  expect(await buyCalls(page)).toEqual([]);
  await expect(tile(page, 'Wear Daisy crown')).toBeEnabled();
});

// spec: add-wardrobe › Outfit purchase flow › покупает
test('покупает: one tap, «Buying…» on that tile with no confirmation, the other Buys off with no line of their own; nothing is worn yet', async ({ page }) => {
  await openWardrobe(page);
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  await expect(buying(page)).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const name of ['Bow tie', 'Headphones']) {
    await expect(buy(page, name)).toHaveAttribute('aria-disabled', 'true');
    await expect(buy(page, name)).not.toHaveAttribute('aria-describedby', /./);
  }
  await expect(page.getByRole('status').filter({ hasText: 'Buying…' }).first()).toBeAttached();
  await expect(wornAlt(page, 'Thinking cap')).toBeVisible();
  expect(await buyCalls(page)).toEqual(['worker:buy:smart-glasses']);
});

// spec: add-wardrobe › Outfit purchase flow › покупает × a second tap
test('покупает × a second tap: the tile and the other Buys take no second tap, and one purchase is sent', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker({}, {}, {}, { buyDelayMs: 1200 }));
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  await buying(page).click({ force: true });
  await buy(page, 'Bow tie').click({ force: true });
  await expect(buying(page)).toBeVisible();
  await page.waitForTimeout(1500);
  await buying(page).click({ force: true });
  await buy(page, 'Headphones').click({ force: true });
  expect(await buyCalls(page)).toEqual(['worker:buy:smart-glasses']);
});

// spec: add-wardrobe › Outfit purchase flow › покупает × the other Buys, Wear, Take off, Back
test('покупает × the other Buys, Wear, Take off, Back: the other Buys are off; Wear, Take off, Back and Account work while it goes on', async ({ page }) => {
  await openWardrobe(page);
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  await buy(page, 'Bow tie').click({ force: true });
  expect(await buyCalls(page)).toEqual(['worker:buy:smart-glasses']);
  await tile(page, 'Wear Daisy crown').click();
  await expect(tile(page, 'Take off Daisy crown')).toBeVisible();
  await tile(page, 'Take off Daisy crown').click();
  await expect(tile(page, 'Wear Daisy crown')).toBeVisible();
  await expect(buying(page)).toBeVisible();
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Back to Pixel' }).first().click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-wardrobe › Outfit purchase flow › покупает × a reload
test('покупает × a reload: «Buying…» stands on that tile from the server\'s row, no line from before; the purchase then lands and the reloaded tab draws «is wearing…» like the one that tapped', async ({ page }) => {
  await openWardrobe(page);
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  await reloadHolding(page);
  await expect(buying(page)).toBeVisible();
  await expect(buy(page, 'Bow tie')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText(WEARING)).toHaveCount(0);
  await land(page);
  await expect(tile(page, 'Take off Smart glasses')).toBeVisible();
  await expect(wornAlt(page, 'Smart glasses')).toBeVisible();
  // the reloaded tab saw the purchase in `buying`, so it watches it: the same line as the tab that tapped (`куплено` has no exception)
  await expect(line(page, WEARING)).toBeVisible();
});

// spec: add-wardrobe › Outfit purchase flow › покупает × Back, then the Wardrobe again
test('покупает × Back, then the Wardrobe again: «Buying…» comes back on that tile from the server\'s row', async ({ page }) => {
  await openWardrobe(page);
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  await page.getByRole('link', { name: 'Back to Pixel' }).first().click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await page.getByRole('link', { name: 'Wardrobe' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/wardrobe$/);
  await expect(buying(page)).toBeVisible();
  await expect(buy(page, 'Bow tie')).toHaveAttribute('aria-disabled', 'true');
  expect(await buyCalls(page)).toEqual(['worker:buy:smart-glasses']);
});

// spec: add-wardrobe › Outfit purchase flow › покупает × the tab hidden and back
test('покупает × the tab hidden and back: no read while it is hidden, one at once on return', async ({ page }) => {
  await openWardrobe(page);
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  await page.waitForTimeout(300);
  const hiddenAt = await reads(page);
  await land(page);
  await page.waitForTimeout(A_POLL - 500);
  expect(await reads(page)).toBe(hiddenAt);
  await expect(buying(page)).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(tile(page, 'Take off Smart glasses')).toBeVisible({ timeout: 700 });
});

// spec: add-wardrobe › Outfit purchase flow › покупает × outcome unknown on screen
test('покупает × outcome unknown on screen: «Buying…» stands as long as the server holds the row, read every 1.5 s, and the pet is still its own', async ({ page }) => {
  await openWardrobe(page);
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  const from = await reads(page);
  await page.waitForTimeout(A_POLL);
  await expect(buying(page)).toBeVisible();
  expect(await reads(page)).toBeGreaterThanOrEqual(from + 2);
  await expect(buy(page, 'Bow tie')).toHaveAttribute('aria-disabled', 'true');
  await expect(wornAlt(page, 'Thinking cap')).toBeVisible();
  await expect(page.getByText(FAILED)).toHaveCount(0);
  await land(page);
  await expect(tile(page, 'Take off Smart glasses')).toBeVisible();
});

// spec: add-wardrobe › Outfit purchase flow › куплено
test('куплено: «{name} is wearing the {item}!» under the pet, the item among the own ones with «Take off», the pet in it at once', async ({ page }) => {
  await openWardrobe(page);
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  await land(page);
  await expect(line(page, WEARING)).toBeVisible();
  await expect(tile(page, 'Take off Smart glasses')).toBeVisible();
  await expect(buy(page)).toHaveCount(0);
  await expect(wornAlt(page, 'Smart glasses')).toBeVisible();
  await expect(tile(page, 'Wear Thinking cap')).toBeVisible();
  // the other Buys are on again, the price is not on the bought tile
  await expect(buy(page, 'Bow tie')).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-wardrobe › Outfit purchase flow › куплено × the focus and the scroll
test('куплено × the focus and the scroll: the page goes up to the pet and the focus moves to the line under it, which the live region does not say again', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openWardrobe(page);
  await buy(page).scrollIntoViewIfNeeded();
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await land(page);
  const said = page.getByText(WEARING, { exact: true });
  await expect(said).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(said).toHaveCount(1);
});

// spec: add-wardrobe › Outfit purchase flow › куплено × the outcome line and the next action
test('куплено × the outcome line and the next action: the line goes at the next Wear, Take off or Buy', async ({ page }) => {
  for (const next of ['Wear Daisy crown', 'Take off Smart glasses', 'Buy · 0.76¢ Bow tie']) {
    await openWardrobe(page);
    await buy(page).click();
    await expect(buying(page)).toBeVisible();
    await land(page);
    await expect(line(page, WEARING)).toBeVisible();
    await tile(page, next).click();
    await expect(line(page, WEARING)).toHaveCount(0);
  }
});

// spec: add-wardrobe › Outfit purchase flow › куплено × the outcome line and a reload
test('куплено × the outcome line and a reload: the line is the tab\'s memory, a reload brings the result only', async ({ page }) => {
  await openWardrobe(page);
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  await land(page);
  await expect(line(page, WEARING)).toBeVisible();
  await reloadHolding(page);
  await expect(tile(page, 'Take off Smart glasses')).toBeVisible();
  await expect(page.getByText(WEARING)).toHaveCount(0);
});

// spec: add-wardrobe › Outfit purchase flow › не прошло × Try again
test('не прошло × Try again: «Try again» in that Buy\'s place with the line across the grid, the focus on it; a tap buys again and the line goes', async ({ page }) => {
  await openWardrobe(page);
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  await refuse(page);
  const again = tile(page, 'Try again Smart glasses');
  await expect(again).toBeVisible();
  await expect(line(page, FAILED)).toBeVisible();
  await expect(again).toHaveAttribute('aria-describedby', 'buy-failed');
  // the focus stays on the tile's button, which now says «Try again»
  await expect(again).toBeFocused();
  await expect(wornAlt(page, 'Thinking cap')).toBeVisible();
  await expect(tile(page, 'Take off Smart glasses')).toHaveCount(0);
  await again.click();
  await expect(buying(page)).toBeVisible();
  await expect(line(page, FAILED)).toHaveCount(0);
  expect(await buyCalls(page)).toEqual(['worker:buy:smart-glasses', 'worker:buy:smart-glasses']);
});

// spec: add-wardrobe › Outfit purchase flow › не прошло × the item already on chain
test('не прошло × the item already on chain: the line first, then the item among the own ones and the line goes with its tile', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker({}, {}, {}, { buy: { fail: { status: 409, code: 'owned' } } }));
  await buy(page).click();
  await expect(line(page, FAILED)).toBeVisible();
  await expect(tile(page, 'Try again Smart glasses')).toBeVisible();
  await expect(buying(page)).toHaveCount(0);
  // the other tab's purchase landed: the next poll moves the tile
  await land(page);
  await expect(tile(page, 'Take off Smart glasses')).toBeVisible();
  await expect(line(page, FAILED)).toHaveCount(0);
  await expect(tile(page, 'Try again Smart glasses')).toHaveCount(0);
});

// spec: add-wardrobe › Outfit purchase flow › не прошло × a reload
test('не прошло × a reload: the failed line is the tab\'s memory, a reload brings «Buy · {price}» back', async ({ page }) => {
  await openWardrobe(page);
  await buy(page).click();
  await expect(buying(page)).toBeVisible();
  await refuse(page);
  await expect(line(page, FAILED)).toBeVisible();
  await reloadHolding(page);
  await expect(buy(page)).toBeVisible();
  await expect(page.getByText(FAILED)).toHaveCount(0);
});

// spec: add-wardrobe › Outfit purchase flow › мало еды × the screen
test('мало еды × the screen: the food line above the Buy items, every Buy off and described by it, nothing sent; it lifts when the food is enough', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker({}, {}, { short: true }));
  await expect(page.getByText(SHORT).first()).toBeVisible();
  for (const name of BUYS) {
    await expect(buy(page, name)).toHaveAttribute('aria-disabled', 'true');
    await expect(buy(page, name)).toHaveAttribute('aria-describedby', 'buy-line');
  }
  await buy(page).click({ force: true });
  await page.waitForTimeout(300);
  expect(await buyCalls(page)).toEqual([]);
  await setWorker(page, { wardrobe: { short: false } });
  await lookAgain(page);
  await expect(page.getByText(SHORT)).toHaveCount(0);
  await expect(buy(page)).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-wardrobe › Outfit purchase flow › мало еды × Wear
test('мало еды × Wear: Wear and Take off work while the Buys are off', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker({}, {}, { short: true }));
  await tile(page, 'Wear Daisy crown').click();
  await expect(tile(page, 'Take off Daisy crown')).toBeVisible();
  await tile(page, 'Take off Daisy crown').click();
  await expect(tile(page, 'Wear Daisy crown')).toBeVisible();
  await expect(page.getByText(SHORT).first()).toBeVisible();
});

// spec: add-wardrobe › Outfit purchase flow › покупки на паузе × Wear and Take off
test('покупки на паузе × Wear and Take off: the line at the top of the list, every Buy off and described by it; Wear and Take off work', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker({}, {}, { shopPaused: true }));
  await expect(line(page, PAUSED)).toBeVisible();
  for (const name of BUYS) {
    await expect(buy(page, name)).toHaveAttribute('aria-disabled', 'true');
    await expect(buy(page, name)).toHaveAttribute('aria-describedby', 'paused-line');
  }
  await buy(page).click({ force: true });
  await page.waitForTimeout(300);
  expect(await buyCalls(page)).toEqual([]);
  await tile(page, 'Wear Daisy crown').click();
  await expect(tile(page, 'Take off Daisy crown')).toBeVisible();
  await tile(page, 'Take off Daisy crown').click();
  await expect(tile(page, 'Wear Daisy crown')).toBeVisible();
});

// spec: add-wardrobe › Outfit purchase flow › покупки на паузе
test('покупки на паузе: a pause that starts after the tap shows the pause line and nothing is spent', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker({}, {}, {}, { buy: { fail: { status: 409, code: 'paused' } }, buyDelayMs: 800 }));
  await buy(page).click();
  await setWorker(page, { wardrobe: { shopPaused: true } });
  await expect(line(page, PAUSED)).toBeVisible();
  expect(await buyCalls(page)).toEqual(['worker:buy:smart-glasses']);
  await expect(page.getByText(FAILED)).toHaveCount(0);
  await expect(buying(page)).toHaveCount(0);
  for (const name of BUYS) await expect(buy(page, name)).toHaveAttribute('aria-describedby', 'paused-line');
});

// spec: add-wardrobe › Outfit purchase flow › покупает
test('покупает: the answer that never came leaves the connection line and no «Buying…» until a read holds the purchase', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { auth: SIGNED_IN, worker: wardrobeWorker({}, {}, {}, { buy: { fail: { status: 0, code: 'unreachable' } } }) });
  await page.locator('.ds-item button:not([disabled])').first().waitFor();
  await buy(page).click();
  await expect(page.getByText("Can't reach Pixel right now. Nothing's lost — try again in a moment.").first()).toBeVisible();
  await expect(buying(page)).toHaveCount(0);
  await expect(line(page, FAILED)).toHaveCount(0);
  await expect(buy(page)).toBeVisible();
});
