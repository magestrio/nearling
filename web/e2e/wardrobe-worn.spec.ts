import { expect, test, type Page } from '@playwright/test';
import { BISCUIT, calls, lookAgain, openDiary, openWardrobe, openWith, OWNER, PIXEL, setWardrobePet, setWorker, SIGNED_IN, wardrobeWorker } from './helpers';

const OFFLINE = "Can't reach Pixel right now. Nothing's lost — try again in a moment.";
const DOWN = { fail: { status: 0, code: 'unreachable' } };
const ASLEEP_PET = { fullness: { state: 'asleep' as const, level: 0 } };

const tile = (page: Page, name: string) => page.getByRole('button', { name });
const wornAlt = (page: Page, item: string | null) => page.getByRole('img', { name: item === null ? 'Pixel, full' : `Pixel, full, wearing the ${item}` });
const wears = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('worker:wear:'));

// spec: add-wardrobe › Outfit rule › надел
test('надел: «Wear» puts the item on the pet, takes the former one off and gives the worn one «Take off»', async ({ page }) => {
  await openWardrobe(page);
  const looked = async () => (await calls(page)).filter((c) => c === 'worker:petState').length;
  const before = await looked();
  await tile(page, 'Wear Daisy crown').click();
  await expect(tile(page, 'Take off Daisy crown')).toBeVisible();
  await expect(tile(page, 'Wear Thinking cap')).toBeVisible();
  await expect(wornAlt(page, 'Daisy crown')).toBeVisible();
  await expect(wornAlt(page, 'Thinking cap')).toHaveCount(0);
  expect(await wears(page)).toEqual(['worker:wear:daisy-crown']);
  // the pet's own view is read again at once, so the Pet screen under the Wardrobe has the new outfit
  await expect.poll(looked).toBeGreaterThan(before);
  await page.getByRole('link', { name: 'Back to Pixel' }).first().click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(wornAlt(page, 'Daisy crown')).toBeVisible();
  await expect(wornAlt(page, 'Thinking cap')).toHaveCount(0);
});

// spec: add-wardrobe › Outfit rule › снял
test('снял: «Take off» leaves the pet with no outfit and gives the item «Wear» again', async ({ page }) => {
  await openWardrobe(page);
  await tile(page, 'Take off Thinking cap').click();
  await expect(tile(page, 'Wear Thinking cap')).toBeVisible();
  await expect(wornAlt(page, null)).toBeVisible();
  expect(await wears(page)).toEqual(['worker:wear:none']);
});

// spec: add-wardrobe › Outfit rule › надел × a second tap in flight
test('надел × a second tap in flight: the button is busy and a repeat tap sends nothing', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker({}, {}, {}, { wearDelayMs: 1200 }));
  const wear = tile(page, 'Wear Daisy crown');
  await wear.click();
  await expect(wear).toHaveAttribute('aria-busy', 'true');
  await wear.click({ force: true });
  await tile(page, 'Wear Party hat').click({ force: true });
  await expect(tile(page, 'Take off Daisy crown')).toBeVisible();
  expect(await wears(page)).toEqual(['worker:wear:daisy-crown']);
  await expect(tile(page, 'Take off Daisy crown')).not.toHaveAttribute('aria-busy', 'true');
});

// spec: add-wardrobe › Outfit rule › надел × the request fails
test('надел × the request fails: the connection line, nothing changed; the pet keeps its outfit', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker({}, {}, {}, { wear: DOWN }));
  await tile(page, 'Wear Daisy crown').click();
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  await expect(tile(page, 'Wear Daisy crown')).toBeVisible();
  await expect(tile(page, 'Take off Thinking cap')).toBeVisible();
  await expect(wornAlt(page, 'Thinking cap')).toBeVisible();
  await expect(tile(page, 'Wear Daisy crown')).not.toHaveAttribute('aria-busy', 'true');
});

// spec: add-wardrobe › Outfit rule › надел × the focus stays
test('надел × the focus stays: on the same button, which now says the other thing, for «Wear» and for «Take off»', async ({ page }) => {
  await openWardrobe(page);
  await tile(page, 'Wear Daisy crown').focus();
  await page.keyboard.press('Enter');
  await expect(tile(page, 'Take off Daisy crown')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(tile(page, 'Wear Daisy crown')).toBeFocused();
});

// spec: add-wardrobe › Wardrobe data › после подарка × Wear unanswered with 403
test('после подарка × Wear unanswered with 403: the pet is someone else\'s, the page turns the guest\'s and nothing is worn', async ({ page }) => {
  await openWardrobe(page, wardrobeWorker({}, {}, {}, { wear: { fail: { status: 403, code: 'not_owner' } } }));
  // the gift lands: the pet is not this player's any more
  await setWorker(page, { owned: [] });
  await tile(page, 'Wear Daisy crown').click();
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/9\/wardrobe$/);
  await expect(page.locator('.ds-item')).toHaveCount(0);
});

// spec: add-wardrobe › Wardrobe screen › asleep × Wear and Take off
test('asleep × Wear and Take off: both work on a pet that fell asleep', async ({ page }) => {
  await openWardrobe(page);
  await setWardrobePet(page, ASLEEP_PET);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('Pixel fell asleep.', { exact: false }).first()).toBeVisible();
  await tile(page, 'Wear Daisy crown').click();
  await expect(tile(page, 'Take off Daisy crown')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pixel, asleep, wearing the Daisy crown' })).toBeVisible();
  await tile(page, 'Take off Daisy crown').click();
  await expect(tile(page, 'Wear Daisy crown')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pixel, asleep' })).toBeVisible();
  expect(await wears(page)).toEqual(['worker:wear:daisy-crown', 'worker:wear:none']);
});

const figure = (page: Page) => page.locator('[data-illustration]');
// a stranger's pet in the Party hat, seen by a guest (signed in, not its owner) and by a visitor (no session)
const STRANGERS = { ...OWNER, owned: [] as string[], pets: { '9': PIXEL, '2': { ...BISCUIT, worn: 'party-hat' as const } } };

// spec: add-wardrobe › Outfit rule › надел × a guest and a visitor
test('надел × a guest and a visitor: both see the pet in what it wears, on the model, and the picture says so', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: STRANGERS });
  await expect(page.getByRole('img', { name: 'Biscuit, full, wearing the Party hat' })).toBeVisible();
  await expect(figure(page)).toHaveAttribute('data-outfit', 'party-hat');
  const visitor = await page.context().newPage();
  await openWith(visitor, '/pet/2', { worker: STRANGERS });
  await expect(visitor.getByRole('img', { name: 'Biscuit, full, wearing the Party hat' })).toBeVisible();
  await expect(visitor.locator('[data-illustration]')).toHaveAttribute('data-outfit', 'party-hat');
  // a pet that wears nothing has no outfit on it
  await openWith(visitor, '/pet/9', { worker: STRANGERS });
  await expect(visitor.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
  await expect(visitor.locator('[data-illustration]')).not.toHaveAttribute('data-outfit', /.+/);
});

// spec: add-wardrobe › Outfit rule › надел × no WebGL
test('надел × no WebGL: the flat drawing wears it too, on the Pet screen and in the Wardrobe, and the actions work', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
      return (original as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof original;
  });
  await openWardrobe(page);
  await expect(figure(page).first()).toHaveAttribute('data-view', 'flat');
  await expect(wornAlt(page, 'Thinking cap')).toBeVisible();
  await tile(page, 'Wear Daisy crown').click();
  await expect(wornAlt(page, 'Daisy crown')).toBeVisible();
  await expect(figure(page).first()).toHaveAttribute('data-outfit', 'daisy-crown');
  await page.getByRole('link', { name: 'Back to Pixel' }).first().click();
  await expect(figure(page).first()).toHaveAttribute('data-view', 'flat');
  await expect(wornAlt(page, 'Daisy crown')).toBeVisible();
});

// spec: add-wardrobe › Outfit rule › надел × another device
test('надел × another device: a change of clothes made elsewhere reaches the open Pet screen and a guest\'s page within a look', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: wardrobeWorker() });
  await expect(wornAlt(page, 'Thinking cap')).toBeVisible();
  await setWardrobePet(page, { worn: 'party-hat' });
  await lookAgain(page);
  await expect(wornAlt(page, 'Party hat')).toBeVisible();
  await expect(wornAlt(page, 'Thinking cap')).toHaveCount(0);
  await setWardrobePet(page, { worn: null });
  await lookAgain(page);
  await expect(wornAlt(page, null)).toBeVisible();

  const guest = await page.context().newPage();
  await openWith(guest, '/pet/2', { auth: SIGNED_IN, worker: STRANGERS });
  await expect(guest.getByRole('img', { name: 'Biscuit, full, wearing the Party hat' })).toBeVisible();
  await setWorker(guest, { pets: { '9': PIXEL, '2': { ...BISCUIT, worn: 'bow-tie' } } });
  await lookAgain(guest);
  await expect(guest.getByRole('img', { name: 'Biscuit, full, wearing the Bow tie' })).toBeVisible();
});

// spec: add-wardrobe › Outfit rule › надел × the Diary's small pet
test('надел × the Diary\'s small pet: the small pet of the entry wears the item too', async ({ page }) => {
  await openDiary(page, {}, { ...wardrobeWorker() });
  const small = page.locator('.ds-pet--sm[data-illustration]');
  await expect(small).toHaveAttribute('data-outfit', 'thinking-cap');
  await setWardrobePet(page, { worn: null });
  await lookAgain(page);
  await expect(small).not.toHaveAttribute('data-outfit', /.+/);
});

// spec: add-wardrobe › Wardrobe data › после подарка × the old owner's page
test('после подарка × the old owner\'s page: the Pet screen turns the guest\'s, the pet in what the new owner chose, and the Wardrobe address shows no wardrobe', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: wardrobeWorker() });
  await expect(wornAlt(page, 'Thinking cap')).toBeVisible();
  // the gift lands, and the new owner puts on the Party hat
  await setWorker(page, { owned: [], pets: wardrobeWorker({ worn: 'party-hat' }).pets });
  await lookAgain(page);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pixel, full, wearing the Party hat' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Wardrobe' })).toHaveCount(0);
  await page.evaluate(() => {
    window.history.pushState({}, '', '/pet/9/wardrobe');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page.locator('.ds-item')).toHaveCount(0);
});

// spec: add-wardrobe › Wardrobe data › удаление памяти × site data erased
test('удаление памяти × site data erased: nothing of the wardrobe lives in the browser; the next visit is signed out and the server still has the pet in its item', async ({ page }) => {
  await openWardrobe(page);
  await tile(page, 'Wear Daisy crown').click();
  await expect(tile(page, 'Take off Daisy crown')).toBeVisible();
  const kept = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => /wardrobe|outfit|worn|notice/i.test(k)));
  expect(kept).toEqual([]);
  // the site data goes: the session with it
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  const held = await page.evaluate(() => JSON.stringify((globalThis as { __NEARLING_FAKES__?: { worker?: unknown } }).__NEARLING_FAKES__?.worker));
  await page.addInitScript((worker) => {
    const fakes = (globalThis as { __NEARLING_FAKES__?: { worker?: unknown; auth?: unknown } }).__NEARLING_FAKES__!;
    delete fakes.auth;
    fakes.worker = JSON.parse(worker);
  }, held);
  await page.goto('/pet/9');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pixel, full, wearing the Daisy crown' })).toBeVisible();
});
