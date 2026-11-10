import { expect, test } from '@playwright/test';
import { calls, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';
import type { HireBoard } from '../src/seams/worker-types';

const PRICE = { cents: 0.38, yocto: '380000000000000000000' };
const NORI: HireBoard['pets'][number] = { tokenId: '5', opaqueId: 'nori', name: 'Nori', label: 'copywriting', price: PRICE, status: 'available', yours: false };
const BISCUIT: HireBoard['pets'][number] = { tokenId: '2', opaqueId: 'biscuit', name: 'Biscuit', label: 'storytelling', price: PRICE, status: 'available', yours: false };
const VISIT: HireBoard['visits'][number] = { tokenId: '0', name: 'Juniper', stage: 'adult', fullness: 'full', worn: null };
const board = (pets: HireBoard['pets'], visits: HireBoard['visits'] = []): HireBoard => ({ pets, visits });

// spec: add-pet-experience › Experience discovery rule › board card
test('the public field and counted work sit beside the unchanged hire quote', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: board([{ ...NORI, experience: { field: 'Worked on comparing train fares', paidHires: 3, completedErrands: 5, countedSince: Date.UTC(2026, 10, 7) * 1_000_000 } }]) } });
  await expect(page.getByText('Worked on comparing train fares')).toBeVisible();
  await expect(page.getByText('3 paid hires · 5 errands since Nov 7, 2026')).toBeVisible();
  await expect(page.getByText('0.38¢ to ask')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View work record' })).toHaveAttribute('href', '/pet/5/work');
});

// spec: add-pet-work › Hire board screen › empty
test('Home offers a route to the board', async ({ page }) => {
  await openWith(page, '/', { worker: { hireBoard: board([]) } });
  await page.getByRole('link', { name: 'Find a pet to ask' }).click();
  await expect(page).toHaveURL('/hire');
  await expect(page.getByRole('heading', { name: 'Find a pet to ask' })).toBeVisible();
});

// spec: add-pet-work › Hire board screen › empty
test('the owner Pet header offers a route to the board on desktop and phone', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { ...OWNER.pets, '9': { ...PIXEL, owner: {} } }, hireBoard: board([]) } });
  const link = page.getByRole('link', { name: 'Find a pet to ask' });
  await expect(link).toHaveAttribute('href', '/hire');
  if ((page.viewportSize()?.width ?? 0) < 768) await expect(link).toHaveClass(/ds-icon-button/);
  await link.click();
  await expect(page).toHaveURL('/hire');
});

// spec: add-pet-work › Hire board screen › empty
test('a closed Hatch screen with no pet or friend offers a route to the board', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily', noPets: true }, hireBoard: board([]) } });
  await page.getByRole('link', { name: 'Find a pet to ask' }).click();
  await expect(page).toHaveURL('/hire');
});

// spec: add-pet-work › Hire board screen › empty
// spec: add-pet-work › Hire board screen › empty × Visit {name}
// spec: add-pet-work › Hire board screen › empty × Go home
test('empty board offers showcase visits and a route home', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { hireBoard: board([], [VISIT]) } });
  await expect(page.getByText('No pets with skills are on the board yet. Meanwhile, you can visit these pets:')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Juniper' })).toHaveAttribute('href', '/pet/0');
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  expect(await calls(page)).not.toContain('worker:askAdvice');
});

// spec: add-pet-work › Hire board screen › empty, nothing to visit
// spec: add-pet-work › Hire board screen › empty, nothing to visit × Try again
test('empty board with no visits gives a player without a pet a retry and no Home header', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { hireBoard: board([]) } });
  await expect(page.getByText('No pets with skills are on the board yet.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0);
  await setWorker(page, { hireBoard: board([NORI]) });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  expect((await calls(page)).filter((call) => call === 'worker:hireBoard')).toHaveLength(2);
});

// spec: add-pet-work › Hire board screen › loading
test('loading holds search and cards until the public read finishes', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoardDelayMs: 3_600_000 } });
  await expect(page.getByText('Finding pets who can help…').first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search skills' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Visit/ })).toHaveCount(0);
  await expect(page.locator('.ds-skeleton--pet')).toHaveCount(3);
});

// spec: add-pet-work › Hire board screen › error
// spec: add-pet-work › Hire board screen › error × Try again
test('a failed board read shows no guessed quote and can retry', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: { fail: { status: 503, code: 'chain_unreachable' } } } });
  await expect(page.getByText("We couldn't load the board right now. Try again in a moment.").first()).toBeVisible();
  await expect(page.getByText('0.38¢ to ask')).toHaveCount(0);
  await setWorker(page, { hireBoard: board([NORI]) });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
});

// spec: add-pet-work › Hire board screen › success
// spec: add-pet-work › Hire board screen › success × Visit {name}
test('a public listing shows checked label, quote, availability, notice and a visit', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { hireBoard: board([NORI]) } });
  await expect(page.getByRole('textbox', { name: 'Search skills' })).toBeVisible();
  await expect(page.getByText('Good at copywriting')).toBeVisible();
  await expect(page.getByText('0.38¢ to ask')).toBeVisible();
  await expect(page.getByText('Nori can help now')).toBeVisible();
  await expect(page.getByText('Availability may have changed. We check again before your question is sent.')).toBeVisible();
  await page.getByRole('link', { name: 'Visit Nori' }).click();
  await expect(page).toHaveURL('/pet/5');
  expect(await calls(page)).not.toContain('worker:askAdvice');
});

// spec: add-pet-work › Hire board screen › own pet listed
// spec: add-pet-work › Hire board screen › own pet listed × Visit {name}
test('the owner sees Yours instead of a price', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { hireBoard: board([{ ...NORI, yours: true }]) } });
  await expect(page.getByText('Yours')).toBeVisible();
  await expect(page.getByText('0.38¢ to ask')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toHaveAttribute('href', '/pet/5');
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
});

// spec: add-pet-work › Hire board flow › label searched
// spec: add-pet-work › Hire board screen › no label matches
// spec: add-pet-work › Hire board screen › no label matches × Show all
test('label search stays in the tab, then Show all restores cards', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: board([NORI, BISCUIT]) } });
  const search = page.getByRole('textbox', { name: 'Search skills' });
  await search.fill('WRIT');
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Biscuit' })).toHaveCount(0);
  await search.fill('gardening');
  await expect(page.getByText('No skill labels match “gardening”.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('link', { name: 'Visit Biscuit' })).toBeVisible();
  expect((await calls(page)).filter((call) => call === 'worker:hireBoard')).toHaveLength(1);
  await expect(page).toHaveURL('/hire');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('hire') || key.includes('search')))).toEqual([]);
});

// spec: add-pet-work › Hire board screen › signed-out
// spec: add-pet-work › Hire board screen › signed-out × Sign in
test('a signed-out visitor can browse and start sign-in from the board', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: board([NORI]) }, auth: { outcome: 'held' } });
  await expect(page.getByText('Sign in to ask a pet.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(async () => (await calls(page)).includes('privy:login')).toBe(true);
});

// spec: add-pet-work › Hire board screen › asleep
test('an asleep card keeps its quote and visit', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: board([{ ...NORI, status: 'asleep' }]) } });
  await expect(page.getByText('Nori is asleep')).toBeVisible();
  await expect(page.getByText('0.38¢ to ask')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  await expect(page.locator('.hire-board-picture--asleep .ds-pet')).toHaveCSS('filter', /brightness\(/);
});

// spec: add-pet-work › Hire board screen › unavailable today
test('a resting card gives the local reset time', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWith(page, '/hire', { worker: { hireBoard: board([{ ...BISCUIT, status: 'resting', until: '2026-11-02T00:00:00.000Z' }]) } });
  await expect(page.getByText(/Biscuit is resting until \d\d:\d\d/)).toBeVisible();
  await expect(page.getByText('0.38¢ to ask')).toBeVisible();
});

// spec: add-pet-work › Hire board screen › service paused
test('a service pause changes every listed status', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: board([NORI, BISCUIT].map((pet) => ({ ...pet, status: 'paused' }))) } });
  await expect(page.getByText('Nori will be back soon')).toBeVisible();
  await expect(page.getByText('Biscuit will be back soon')).toBeVisible();
  await expect(page.getByText(/can help now/)).toHaveCount(0);
});

const reads = async (page: import('@playwright/test').Page) => (await calls(page)).filter((call) => call === 'worker:hireBoard').length;
const storedKeys = (page: import('@playwright/test').Page) => page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((key) => /hire|board/i.test(key)));

// spec: add-pet-work › Hire board screen › loading × result
test('loading × result: the cards replace the loading line when the read answers', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: board([NORI]), hireBoardDelayMs: 1500 } });
  await expect(page.locator('.ds-skeleton--pet')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  await expect(page.locator('.ds-skeleton--pet')).toHaveCount(0);
});

// spec: add-pet-work › Hire board screen › loading × error
test('loading × error: the failure line replaces the loading line, with no price guessed', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: { fail: { status: 503, code: 'chain_unreachable' } }, hireBoardDelayMs: 1500 } });
  await expect(page.locator('.ds-skeleton--pet')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.locator('.ds-skeleton--pet')).toHaveCount(0);
  await expect(page.getByText('0.38¢ to ask')).toHaveCount(0);
});

// spec: add-pet-work › Hire board screen › loading × navigation away
test('loading × navigation away: leaving before the answer shows nothing of the board on the next page', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { hireBoard: board([NORI]), hireBoardDelayMs: 1500 } });
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page).not.toHaveURL(/\/hire$/);
  await page.waitForTimeout(2000);
  // the Pet screen's Hud carries a link of the same name: it is the board's heading that must not come
  await expect(page.getByRole('heading', { name: 'Find a pet to ask' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toHaveCount(0);
});

// spec: add-pet-work › Hire board screen › success × Home
test('success × Home: «Home» leaves the board for the home route', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { hireBoard: board([NORI]) } });
  await expect(page.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page).not.toHaveURL(/\/hire$/);
});

// spec: add-pet-work › Hire board screen › success × Account
test('success × Account: the signed-in account control opens its menu on the board and the cards stay', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { hireBoard: board([NORI]), me: { accountId: 'a'.repeat(64), hatched: null, currentPet: null, ownedCount: 0 } } });
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
});

// spec: add-pet-work › Hire board data › public board read × reload
test('public board read × reload: a reload reads the board again and nothing of it is stored', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: board([NORI]) } });
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  expect(await storedKeys(page)).toEqual([]);
  await page.reload();
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  expect(await reads(page)).toBe(1);
  expect(await storedKeys(page)).toEqual([]);
});

// spec: add-pet-work › Hire board data › public board read × tab close
test('public board read × tab close: a new tab starts with an empty search and a fresh read', async ({ page, context }) => {
  await openWith(page, '/hire', { worker: { hireBoard: board([NORI, BISCUIT]) } });
  await page.getByRole('textbox', { name: 'Search skills' }).fill('writ');
  await page.close();
  const again = await context.newPage();
  await openWith(again, '/hire', { worker: { hireBoard: board([NORI, BISCUIT]) } });
  await expect(again.getByRole('textbox', { name: 'Search skills' })).toHaveValue('');
  await expect(again.getByRole('link', { name: 'Visit Biscuit' })).toBeVisible();
  expect(await reads(again)).toBe(1);
});

// spec: add-pet-work › Hire board data › public board read × site data erased
test('public board read × site data erased: the board needs nothing stored and reads fresh', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: board([NORI]) } });
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  expect(await reads(page)).toBe(1);
});

// spec: add-pet-work › Hire board screen › success × tab returns
test('success × tab returns: the snapshot and the freshness notice stay, no new read', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: board([NORI]) } });
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await setWorker(page, { hireBoard: board([BISCUIT]) });
  await page.waitForTimeout(500);
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  await expect(page.getByText('Availability may have changed. We check again before your question is sent.')).toBeVisible();
  expect(await reads(page)).toBe(1);
});

// spec: add-pet-work › Hire board screen › own pet listed × session change
// spec: add-pet-work › Hire board screen › own pet listed × sign-out
test('own pet listed × sign-out: a session lost in another tab swaps the account control for «Sign in» and the open board stands as it is', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { hireBoard: board([{ ...NORI, yours: true }]) } });
  await expect(page.getByText('Yours')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('nearling:fake-session-lost')));
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  expect(await reads(page)).toBe(1);
});

// spec: add-pet-work › Hire board screen › own pet listed × session expiry
test('own pet listed × session expiry: a 401 on the read ends the session and the public board shows with «Sign in»', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { sessionExpired: true, hireBoard: board([NORI]) } });
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  await expect(page.getByText('Yours')).toHaveCount(0);
  await expect(page.getByText('Sign in to ask a pet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
});

// spec: add-pet-work › Hire board screen › own pet listed × sign-in
// spec: add-pet-work › Hire board screen › signed-out × sign-in return
test('own pet listed × sign-in: signing in comes back to the board and marks the pet as «Yours»', async ({ page }) => {
  await openWith(page, '/hire', { worker: { hireBoard: board([NORI]) } });
  await expect(page.getByText('Sign in to ask a pet.')).toBeVisible();
  await setWorker(page, { hireBoard: board([{ ...NORI, yours: true }]) });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/hire$/);
  await expect(page.getByText('Yours')).toBeVisible();
  await expect(page.getByText('Sign in to ask a pet.')).toHaveCount(0);
});

// spec: add-pet-work › Hire board screen › signed-out × lost return place
test('signed-out × lost return place: a sign-in with no place left in the tab goes where Home sign-in goes, not to a stale board', async ({ page }) => {
  await page.addInitScript(() => {
    const original = history.replaceState.bind(history);
    history.replaceState = (data, unused, url) => {
      if (String(url) === '/') sessionStorage.removeItem('nearling.returnPlace');
      original(data, unused, url);
    };
  });
  await openWith(page, '/hire', { worker: { hireBoard: board([NORI]) } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/hatch$/);
});

// spec: add-pet-work › Hire board screen › own pet listed × gift and reload
test('own pet listed × gift and reload: after the pet is given away a reload shows the new owner state', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { hireBoard: board([{ ...NORI, yours: true }]) } });
  await expect(page.getByText('Yours')).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('zz-gifted', '1'));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('zz-gifted')) return;
    const g = globalThis as { __NEARLING_FAKES__?: { worker?: { hireBoard?: { pets: Array<{ yours: boolean }> } } } };
    for (const pet of g.__NEARLING_FAKES__?.worker?.hireBoard?.pets ?? []) pet.yours = false;
  });
  await page.reload();
  await expect(page.getByText('0.38¢ to ask')).toBeVisible();
  await expect(page.getByText('Yours')).toHaveCount(0);
});

// spec: add-pet-work › Hire board screen › empty, nothing to visit × new hatch
test('empty, nothing to visit × new hatch: «Try again» reads both lists, a new pet appears and the Home header returns', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { hireBoard: board([]), me: { accountId: 'a'.repeat(64), hatched: null, currentPet: null, ownedCount: 0 } } });
  await expect(page.getByText('No pets with skills are on the board yet.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0);
  await setWorker(page, { hireBoard: board([NORI]), me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('link', { name: 'Visit Nori' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
});

// spec: add-pet-work › Hire board screen › empty, nothing to visit × reload
test('empty, nothing to visit × reload: a reload reads the board again', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { hireBoard: board([]) } });
  await expect(page.getByText('No pets with skills are on the board yet.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('No pets with skills are on the board yet.')).toBeVisible();
  expect(await reads(page)).toBe(1);
});
