import { expect, test, type Page } from '@playwright/test';
import { calls, lookAgain, openWardrobe, openWith, setWardrobePet, setWorker, SIGNED_IN, wardrobeWorker } from './helpers';

const OFFLINE = "Can't reach Pixel right now. Nothing's lost — try again in a moment.";
const EMPTY = 'Nothing to wear yet! Pixel earns outfits for daily rituals and riddles — and a well-fed Pixel can buy one below.';
const SHORT = 'Pixel needs a little more food before buying this.';
const ASLEEP = 'Pixel fell asleep. A meal will wake Pixel up — you can still change outfits.';
const OPENING = "Opening Pixel's wardrobe…";
const ERROR = "We couldn't open Pixel's wardrobe right now. Try again in a moment.";
const SIGNED_OUT = "You've been signed out. Sign in to get back to Pixel's wardrobe.";
const DOWN = { fail: { status: 0, code: 'unreachable' } };
const FOREVER = 3_600_000;
const NEWBORN = { stage: 'baby' as const, fullness: { state: 'hungry' as const, level: 0.25 }, worn: null };
const PHONE = { width: 390, height: 844 };
const ASLEEP_PET = { fullness: { state: 'asleep' as const, level: 0 } };

const tile = (page: Page, name: string) => page.getByRole('button', { name });
const tiles = (page: Page) => page.locator('.ds-item');
const wornAlt = (page: Page, item: string | null) => page.getByRole('img', { name: item === null ? 'Pixel, full' : `Pixel, full, wearing the ${item}` });
const wearCalls = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('worker:wear:') || c.startsWith('worker:buy:'));
/** The session ends under the open page; the next look of the page finds it. */
const endSession = async (page: Page) => {
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
};
const petStateCalls = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:petState').length;

/** «Back to Pixel» and «Account» work in this state of the screen */
async function headerWorks(page: Page) {
  await expect(page.getByRole('link', { name: 'Back to Pixel' }).first()).toHaveAttribute('href', '/pet/9');
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}
/** «Pause motion» works: the label names the action and the choice flips */
async function motionToggles(page: Page) {
  await page.getByRole('button', { name: 'Pause motion' }).click();
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  await page.getByRole('button', { name: 'Play motion' }).click();
  await expect(page.getByRole('button', { name: 'Pause motion' })).toBeVisible();
}

// spec: add-wardrobe › Wardrobe screen › success
test('success: the own items with «Wear», the worn one with «Take off», the conditions, «Buy · {price}», the pet in what it wears', async ({ page }) => {
  await openWardrobe(page);
  await expect(page.getByRole('heading', { level: 1, name: "Pixel's wardrobe" })).toBeAttached();
  await expect(tile(page, 'Wear Daisy crown')).toBeVisible();
  await expect(tile(page, 'Take off Thinking cap')).toBeVisible();
  await expect(tile(page, 'Wear Party hat')).toBeVisible();
  await expect(page.getByText('Reach a 3-day streak')).toBeVisible();
  await expect(tile(page, 'Buy · 0.76¢ Smart glasses')).toBeVisible();
  await expect(tile(page, 'Buy · 0.76¢ Bow tie')).toBeVisible();
  await expect(tile(page, 'Buy · 0.76¢ Headphones')).toBeVisible();
  await expect(tiles(page)).toHaveCount(7);
  await expect(wornAlt(page, 'Thinking cap')).toBeVisible();
});

// spec: add-wardrobe › Wardrobe screen › success × controls
test('success × controls: «Back to Pixel» and Account work; Tab goes through the actions in the list\'s order and a condition takes no stop', async ({ page }) => {
  await openWardrobe(page);
  await headerWorks(page);
  await tile(page, 'Wear Daisy crown').focus();
  const order = ['Take off Thinking cap', 'Wear Party hat', 'Buy · 0.76¢ Smart glasses', 'Buy · 0.76¢ Bow tie', 'Buy · 0.76¢ Headphones'];
  for (const name of order) {
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveAccessibleName(name);
  }
});

// spec: add-wardrobe › Wardrobe screen › success × Pause motion
test('success × Pause motion: the same choice and the same store as the Pet screen, kept going back', async ({ page }) => {
  await openWardrobe(page);
  await motionToggles(page);
  await page.getByRole('button', { name: 'Pause motion' }).click();
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Pixel' }).first().click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
});

// spec: add-wardrobe › Wardrobe screen › success × the rail's Wardrobe
test('success × the rail\'s Wardrobe: «Wardrobe» of an awake pet opens the screen in the app, with no page load; an asleep pet has no such link', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: wardrobeWorker() });
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await page.evaluate(() => ((globalThis as { __STAYED__?: boolean }).__STAYED__ = true));
  await page.getByRole('link', { name: 'Wardrobe' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/wardrobe$/);
  await expect(page.getByRole('heading', { level: 1, name: "Pixel's wardrobe" })).toBeAttached();
  await expect(tile(page, 'Take off Thinking cap')).toBeVisible();
  expect(await page.evaluate(() => (globalThis as { __STAYED__?: boolean }).__STAYED__)).toBe(true);
  await page.getByRole('link', { name: 'Back to Pixel' }).first().click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await setWardrobePet(page, ASLEEP_PET);
  await lookAgain(page);
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Wardrobe' })).toHaveCount(0);
});

// spec: add-wardrobe › Wardrobe screen › empty × controls
test('empty × controls: «Back to Pixel», Account and «Pause motion» work; every «Buy · {price}» is off and the food line describes it', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker(NEWBORN, { outfits: [] }, { short: true }));
  await expect(page.getByText(EMPTY)).toBeVisible();
  await expect(page.getByText(SHORT).first()).toBeVisible();
  await expect(page.getByText('Reach a 1-day streak')).toBeVisible();
  await expect(page.getByText('Solve your first riddle')).toBeVisible();
  for (const name of ['Smart glasses', 'Bow tie', 'Headphones', 'Party hat']) {
    const buy = tile(page, `Buy · 0.76¢ ${name}`);
    await expect(buy).toHaveAttribute('aria-disabled', 'true');
    await expect(buy).toHaveAttribute('aria-describedby', 'buy-line');
  }
  await expect(page.getByRole('img', { name: 'Pixel, hungry' })).toBeVisible();
  await headerWorks(page);
  await motionToggles(page);
});

// spec: add-wardrobe › Wardrobe screen › loading × controls
test('loading × controls: «Opening Pixel\'s wardrobe…», «Wear», «Take off» and «Buy · {price}» disabled; «Back to Pixel», Account and «Pause motion» work', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { auth: SIGNED_IN, worker: wardrobeWorker({}, {}, {}, { wardrobeDelayMs: FOREVER }) });
  await expect(page.getByRole('status').filter({ hasText: OPENING }).first()).toBeVisible();
  for (const name of ['Wear Daisy crown', 'Take off Thinking cap', 'Wear Party hat', 'Buy · 0.76¢ Smart glasses']) await expect(tile(page, name)).toBeDisabled();
  await expect(wornAlt(page, 'Thinking cap')).toBeVisible();
  await headerWorks(page);
  await motionToggles(page);
});

// spec: add-wardrobe › Wardrobe screen › error × Try again
test('error × Try again: the read again; success replaces the line and the tiles come', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { auth: SIGNED_IN, worker: wardrobeWorker({}, {}, DOWN) });
  await expect(page.getByText(ERROR)).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);
  await setWorker(page, { wardrobe: {} });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(tile(page, 'Take off Thinking cap')).toBeVisible();
  await expect(page.getByText(ERROR)).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(7);
});

// spec: add-wardrobe › Wardrobe screen › error × the last known outfit
test('error × the last known outfit: the pet stands in what it last wore, with no tile', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { auth: SIGNED_IN, worker: wardrobeWorker({}, {}, DOWN) });
  await expect(page.getByText(ERROR)).toBeVisible();
  await expect(wornAlt(page, 'Thinking cap')).toBeVisible();
});

// spec: add-wardrobe › Wardrobe screen › error × controls
test('error × controls: «Back to Pixel», Account and «Pause motion» work, and no tile is there', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { auth: SIGNED_IN, worker: wardrobeWorker({}, {}, DOWN) });
  await expect(page.getByText(ERROR)).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);
  await headerWorks(page);
  await motionToggles(page);
});

// spec: add-wardrobe › Wardrobe screen › error × a failed poll over a shown wardrobe
test('error × a failed poll over a shown wardrobe: the connection line over the tiles, not the error page', async ({ page }) => {
  await openWardrobe(page);
  await setWorker(page, { wardrobe: DOWN });
  await lookAgain(page);
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  await expect(page.getByText(ERROR)).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(7);
  await expect(tile(page, 'Take off Thinking cap')).toBeVisible();
});

// spec: add-wardrobe › Wardrobe screen › success × a visitor at the address
test('success × a visitor at the address: the Pet screen for them, the address kept, no wardrobe', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { worker: wardrobeWorker() });
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/9\/wardrobe$/);
  await expect(tiles(page)).toHaveCount(0);
  expect((await calls(page)).filter((c) => c === 'worker:wardrobe')).toEqual([]);
});

// spec: add-wardrobe › Wardrobe screen › success × a guest at the address
test('success × a guest at the address: the Pet screen of a stranger\'s pet, the address kept, the wardrobe not read', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { auth: SIGNED_IN, worker: wardrobeWorker({}, {}, {}, { owned: [] }) });
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/9\/wardrobe$/);
  await expect(tiles(page)).toHaveCount(0);
  expect((await calls(page)).filter((c) => c === 'worker:wardrobe')).toEqual([]);
});

// spec: add-wardrobe › Wardrobe screen › success × the owner's sign-in from the address
test('success × the owner\'s sign-in from the address: «Sign in» on the visitor\'s page brings the owner back to Wardrobe screen', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { worker: wardrobeWorker() });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/wardrobe$/);
  await expect(page.getByRole('heading', { level: 1, name: "Pixel's wardrobe" })).toBeAttached();
  await expect(tile(page, 'Take off Thinking cap')).toBeVisible();
});

// spec: add-wardrobe › Wardrobe screen › success × an asleep pet at the address
test('success × an asleep pet at the address: its Pet screen, at its own address', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { auth: SIGNED_IN, worker: wardrobeWorker(ASLEEP_PET) });
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);
});

// spec: add-wardrobe › Wardrobe screen › success × the Pet screen's draft there and back
test('success × the Pet screen\'s draft there and back: what was typed in the field is there when «Back to Pixel» returns', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: wardrobeWorker() });
  const field = page.getByPlaceholder('Talk to Pixel…');
  await field.fill('And if they ask why?');
  await page.getByRole('link', { name: 'Wardrobe' }).click();
  await expect(tile(page, 'Take off Thinking cap')).toBeVisible();
  await page.getByRole('link', { name: 'Back to Pixel' }).first().click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveValue('And if they ask why?');
});

// spec: add-wardrobe › Wardrobe screen › success × Feed sheet open on the rail's Wardrobe
test('success × Feed sheet open on the rail\'s Wardrobe: on the desktop the sheet stays beside the Wardrobe', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: wardrobeWorker() });
  await page.getByRole('button', { name: 'Feed Pixel' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Feed Pixel' })).toBeVisible();
  await page.getByRole('link', { name: 'Wardrobe' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/wardrobe$/);
  await expect(tile(page, 'Take off Thinking cap')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Feed Pixel' })).toBeVisible();
});

// spec: add-wardrobe › Wardrobe screen › signed-out × Sign in
test('signed-out × Sign in: «Sign in» returns the owner to the same Wardrobe screen, signed in', async ({ page }) => {
  await openWardrobe(page);
  await endSession(page);
  await tile(page, 'Wear Daisy crown').click();
  await expect(page.getByText(SIGNED_OUT).first()).toBeVisible();
  await setWorker(page, { sessionExpired: false });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/wardrobe$/);
  await expect(page.getByText(SIGNED_OUT)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await expect(tile(page, 'Take off Thinking cap')).toBeVisible();
});

// spec: add-wardrobe › Wardrobe screen › signed-out × Wear, Take off, Buy
test('signed-out × Wear, Take off, Buy: each tap shows the line, sends nothing, takes the page to the column\'s top and the focus to «Sign in»', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openWardrobe(page);
  await endSession(page);
  for (const name of ['Wear Daisy crown', 'Take off Thinking cap', 'Buy · 0.76¢ Smart glasses']) {
    await tile(page, name).scrollIntoViewIfNeeded();
    await tile(page, name).click();
    await expect(page.getByText(SIGNED_OUT).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
  expect(await wearCalls(page)).toEqual([]);
  // nothing worn: the pet and the tiles are as they were
  await expect(wornAlt(page, 'Thinking cap')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
});

// spec: add-wardrobe › Wardrobe screen › signed-out × no tap yet
test('signed-out × no tap yet: a session that ended changes nothing on the page, and its polls stop', async ({ page }) => {
  await openWardrobe(page);
  const before = await petStateCalls(page);
  await endSession(page);
  await expect.poll(() => petStateCalls(page)).toBeGreaterThan(before);
  await expect(page.getByText(SIGNED_OUT)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(tile(page, 'Take off Thinking cap')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  const reads = async () => (await calls(page)).filter((c) => c === 'worker:wardrobe').length;
  const stopped = await reads();
  await lookAgain(page);
  await page.waitForTimeout(300);
  expect(await reads()).toBe(stopped);
});

// spec: add-wardrobe › Wardrobe screen › asleep × controls
test('asleep × controls: the line, «Back to Pixel» in it and in the header, Account; every Buy off and described by the line, no food line', async ({ page }) => {
  await openWardrobe(page);
  await setWardrobePet(page, ASLEEP_PET);
  await lookAgain(page);
  await expect(page.getByText(ASLEEP).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toHaveCount(2);
  for (const name of ['Smart glasses', 'Bow tie', 'Headphones']) {
    const buy = tile(page, `Buy · 0.76¢ ${name}`);
    await expect(buy).toHaveAttribute('aria-disabled', 'true');
    await expect(buy).toHaveAttribute('aria-describedby', 'asleep-line');
  }
  await expect(page.getByText(SHORT)).toHaveCount(0);
  await headerWorks(page);
  await motionToggles(page);
  await page.getByRole('link', { name: 'Back to Pixel' }).last().click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
});

// spec: add-wardrobe › Earned outfit flow › выдача записана позже × the condition until it is written
test('выдача записана позже × the condition until it is written: the tile shows its condition, then «Wear» with no reload when the chain holds the item', async ({ page }) => {
  await openWardrobe(page);
  await page.evaluate(() => ((globalThis as { __STAYED__?: boolean }).__STAYED__ = true));
  await expect(page.getByText('Reach a 3-day streak')).toBeVisible();
  await expect(tile(page, 'Wear Cozy scarf')).toHaveCount(0);
  await setWardrobePet(page, {}, { outfits: ['daisy-crown', 'cozy-scarf', 'thinking-cap', 'party-hat'] });
  await lookAgain(page);
  await expect(tile(page, 'Wear Cozy scarf')).toBeVisible();
  await expect(page.getByText('Reach a 3-day streak')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as { __STAYED__?: boolean }).__STAYED__)).toBe(true);
});

// The pet wakes under the open Wardrobe. The clock is paused, so no poll runs: what the page reads, it reads for the wake.
const NOON = new Date('2026-11-01T12:00:00Z');
const wardrobeReads = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:wardrobe').length;
const buyIsOn = (page: Page, name: string) => tile(page, `Buy · 0.76¢ ${name}`);

/** The Wardrobe stands with its pet asleep; with `sheet` the Feed sheet stands beside it (the desktop), asleep with a snack ready. */
async function sleepsUnderWardrobe(page: Page, { sheet = false, wardrobe = {} }: { sheet?: boolean; wardrobe?: Record<string, unknown> } = {}) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install({ time: NOON });
  const worker = wardrobeWorker({}, {}, wardrobe, { feedSheet: { fullness: ASLEEP_PET.fullness, snack: { state: 'ready' } } });
  if (sheet) {
    await openWith(page, '/pet/9', { auth: SIGNED_IN, worker });
    await page.getByRole('button', { name: 'Feed Pixel' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Feed Pixel' })).toBeVisible();
    await page.getByRole('link', { name: 'Wardrobe' }).click();
    await expect(tile(page, 'Take off Thinking cap')).toBeVisible();
  } else {
    await openWardrobe(page, worker);
  }
  await setWardrobePet(page, ASLEEP_PET);
  await lookAgain(page);
  await expect(page.getByText(ASLEEP).first()).toBeVisible();
  await page.clock.pauseAt(new Date('2026-11-01T12:01:00Z'));
}

// spec: add-wardrobe › Wardrobe screen › проснулся при открытом экране
// spec: add-wardrobe › Wardrobe screen › проснулся при открытом экране × the food read at once
test('проснулся при открытом экране × a meal in this tab: no reload, the sleep line goes, every Buy comes on, and the food is read once, at once', async ({ page }) => {
  await sleepsUnderWardrobe(page, { sheet: true });
  await expect(buyIsOn(page, 'Bow tie')).toHaveAttribute('aria-disabled', 'true');
  await page.evaluate(() => ((globalThis as { __STAYED__?: boolean }).__STAYED__ = true));
  const before = await wardrobeReads(page);
  await setWardrobePet(page, {});
  await page.getByRole('dialog', { name: 'Feed Pixel' }).getByRole('button', { name: 'Give a free snack' }).click();
  await expect(page.getByText(ASLEEP)).toHaveCount(0);
  for (const name of ['Smart glasses', 'Bow tie', 'Headphones']) await expect(buyIsOn(page, name)).not.toHaveAttribute('aria-disabled', 'true');
  expect(await wardrobeReads(page)).toBe(before + 1);
  expect(await page.evaluate(() => (globalThis as { __STAYED__?: boolean }).__STAYED__)).toBe(true);
});

// spec: add-wardrobe › Wardrobe screen › проснулся при открытом экране × a wake by earnings
// spec: add-wardrobe › Wardrobe screen › проснулся при открытом экране × the food read at once
test('проснулся при открытом экране × a wake by earnings: only /state moves, no tap and no friend, and the food is read at once', async ({ page }) => {
  await sleepsUnderWardrobe(page);
  const before = await wardrobeReads(page);
  await setWardrobePet(page, {}, { wakes: 4 });
  await setWorker(page, { petState: { wakes: 4 } });
  await lookAgain(page);
  await expect(page.getByText(ASLEEP)).toHaveCount(0);
  for (const name of ['Smart glasses', 'Bow tie', 'Headphones']) await expect(buyIsOn(page, name)).not.toHaveAttribute('aria-disabled', 'true');
  // the look at the wardrobe that every return makes, and the read the wake asks for: without the second, it would be one
  expect(await wardrobeReads(page)).toBeGreaterThanOrEqual(before + 2);
  const all = await calls(page);
  expect(all.filter((c) => /snack|buildFeed|sendFeed|worker:buy:|worker:wear:/.test(c))).toEqual([]);
});

// spec: add-wardrobe › Wardrobe screen › проснулся при открытом экране × still short of food
test('проснулся при открытом экране × still short of food: the sleep line goes, the food line stands above the Buy items and describes each of them', async ({ page }) => {
  await sleepsUnderWardrobe(page, { sheet: true, wardrobe: { short: true } });
  await setWardrobePet(page, {});
  await page.getByRole('dialog', { name: 'Feed Pixel' }).getByRole('button', { name: 'Give a free snack' }).click();
  await expect(page.getByText(ASLEEP)).toHaveCount(0);
  await expect(page.getByText(SHORT).first()).toBeVisible();
  for (const name of ['Smart glasses', 'Bow tie', 'Headphones']) {
    await expect(buyIsOn(page, name)).toHaveAttribute('aria-disabled', 'true');
    await expect(buyIsOn(page, name)).toHaveAttribute('aria-describedby', 'buy-line');
  }
  await expect(tile(page, 'Wear Daisy crown')).toBeVisible();
});

/** The page's own live region, the visually hidden one, holding `text`: what a screen reader says */
const liveRegion = (page: Page, text: string) => page.locator('p.ds-hidden[role="status"]', { hasText: text });

// spec: add-wardrobe › Wardrobe screen › signed-out
test('signed-out × the first read met the ended session: the line and «Sign in» come, not a page that stays on «Opening…»', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { auth: SIGNED_IN, worker: wardrobeWorker({}, {}, { fail: { status: 401, code: 'signed_out' } }) });
  await expect(page.getByText(SIGNED_OUT).first()).toBeVisible();
  await expect(page.getByText(OPENING)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
});

// spec: add-wardrobe › Wardrobe screen › signed-out
test('signed-out × the session ended under the error line: «Try again» finds it and the line comes', async ({ page }) => {
  await openWith(page, '/pet/9/wardrobe', { auth: SIGNED_IN, worker: wardrobeWorker({}, {}, DOWN) });
  await expect(page.getByText(ERROR)).toBeVisible();
  await endSession(page);
  await expect(page.getByText(SIGNED_OUT).first()).toBeVisible();
  await expect(page.getByText(ERROR)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

// spec: add-wardrobe › Wardrobe screen › проснулся при открытом экране × still short of food
test('success × the food line comes with the focus on a tile: the focus stays on that item, and the line is said', async ({ page }) => {
  await openWardrobe(page);
  await tile(page, 'Wear Daisy crown').focus();
  await setWorker(page, { wardrobe: { short: true } });
  await lookAgain(page);
  await expect(page.locator('#buy-line')).toHaveText(SHORT);
  await expect(tile(page, 'Wear Daisy crown')).toBeFocused();
  await expect(liveRegion(page, SHORT)).toHaveCount(1);
  await setWorker(page, { wardrobe: { short: false } });
  await lookAgain(page);
  await expect(page.locator('#buy-line')).toHaveCount(0);
  await expect(tile(page, 'Wear Daisy crown')).toBeFocused();
});

// spec: add-wardrobe › Wardrobe screen › error × a failed poll over a shown wardrobe
test('error × a failed poll over a shown wardrobe: the page\'s live region says the connection line, over a pause too', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker({}, {}, { shopPaused: true }));
  await setWorker(page, { wardrobe: { shopPaused: true, ...DOWN } });
  await lookAgain(page);
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  await expect(liveRegion(page, OFFLINE)).toHaveCount(1);
});
