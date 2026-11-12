import { expect, test, type Page } from '@playwright/test';
import {
  ASLEEP_PIXEL, BISCUIT, calls, inCard, lookAgain, openCard, openMore, openPet, openWith, OWNER, PIXEL, privyCalls, setWorker, SIGNED_IN,
} from './helpers';
import { verificationFakes } from './verification.fixtures';

// add-game-layout: the Pet Stage entries, the Pet card and the «More» menu, in the real client with the Worker, the RPC and
// Privy answered by the fakes. Each test carries the anchors of the Scenarios and the pairs it proves.

const wish = { item: 'smart-glasses' as const, reason: 'I want to see every tiny detail.', status: 'active' as const,
  reserveYocto: '660000000000000000000' };
const wishOwner = { wish, wishReserveYocto: wish.reserveYocto, wishActive: true };
const ME_PIXEL = { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };
const WEATHER = { ...BISCUIT, skill: { label: 'weather' } };
const GUEST = { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': WEATHER }, me: ME_PIXEL } };
const FORMER = 'Pixel has a new owner. You can still visit Pixel.';
const plate = (page: Page) => page.locator('.ds-hud__nameplate');
const card = (page: Page, name = 'Pixel') => page.getByRole('dialog', { name: `${name}'s card` });
const menu = (page: Page) => page.getByRole('menu', { name: 'More' });
const feedButton = (page: Page) => page.getByRole('button', { name: 'Feed Pixel' }).first();
const asleepWorker = (owner: Record<string, unknown> = {}) => ({ ...OWNER, pets: { '9': { ...ASLEEP_PIXEL, owner }, '2': BISCUIT } });
const READ_FAILS = { petResult: { fail: { status: 503, code: 'chain_unreachable' } } };

// ── Pet stage rule ───────────────────────────────────────────────────────────────────────────────────────────

// spec: add-game-layout › Pet stage rule › owner entries
test('owner entries: the nameplate shows the name and the stage and opens the card; the stage actions stay direct', async ({ page }) => {
  await openPet(page, { ownedCount: 2 });
  await expect(plate(page)).toContainText('Pixel');
  await expect(plate(page)).toContainText('Grown-up');
  await expect(feedButton(page)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute('href', '/pet/9/diary');
  await expect(page.getByRole('link', { name: 'Wardrobe' })).toHaveAttribute('href', '/pet/9/wardrobe');
  await expect(page.getByRole('button', { name: 'Send Pixel on an errand' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'More' })).toBeVisible();
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'My pets' })).toBeVisible();
  // the entries that moved are not on the stage
  await expect(page.getByRole('menuitem', { name: 'Give Pixel away' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Relationships' })).toHaveCount(0);
  await plate(page).click();
  await expect(card(page)).toBeVisible();
});

// spec: add-game-layout › Pet stage rule › owner entries
test('a short phone (390×650, an in-app browser under its chrome): «Feed Pixel» and the Hotbar stay inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 650 });
  await openPet(page);
  await expect(feedButton(page)).toBeVisible();
  const feed = (await feedButton(page).boundingBox())!;
  expect(feed.y).toBeGreaterThanOrEqual(0);
  expect(feed.y + feed.height).toBeLessThanOrEqual(650);
  const bar = (await page.getByRole('navigation', { name: 'Pet actions' }).boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(650 + 1);
  // scrolled to its end the page keeps the Hotbar in the same place
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const after = (await feedButton(page).boundingBox())!;
  expect(after.y + after.height).toBeLessThanOrEqual(650);
});

// spec: add-game-layout › Pet stage rule › owner entries
test('reduced motion cuts the Hud and Hotbar press scale', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPet(page);
  await plate(page).hover();
  await page.mouse.down();
  expect(await plate(page).evaluate((node) => getComputedStyle(node).transform)).toBe('none');
  await page.mouse.up();
  await card(page).getByRole('button', { name: 'Close' }).click();
  const more = page.getByRole('button', { name: 'More' });
  await more.hover();
  await page.mouse.down();
  expect(await more.locator('.ds-hotbar__disc').evaluate((node) => getComputedStyle(node).transform)).toBe('none');
  await page.mouse.up();
});

// spec: add-game-layout › Pet stage rule › asleep owner entries
test('asleep owner entries: Feed, More and the nameplate stay; the conversation is inactive; the shared errand keeps its route', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: asleepWorker() });
  await expect(feedButton(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'More' })).toBeEnabled();
  await expect(plate(page)).toContainText('Pixel');
  await expect(page.getByRole('button', { name: 'Ask friends to fund an errand' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Today' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Wardrobe' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send Pixel on an errand' })).toHaveCount(0);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: 'Ask friends to fund an errand' }).click();
  await expect(page.getByRole('dialog', { name: 'Send Pixel on an errand' })).toBeVisible();
});

// spec: add-game-layout › Pet stage rule › guest entries
test('guest entries: Feed and Check stay public, the nameplate opens the card; a visitor has them too and no More', async ({ page }) => {
  await openWith(page, '/pet/2', GUEST);
  await expect(page.getByRole('button', { name: 'Feed Biscuit' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: "Check it's really Biscuit" })).toHaveAttribute('href', '/pet/2/verify');
  await expect(page.getByRole('button', { name: 'More' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Go to your Pixel' })).toBeVisible();
  await plate(page).click();
  await expect(card(page, 'Biscuit')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  // a visitor without a session
  await page.goto('about:blank');
  await openWith(page, '/pet/2', { worker: { pets: { '2': BISCUIT, '9': PIXEL } } });
  await expect(page.getByRole('button', { name: 'Feed Biscuit' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: "Check it's really Biscuit" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'More' })).toHaveCount(0);
  await plate(page).click();
  await expect(card(page, 'Biscuit')).toBeVisible();
});

// the sheet over the Stage: it opens over the same pet, the stage goes out of reach, and closing brings the stage back
const sheetRound = async (page: Page, open: () => Promise<void>, sheet: RegExp | string, focused?: () => ReturnType<Page['locator']>) => {
  await open();
  const dialog = page.getByRole('dialog', { name: sheet });
  await expect(dialog).toBeVisible();
  await expect(plate(page)).toContainText('Pixel');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(plate(page)).toContainText('Pixel');
  if (focused) await expect(focused()).toBeFocused();
};

// spec: add-game-layout › Pet stage rule › owner entries × Feed sheet opens
// spec: add-game-layout › Pet stage rule › owner entries × Feed sheet closes
test('Feed sheet opens over the Stage and closes with the focus back on Feed', async ({ page }) => {
  await openPet(page);
  await sheetRound(page, () => feedButton(page).click(), 'Feed Pixel', () => feedButton(page));
});

// spec: add-game-layout › Pet stage rule › owner entries × Gift sheet opens
// spec: add-game-layout › Pet stage rule › owner entries × Gift sheet closes
test('Gift sheet opens from More over the Stage and closes', async ({ page }) => {
  await openPet(page, {}, { me: ME_PIXEL });
  await sheetRound(page, async () => { await openMore(page); await page.getByRole('menuitem', { name: 'Give Pixel away' }).click(); }, 'Give Pixel to a friend');
});

// spec: add-game-layout › Pet stage rule › owner entries × Errand sheet opens
// spec: add-game-layout › Pet stage rule › owner entries × Errand sheet closes
test('Errand sheet opens over the Stage and closes', async ({ page }) => {
  await openPet(page);
  await sheetRound(page, () => page.getByRole('button', { name: 'Send Pixel on an errand' }).click(), 'Send Pixel on an errand');
});

// spec: add-game-layout › Pet stage rule › owner entries × Share preview opens
// spec: add-game-layout › Pet stage rule › owner entries × Share preview closes
test('Share preview opens from the sharing choices over the Stage and closes', async ({ page }) => {
  await openPet(page);
  await sheetRound(page, async () => {
    await openMore(page);
    await page.getByRole('menuitem', { name: 'Share Pixel' }).click();
    await page.getByRole('menuitem', { name: 'Share a thought' }).click();
  }, 'Share a thought');
});

// spec: add-game-layout › Pet stage rule › owner entries × Diary opens
// spec: add-game-layout › Pet stage rule › owner entries × Diary closes
test('Diary opens from Today and a step back returns the Stage', async ({ page }) => {
  await openPet(page);
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(plate(page)).toContainText('Pixel');
  await expect(feedButton(page)).toBeVisible();
});

// spec: add-game-layout › Pet stage rule › owner entries × Wardrobe opens
// spec: add-game-layout › Pet stage rule › owner entries × Wardrobe closes
test('Wardrobe opens from its action and a step back returns the Stage', async ({ page }) => {
  await openPet(page);
  await page.getByRole('link', { name: 'Wardrobe' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/wardrobe$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(plate(page)).toContainText('Pixel');
});

// spec: add-game-layout › Pet stage rule › owner entries × Skill sheet opens
// spec: add-game-layout › Pet stage rule › owner entries × Skill sheet closes
test('Skill sheet opens from the card over the Stage and closes', async ({ page }) => {
  await openPet(page);
  await sheetRound(page, async () => { await openCard(page); await inCard(page).getByRole('button', { name: 'Teach Pixel a skill' }).click(); }, /skill/i);
});

// spec: add-game-layout › Pet stage rule › owner entries × Wish sheet opens
// spec: add-game-layout › Pet stage rule › owner entries × Wish sheet closes
test('Wish sheet opens from the card over the Stage and closes with the focus on the nameplate', async ({ page }) => {
  await openPet(page, wishOwner);
  await sheetRound(page, async () => { await openCard(page); await inCard(page).getByRole('link', { name: "Pixel's wish" }).click(); }, "Pixel's wish", () => plate(page));
});

// spec: add-game-layout › Pet stage rule › owner entries × Watch sheet opens
// spec: add-game-layout › Pet stage rule › owner entries × Watch sheet closes
test('Watch sheet opens from More over the Stage and closes', async ({ page }) => {
  await openPet(page);
  await sheetRound(page, async () => { await openMore(page); await page.getByRole('menuitem', { name: 'Watch something' }).click(); }, 'Watch something');
});

// spec: add-game-layout › Pet stage rule › owner entries × pending transaction and card
// spec: add-game-layout › Pet stage rule › owner entries × pending transaction and More
test('a thought on its way keeps standing while the card or More opens and closes', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await page.getByPlaceholder('Talk to Pixel…').fill('Tell me a story');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Pixel is thinking…').first()).toBeVisible();
  await openCard(page);
  await page.keyboard.press('Escape');
  await openMore(page);
  await page.keyboard.press('Escape');
  await expect(page.getByText('Pixel is thinking…').first()).toBeVisible();
  expect((await calls(page)).filter((call) => call === 'worker:say')).toHaveLength(1);
  await setWorker(page, { petState: { thought: { id: 'r1', text: 'Once there was a chart.', cut: null } } });
  await expect(page.getByText('Once there was a chart.').first()).toBeVisible();
  await expect(page.locator('.ds-hidden[role="status"]').filter({ hasText: 'Pixel: Once there was a chart.' })).toHaveCount(1);
});

// spec: add-game-layout › Pet stage rule › owner entries × newest reply
test('a long pet reply stays in the short phone Stage and its full words and receipt scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 650 });
  await openPet(page);
  await page.getByPlaceholder('Talk to Pixel…').fill('Tell me a long story');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await setWorker(page, { petState: { thought: { id: 'r-long', text: 'A'.repeat(2000), cut: null } } });
  const bubble = page.locator('.ds-stage__bubble');
  await expect(bubble).toBeVisible();
  const bounds = (await bubble.boundingBox())!;
  const world = (await page.locator('.ds-stage__world').boundingBox())!;
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(world.y + world.height + 1);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(await bubble.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  expect(await bubble.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await bubble.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const receipt = bubble.getByRole('link', { name: 'Check this thought' });
  await expect(receipt).toBeVisible();
  const receiptBox = (await receipt.boundingBox())!;
  expect(receiptBox.y + receiptBox.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
});

// spec: add-game-layout › Pet stage rule › owner entries × draft reply and card
// spec: add-game-layout › Pet stage rule › owner entries × draft reply and More
test('a typed draft survives the card and More opening and closing', async ({ page }) => {
  await openPet(page);
  const field = page.getByPlaceholder('Talk to Pixel…');
  await field.fill('half a line');
  await openCard(page);
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue('half a line');
  await openMore(page);
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue('half a line');
});

// spec: add-game-layout › Pet stage rule › owner entries × sign-in return place
test('a visitor opens the card, closes it and signs in: the return place is the pet, the card is closed', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { pets: { '2': BISCUIT, '9': PIXEL } } });
  await plate(page).click();
  await expect(card(page, 'Biscuit')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => privyCalls(page)).toContain('privy:login');
  await expect(card(page, 'Biscuit')).toHaveCount(0);
  await expect(page).toHaveURL(/\/pet\/2$/);
});

// spec: add-game-layout › Pet stage rule › owner entries × motion pause and card
// spec: add-game-layout › Pet stage rule › owner entries × motion pause and More
test('the motion pause stays while the card or More opens and closes', async ({ page }) => {
  await openPet(page);
  await page.getByRole('button', { name: 'Pause motion' }).click();
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  await openCard(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  await openMore(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
});

// ── Pet card screen ──────────────────────────────────────────────────────────────────────────────────────────

// spec: add-game-layout › Pet card screen › success (owner)
// spec: add-game-layout › Pet card screen › success (owner) × nameplate tap
// spec: add-game-layout › Pet card screen › success (owner) × Close
test('success (owner): the card shows growth, traits, Energy, the Seal line and the owner sections; the tap reads the pet afresh', async ({ page }) => {
  await openPet(page, { traits: ['clever', 'sociable'], energy: 7 });
  const reads = async () => (await calls(page)).filter((call) => call === 'worker:pet').length;
  const before = await reads();
  await openCard(page);
  await expect.poll(reads).toBeGreaterThan(before);
  const dialog = card(page);
  await expect(dialog.getByText('Pixel', { exact: true }).first()).toBeVisible();
  await expect(dialog.locator('.ds-pet-card__portrait [role="img"]')).toBeVisible();
  await expect(dialog.getByText('Grown-up')).toBeVisible();
  await expect(dialog.getByText('clever', { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(dialog.getByText('sociable', { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(dialog.getByRole('meter', { name: 'Energy' })).toHaveAttribute('aria-valuenow', '7');
  await expect(dialog.getByRole('link', { name: "Check it's really Pixel" })).toHaveAttribute('href', '/pet/9/verify');
  for (const section of ['Work', 'Friends', 'Wish']) await expect(dialog.getByRole('heading', { name: section })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(plate(page)).toBeFocused();
});

// spec: add-game-layout › Pet card screen › success (owner) × Escape
test('Escape closes the card and the focus is on the nameplate', async ({ page }) => {
  await openPet(page);
  await openCard(page);
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(plate(page)).toBeFocused();
});

// spec: add-game-layout › Pet card screen › success (Seal)
// spec: add-game-layout › Pet card screen › success (owner) × Check entry
test('success (Seal): the checked mark says what it checks and «Check it\'s really Pixel» goes to Verification', async ({ page }) => {
  const chain = verificationFakes();
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, verificationIndex: chain.worker!.verificationIndex }, rpc: chain.rpc });
  await openCard(page);
  await expect(card(page).getByText('This mark checks that Pixel has the character sealed at birth. Game updates may change how we check it.')).toBeVisible();
  await card(page).getByRole('link', { name: "Check it's really Pixel" }).click();
  await expect(page).toHaveURL(/\/pet\/9\/verify$/);
});

// spec: add-game-layout › Pet card screen › success (Seal)
test('success (Seal): a mismatch is said in the card and the check stays', async ({ page }) => {
  const chain = verificationFakes({ variant: 'character-mismatch' });
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, verificationIndex: chain.worker!.verificationIndex }, rpc: chain.rpc });
  await openCard(page);
  await expect(card(page).getByText("Pixel's character no longer matches the hatch record.")).toBeVisible();
  await expect(card(page).getByRole('link', { name: "Check it's really Pixel" })).toBeVisible();
});

// spec: add-game-layout › Pet card screen › success (Work)
// spec: add-game-layout › Pet card screen › success (Work) × Work entry
test('success (Work): the record, the experience and the skill open their destinations; the hire mode switches here', async ({ page }) => {
  await openPet(page);
  await openCard(page);
  await expect(inCard(page).getByRole('link', { name: 'View work record' })).toHaveAttribute('href', '/pet/9/work');
  await expect(inCard(page).getByRole('link', { name: 'Review experience' })).toHaveAttribute('href', '/pet/9/experience');
  await expect(inCard(page).getByRole('radio', { name: 'Auto' })).toBeChecked();
  await inCard(page).getByRole('radio', { name: 'Ask me first' }).click();
  await expect(inCard(page).getByRole('radio', { name: 'Ask me first' })).toBeChecked();
  await inCard(page).getByRole('button', { name: 'Teach Pixel a skill' }).click();
  await expect(page.getByRole('dialog', { name: /skill/i })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › success (Work)
test('success (Work): a pet with a skill offers «Pixel\'s skill» in the same place', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, skill: { label: 'weather' } }, '2': BISCUIT } } });
  await openCard(page);
  await expect(inCard(page).getByRole('button', { name: "Pixel's skill" })).toBeVisible();
  await expect(inCard(page).getByRole('button', { name: 'Teach Pixel a skill' })).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › success (Friends)
// spec: add-game-layout › Pet card screen › success (Friends) × Friends entry
test('success (Friends): «Relationships» opens the society summary', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, relationships: { tokenId: '9', name: 'Pixel', relationships: [] } } });
  await openCard(page);
  await inCard(page).getByRole('link', { name: 'Relationships' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/relationships$/);
});

// spec: add-game-layout › Pet card screen › success (Wish)
// spec: add-game-layout › Pet card screen › success (Wish) × Wish entry
test('success (Wish): the active wish shows its progress and «Pixel\'s wish» opens the sheet with its reserve', async ({ page }) => {
  await openPet(page, wishOwner);
  await openCard(page);
  await expect(inCard(page).getByText('Pixel wants Smart glasses')).toBeVisible();
  await expect(inCard(page).getByText('Saved 0.30¢ of 0.76¢')).toBeVisible();
  await inCard(page).getByRole('link', { name: "Pixel's wish" }).click();
  await expect(page.getByRole('dialog', { name: "Pixel's wish" })).toContainText('0.00066 of 0.00166 NEAR');
  await expect(card(page)).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › success (before first wish)
test('success (before first wish): «No wish yet for Pixel.» with no control to open a wish', async ({ page }) => {
  await openPet(page, { wish: null, wishActive: false, wishReserveYocto: '0' });
  await openCard(page);
  await expect(inCard(page).getByText('No wish yet for Pixel.')).toBeVisible();
  await expect(inCard(page).getByRole('button', { name: "Pixel's wish" })).toHaveCount(0);
  await expect(inCard(page).getByRole('link', { name: "Pixel's wish" })).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › success (asleep owner)
// spec: add-game-layout › Pet card screen › success (asleep owner) × Feed entry
test('success (asleep owner): the card stays readable, editing and hire mode are unavailable, Feed opens the feeding path', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: asleepWorker({ traits: ['clever'], energy: 4 }) });
  await openCard(page);
  await expect(inCard(page).getByRole('meter', { name: 'Energy' })).toHaveAttribute('aria-valuenow', '4');
  await expect(inCard(page).getByRole('link', { name: 'Relationships' })).toBeVisible();
  await expect(inCard(page).getByRole('link', { name: 'View work record' })).toBeVisible();
  await expect(inCard(page).getByRole('button', { name: 'Teach Pixel a skill' })).toHaveCount(0);
  await expect(inCard(page).getByRole('radiogroup', { name: 'Hiring' })).toHaveCount(0);
  await inCard(page).getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(page.getByRole('dialog', { name: 'Feed Pixel' })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › success (guest)
// spec: add-game-layout › Pet card screen › success (guest) × sign-in
test('success (guest): name, portrait, fullness and the public skill label; no owner words or controls', async ({ page }) => {
  await openWith(page, '/pet/2', GUEST);
  await plate(page).click();
  const dialog = card(page, 'Biscuit');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.ds-pet-card__portrait [role="img"]')).toBeVisible();
  await expect(dialog.getByText('Full')).toBeVisible();
  await expect(dialog.getByText('Good at weather')).toBeVisible();
  await expect(dialog.getByRole('link', { name: "Check it's really Biscuit" })).toHaveAttribute('href', '/pet/2/verify');
  await expect(dialog.getByRole('link', { name: 'View work record' })).toHaveAttribute('href', '/pet/2/work');
  await expect(dialog.getByRole('meter', { name: 'Energy' })).toHaveCount(0);
  await expect(dialog.getByText('Grown-up')).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'Relationships' })).toHaveCount(0);
  await expect(dialog.getByText('Wish', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Teach Biscuit a skill' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(plate(page)).toBeFocused();
});

// spec: add-game-layout › Pet card screen › error
// spec: add-game-layout › Pet card screen › error × failed read while opening
// spec: add-game-layout › Pet card screen › error × Try again
test('error: the failed read says so with no private details; Try again reads afresh; Close returns', async ({ page }) => {
  await openPet(page, { traits: ['clever'] });
  await expect(plate(page)).toBeVisible();
  await setWorker(page, READ_FAILS);
  await plate(page).click();
  const dialog = card(page);
  await expect(dialog.getByText("Couldn't open Pixel's card. Try again.")).toBeVisible();
  await expect(dialog.getByRole('meter', { name: 'Energy' })).toHaveCount(0);
  await expect(dialog.getByText('clever')).toHaveCount(0);
  await setWorker(page, { petResult: undefined });
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('meter', { name: 'Energy' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › error × Close
test('error × Close: the card closes to the same pet', async ({ page }) => {
  await openPet(page);
  await expect(plate(page)).toBeVisible();
  await setWorker(page, READ_FAILS);
  await plate(page).click();
  await card(page).getByText("Couldn't open Pixel's card. Try again.").waitFor();
  await card(page).getByRole('button', { name: 'Close' }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(plate(page)).toBeFocused();
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
});

// spec: add-game-layout › Pet card screen › error (owner changed)
// spec: add-game-layout › Pet card screen › error (owner changed) × transfer during delayed read
test('error (owner changed): a transfer while the read is out closes the card to the guest pet with no owner details', async ({ page }) => {
  await openPet(page, { traits: ['clever'] });
  await setWorker(page, { petDelayMs: 1500 });
  await plate(page).click();
  await setWorker(page, { owned: [] });
  await expect(page.getByText(FORMER).first()).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Feed Pixel' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'More' })).toHaveCount(0);
  await expect(page.getByText('clever')).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › error (owner changed) × confirmed transfer
test('a confirmed transfer under the open card closes it to the guest view and removes the private details', async ({ page }) => {
  await openPet(page, wishOwner);
  await openCard(page);
  await expect(inCard(page).getByText('Pixel wants Smart glasses')).toBeVisible();
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(page.getByText(FORMER).first()).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByText('Pixel wants Smart glasses')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Feed Pixel' }).first()).toBeVisible();
});

// spec: add-game-layout › Pet card screen › success (guest) × session expiry during read
test('a session that ends while the guest\'s read is out leaves no owner field behind', async ({ page }) => {
  await openWith(page, '/pet/2', GUEST);
  await setWorker(page, { petDelayMs: 1500 });
  await plate(page).click();
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await expect(card(page, 'Biscuit')).toHaveCount(0);
  await expect(page.getByRole('meter', { name: 'Energy' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Relationships' })).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › success (guest) × sign-out
// spec: add-game-layout › Pet card screen › success (guest) × session expiry
test('the card of a guest signed out or expired holds only what a visitor may see', async ({ page }) => {
  await openWith(page, '/pet/2', GUEST);
  await plate(page).click();
  await card(page, 'Biscuit').waitFor();
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await expect(card(page, 'Biscuit')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Relationships' })).toHaveCount(0);
  await expect(page.getByText('Good at weather').first()).toBeVisible();
});

// spec: add-game-layout › Pet card screen › success (owner) × sign-out
// spec: add-game-layout › Pet card screen › success (owner) × session expiry
test('the owner\'s card closes when the session ends and no private field stays', async ({ page }) => {
  await openPet(page, wishOwner);
  await openCard(page);
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByText('Pixel wants Smart glasses')).toHaveCount(0);
  await expect(page.getByText('I want to see every tiny detail.')).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › success (owner) × reload
// spec: add-game-layout › Pet card screen › success (guest) × site data erased
test('a reload brings the card back closed; erased site data leaves a signed-out visitor card', async ({ page, context }) => {
  await openPet(page);
  await openCard(page);
  await page.reload();
  await expect(card(page)).toHaveCount(0);
  await expect(plate(page)).toContainText('Pixel');
  await context.clearCookies();
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await expect(card(page)).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › success (owner) × tab hidden then back
// spec: add-game-layout › Pet card screen › success (owner) × UTC midnight
test('the tab coming back or midnight passing leaves the open card to the pet read', async ({ page }) => {
  await openPet(page, { energy: 3 });
  await openCard(page);
  await expect(inCard(page).getByRole('meter', { name: 'Energy' })).toHaveAttribute('aria-valuenow', '3');
  await setWorker(page, { pets: { '9': { ...PIXEL, owner: { energy: 10 } }, '2': BISCUIT } });
  await lookAgain(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('meter', { name: 'Energy' }).first()).toHaveAttribute('aria-valuenow', '10');
  await openCard(page);
  await expect(inCard(page).getByRole('meter', { name: 'Energy' })).toHaveAttribute('aria-valuenow', '10');
});

// spec: add-game-layout › Pet card screen › success (owner) × confirmed feed
test('a confirmed feed refreshes the fullness and Energy the card reads', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, fullness: { state: 'hungry', level: 0.25 }, owner: { energy: 2 } }, '2': BISCUIT } } });
  await expect(page.getByText('Hungry', { exact: true }).first()).toBeVisible();
  await setWorker(page, { pets: { '9': { ...PIXEL, owner: { energy: 9 } }, '2': BISCUIT } });
  await lookAgain(page);
  await openCard(page);
  await expect(inCard(page).getByRole('meter', { name: 'Energy' })).toHaveAttribute('aria-valuenow', '9');
  await expect(inCard(page).getByText('Hungry')).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › success (Work) × skill save
test('a saved skill shows as «Pixel\'s skill» when the card is opened again', async ({ page }) => {
  await openPet(page);
  await setWorker(page, { pets: { '9': { ...PIXEL, skill: { label: 'weather' } }, '2': BISCUIT } });
  await lookAgain(page);
  await openCard(page);
  await expect(inCard(page).getByRole('button', { name: "Pixel's skill" })).toBeVisible();
  await expect(inCard(page).getByText('Good at weather')).toHaveCount(0);
});

// spec: add-game-layout › Pet card screen › success (Work) × hire mode change
test('a hire mode change is the mode the card shows next', async ({ page }) => {
  await openPet(page);
  await openCard(page);
  await inCard(page).getByRole('radio', { name: 'Ask me first' }).click();
  await expect.poll(async () => (await calls(page)).filter((call) => call === 'worker:setHireMode:manual').length).toBe(1);
  await page.keyboard.press('Escape');
  await openCard(page);
  await expect(inCard(page).getByRole('radio', { name: 'Ask me first' })).toBeChecked();
});

// spec: add-game-layout › Pet card screen › success (Wish) × wish update
test('a wish that changed is what the card reads next', async ({ page }) => {
  await openPet(page, wishOwner);
  await openCard(page);
  await expect(inCard(page).getByText('Pixel wants Smart glasses')).toBeVisible();
  await page.keyboard.press('Escape');
  await setWorker(page, { pets: { '9': { ...PIXEL, owner: { ...wishOwner, wish: { ...wish, item: 'bow-tie', reserveYocto: '500000000000000000000' } } }, '2': BISCUIT } });
  await lookAgain(page);
  await openCard(page);
  await expect(inCard(page).getByText('Pixel wants Bow tie')).toBeVisible();
});

// spec: add-game-layout › Pet card screen › success (owner) × wardrobe change
test('a worn outfit is in the portrait the card draws', async ({ page }) => {
  await openPet(page);
  await openCard(page);
  await expect(inCard(page).locator('.ds-pet-card__portrait [role="img"]')).toBeVisible();
  await expect(inCard(page).locator('.ds-pet-card__portrait .ds-pet')).toBeVisible();
  await expect(inCard(page).locator('.ds-pet-card__portrait [data-outfit]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await setWorker(page, { pets: { '9': { ...PIXEL, worn: 'thinking-cap', owner: { outfits: ['thinking-cap'] } }, '2': BISCUIT } });
  await lookAgain(page);
  await openCard(page);
  await expect(inCard(page).locator('.ds-pet-card__portrait [role="img"]')).toBeVisible();
  await expect(inCard(page).locator('.ds-pet-card__portrait [data-outfit]')).toHaveAttribute('data-outfit', 'thinking-cap');
});

// spec: add-game-layout › Pet card screen › success (owner) × confirmed feed
// spec: add-game-layout › Pet card screen › success (Wish) × wish update
// spec: add-game-layout › Pet card screen › success (Work) × skill save
// spec: add-game-layout › Pet card screen › success (owner) × wardrobe change
test('an open card follows a later authoritative pet refresh without closing', async ({ page }) => {
  await openPet(page, { energy: 2 });
  await openCard(page);
  await expect(inCard(page).getByRole('meter', { name: 'Energy' })).toHaveAttribute('aria-valuenow', '2');
  await setWorker(page, { pets: { '9': { ...PIXEL, worn: 'thinking-cap', skill: { label: 'weather' }, owner: { energy: 9, wish: wishOwner.wish, outfits: ['thinking-cap'] } }, '2': BISCUIT } });
  await lookAgain(page);
  await expect(inCard(page).getByRole('meter', { name: 'Energy' })).toHaveAttribute('aria-valuenow', '9');
  await expect(inCard(page).getByText('Pixel wants Smart glasses')).toBeVisible();
  await expect(inCard(page).getByRole('button', { name: "Pixel's skill" })).toBeVisible();
  await expect(inCard(page).locator('.ds-pet-card__portrait [data-outfit]')).toHaveAttribute('data-outfit', 'thinking-cap');
});

// spec: add-game-layout › Pet card screen › success (owner) × memory clear
test('a cleared memory leaves the card with only what the pet record permits', async ({ page }) => {
  await openPet(page, { traits: ['clever'] });
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear memory' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await openCard(page);
  await expect(inCard(page).getByText('Grown-up')).toBeVisible();
  await expect(inCard(page).getByRole('link', { name: 'View work record' })).toBeVisible();
});

// spec: add-game-layout › Pet card screen › success (guest) × site data erased
test('a visitor\'s card after erased site data reads the guest rules afresh', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { pets: { '2': WEATHER, '9': PIXEL } } });
  await plate(page).click();
  await expect(card(page, 'Biscuit').getByText('Good at weather')).toBeVisible();
  await expect(card(page, 'Biscuit').getByRole('link', { name: 'Relationships' })).toHaveCount(0);
});

// ── Pet actions menu screen ──────────────────────────────────────────────────────────────────────────────────

// spec: add-game-layout › Pet actions menu screen › success (awake owner)
// spec: add-game-layout › Pet actions menu screen › success (awake owner) × More opens
// spec: add-game-layout › Pet actions menu screen › success (awake owner) × More closes
test('success (awake owner): More lists Watch, Share and Give and closes with the focus back on More', async ({ page }) => {
  await openPet(page);
  await openMore(page);
  await expect(page.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: 'Watch something' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Share Pixel' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Give Pixel away' })).toBeVisible();
  await page.getByRole('button', { name: 'More' }).click();
  await expect(menu(page)).toHaveCount(0);
  await openMore(page);
  await menu(page).getByRole('button', { name: 'Close' }).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More' })).toBeFocused();
});

// spec: add-game-layout › Pet actions menu screen › success (awake owner) × Close
// spec: add-game-layout › Pet actions menu screen › success (awake owner) × Escape
test('Escape closes More with the focus on More', async ({ page }) => {
  await openPet(page);
  await openMore(page);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More' })).toBeFocused();
});

// spec: add-game-layout › Pet actions menu screen › success (awake owner) × Watch
// spec: add-game-layout › Pet actions menu screen › success (awake owner) × Edit watch
test('Watch something and Edit watch open the Watch sheet', async ({ page }) => {
  await openPet(page);
  await openMore(page);
  await page.getByRole('menuitem', { name: 'Watch something' }).click();
  await expect(page.getByRole('dialog', { name: 'Watch something' })).toBeVisible();
  await page.goto('about:blank');
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, watch: { target: 'Rust compiler releases', kind: 'release' } }, '2': BISCUIT } } });
  await openMore(page);
  await page.getByRole('menuitem', { name: 'Edit watch' }).click();
  await expect(page.getByRole('dialog', { name: 'Watch something' })).toBeVisible();
});

// spec: add-game-layout › Pet actions menu screen › success (awake owner) × Share
// spec: add-game-layout › Pet actions menu screen › success (sharing choices)
// spec: add-game-layout › Pet actions menu screen › success (sharing choices) × Back
test('Share Pixel offers the three choices in the menu and Back returns to More', async ({ page }) => {
  await openPet(page);
  await openMore(page);
  await page.getByRole('menuitem', { name: 'Share Pixel' }).click();
  for (const choice of ['Share a thought', 'Share growth', 'Share outfit']) await expect(page.getByRole('menuitem', { name: choice })).toBeVisible();
  await menu(page).getByRole('menuitem', { name: 'Back' }).click();
  await expect(page.getByRole('menuitem', { name: 'Share Pixel' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Give Pixel away' })).toBeVisible();
});

// spec: add-game-layout › Pet actions menu screen › success (sharing choices) × thought selection
test('a thought choice opens the preview of the newest eligible line', async ({ page }) => {
  await openPet(page);
  await openMore(page);
  await page.getByRole('menuitem', { name: 'Share Pixel' }).click();
  await page.getByRole('menuitem', { name: 'Share a thought' }).click();
  await expect(page.getByRole('dialog', { name: 'Share a thought' })).toBeVisible();
});

// spec: add-game-layout › Pet actions menu screen › success (sharing choices) × growth selection
// spec: add-game-layout › Pet actions menu screen › success (sharing choices) × outfit selection
test('growth and outfit choices follow their eligibility', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, stage: 'baby', worn: null, owner: { ownedCount: 1 } }, '2': BISCUIT } } });
  await openMore(page);
  await page.getByRole('menuitem', { name: 'Share Pixel' }).click();
  await page.getByRole('menuitem', { name: 'Share growth' }).click();
  await expect(page.getByText("Pixel hasn't reached a new stage yet.")).toBeVisible();
  await menu(page).getByRole('menuitem', { name: 'Back' }).click();
  await page.getByRole('menuitem', { name: 'Share Pixel' }).click();
  await page.getByRole('menuitem', { name: 'Share outfit' }).click();
  const reason = menu(page).getByRole('status');
  await expect(reason).toHaveText("Pixel isn't wearing an outfit to share.");
  await expect(reason).toBeFocused();
  await page.getByRole('button', { name: 'More' }).click();
  await openMore(page);
  await expect(page.getByRole('menuitem', { name: 'Share Pixel' })).toBeVisible();
  await page.goto('about:blank');
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, stage: 'adult', worn: 'thinking-cap', owner: { ownedCount: 1 } }, '2': BISCUIT } } });
  await openMore(page);
  await page.getByRole('menuitem', { name: 'Share Pixel' }).click();
  await page.getByRole('menuitem', { name: 'Share growth' }).click();
  await expect(page.getByRole('dialog', { name: 'Share growth' })).toBeVisible();
});

// spec: add-game-layout › Pet actions menu screen › success (awake owner) × Give
test('Give Pixel away opens the Gift sheet', async ({ page }) => {
  await openPet(page, {}, { me: ME_PIXEL });
  await openMore(page);
  await page.getByRole('menuitem', { name: 'Give Pixel away' }).click();
  await expect(page.getByRole('dialog', { name: 'Give Pixel to a friend' })).toBeVisible();
});

// spec: add-game-layout › Pet actions menu screen › success (asleep owner)
test('success (asleep owner): More keeps Watch and Share and has no Give', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: asleepWorker() });
  await openMore(page);
  await expect(page.getByRole('menuitem', { name: 'Watch something' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Share Pixel' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Give Pixel away' })).toHaveCount(0);
  await menu(page).getByRole('button', { name: 'Close' }).click();
  await expect(menu(page)).toHaveCount(0);
});

// spec: add-game-layout › Pet actions menu screen › error
// spec: add-game-layout › Pet actions menu screen › error × confirmed transfer
test('error: a transfer under the open menu closes it and opens the guest pet', async ({ page }) => {
  await openPet(page);
  await openMore(page);
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(page.getByText(FORMER).first()).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Give Pixel away' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Feed Pixel' }).first()).toBeVisible();
});

// spec: add-game-layout › Pet actions menu screen › success (awake owner) × sign-out
test('sign-out with More open leaves the visitor pet and no menu', async ({ page }) => {
  await openPet(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(menu(page)).toHaveCount(0);
});

// spec: add-game-layout › Pet actions menu screen › success (awake owner) × session expiry
test('a session that ends with More open closes the menu and disables More', async ({ page }) => {
  await openPet(page);
  await openMore(page);
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More' })).toBeDisabled();
});

// spec: add-game-layout › Pet actions menu screen › success (asleep owner) × pet falls asleep
test('a pet that falls asleep with More open loses «Give Pixel away»', async ({ page }) => {
  await openPet(page);
  await openMore(page);
  await expect(page.getByRole('menuitem', { name: 'Give Pixel away' })).toBeVisible();
  await setWorker(page, { pets: { '9': { ...ASLEEP_PIXEL, owner: {} }, '2': BISCUIT }, petState: { events: ['fell_asleep'] } });
  await lookAgain(page);
  await expect(page.getByRole('menuitem', { name: 'Give Pixel away' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Share Pixel' })).toBeVisible();
});

// spec: add-game-layout › Pet actions menu screen › success (awake owner) × UTC midnight
// spec: add-game-layout › Pet actions menu screen › success (awake owner) × tab hidden then back
test('midnight or the tab coming back: the open menu follows the current eligibility', async ({ page }) => {
  await openPet(page);
  await openMore(page);
  await setWorker(page, { pets: { '9': { ...PIXEL, owner: { watch: undefined } }, '2': BISCUIT } });
  await lookAgain(page);
  await expect(menu(page)).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Give Pixel away' })).toBeVisible();
});

// spec: add-game-layout › Pet actions menu screen › success (awake owner) × reload
// spec: add-game-layout › Pet actions menu screen › success (awake owner) × site data erased
test('a reload or erased site data brings More back closed', async ({ page, context }) => {
  await openPet(page);
  await openMore(page);
  await page.reload();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
  await openMore(page);
  await context.clearCookies();
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await expect(menu(page)).toHaveCount(0);
});

// Drift from the frames (2026-11-12): on a wide desktop the scene and the HUD reach the window's edges and only the
// conversation keeps its reading width.
test('a wide desktop (1728×1000): the scene and the HUD reach the edges, the conversation keeps its width', async ({ page }) => {
  await page.setViewportSize({ width: 1728, height: 1000 });
  await openPet(page);
  await expect(feedButton(page)).toBeVisible();
  const world = (await page.locator('.ds-stage__world').boundingBox())!;
  const chat = (await page.locator('.ds-stage__chat').boundingBox())!;
  const nameplate = (await plate(page).boundingBox())!;
  expect(world.x).toBeLessThan(40);
  expect(chat.x + chat.width).toBeGreaterThan(1728 - 40);
  expect(chat.width).toBeLessThanOrEqual(704 + 1);
  expect(nameplate.x).toBeLessThan(40);
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/desktop-1728.png` });
});
