import { expect, test, type Page } from '@playwright/test';
import { calls, openWith, privyCalls, setWorker, UA } from './helpers';

const FAILED = "We couldn't sign you in with Google. Try again in a moment.";
const FALLBACK = 'Trouble signing in? Try it in your browser.';
const OFFLINE = "Can't reach Biscuit right now. Nothing's lost — try again in a moment.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';
const TOO_MANY = { fail: { status: 429, code: 'rate_limited' } };
const placeOf = (page: Page) => page.evaluate(() => sessionStorage.getItem('nearling.returnPlace'));
const recordOf = async (page: Page) => JSON.parse((await placeOf(page)) ?? 'null') as unknown;
const gateReads = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:signInState').length;
const setOutcome = (page: Page, outcome: 'ok' | 'cancelled' | 'failed' | 'start_failed' | 'held') =>
  page.evaluate((o) => {
    const g = globalThis as { __NEARLING_FAKES__?: { auth?: Record<string, unknown> } };
    g.__NEARLING_FAKES__!.auth = { ...g.__NEARLING_FAKES__!.auth, outcome: o };
  }, outcome);
/** The return record as it stands when the page's address is set to `/` for Privy. */
const watchReplace = (page: Page) =>
  page.addInitScript(() => {
    const seen: Array<string | null> = [];
    (globalThis as { __PLACES__?: unknown }).__PLACES__ = seen;
    const original = history.replaceState.bind(history);
    history.replaceState = (data, unused, url) => {
      if (String(url) === '/') seen.push(sessionStorage.getItem('nearling.returnPlace'));
      original(data, unused, url);
    };
  });
const places = (page: Page) => page.evaluate(() => (globalThis as { __PLACES__?: Array<string | null> }).__PLACES__ ?? []);

// spec: add-account › Sign-in flow › вход начат
test('вход начат: a visitor in an ordinary browser taps «Sign in» while sign-in is open — the gate is read, then Google', async ({ page }) => {
  await openWith(page, '/pet/2', {});
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
  const all = await calls(page);
  expect(all.indexOf('worker:signInState')).toBeGreaterThanOrEqual(0);
  expect(all.indexOf('worker:signInState')).toBeLessThan(all.indexOf('privy:login'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

// spec: add-account › Sign-in flow › вход начат × Pet screen
test('вход начат × Pet screen: «Feed {name}» and «Sign in» both begin it; the place and the tapped action wait in the tab', async ({ page }) => {
  await watchReplace(page);
  await openWith(page, '/pet/2?from=9', {});
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
  expect(JSON.parse((await places(page))[0]!)).toEqual({ path: '/pet/2?from=9', action: 'feed' });
  await expect(page).toHaveURL(/\/pet\/2\?from=9$/);
});

// spec: add-account › Sign-in flow › вход начат × Hatch screen
test('вход начат × Hatch screen: «Sign in with Google to hatch your pet» begins it with the place `/hatch`', async ({ page }) => {
  await watchReplace(page);
  await openWith(page, '/hatch?from=2', {});
  await page.getByRole('button', { name: 'Sign in with Google to hatch your pet' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
  expect(JSON.parse((await places(page))[0]!)).toEqual({ path: '/hatch?from=2', action: 'signin' });
});

// spec: add-account › Sign-in flow › вошёл со страницы
test('вошёл со страницы: from a Pet screen — the same screen, signed in; from the Hatch screen — the same form', async ({ page }) => {
  await openWith(page, '/pet/2', {});
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  expect(await calls(page)).toContain('worker:session:fresh:link');
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Sign-in flow › вошёл со страницы
test('вошёл со страницы: the Hatch screen is back with its form', async ({ page }) => {
  await openWith(page, '/hatch', {});
  await page.getByRole('button', { name: 'Sign in with Google to hatch your pet' }).click();
  await expect(page).toHaveURL(/\/hatch$/);
  await expect(page.getByLabel('Name your pet')).toBeVisible();
  expect(await placeOf(page)).toBeNull();
});

const ME_PIXEL = { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };
/** The tab's memory is erased at the moment Privy reads the return address: the sign-in comes back to a tab with no place. */
const losePlace = (page: Page) =>
  page.addInitScript(() => {
    const original = history.replaceState.bind(history);
    history.replaceState = (data, unused, url) => {
      if (String(url) === '/') sessionStorage.removeItem('nearling.returnPlace');
      original(data, unused, url);
    };
  });

// spec: add-account › Sign-in flow › вошёл с главной
test('вошёл с главной: «Sign in» on Home with no place — the current pet\'s Pet screen, the place of no page left in the tab', async ({ page }) => {
  await openWith(page, '/', { worker: { me: ME_PIXEL, owned: ['9'] } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  expect(await calls(page)).toContain('worker:session:fresh:home');
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Sign-in flow › вошёл с главной
test('вошёл с главной: a player with no pet of their own is on the Hatch screen', async ({ page }) => {
  await openWith(page, '/', {});
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/hatch$/);
  await expect(page.getByLabel('Name your pet')).toBeVisible();
});

// spec: add-account › Sign-in flow › место потерялось
// spec: add-account › Sign-in return data › место потерялось
test('место потерялось: a sign-in begun on a page came back with no place — as from Home; the tapped action is not run', async ({ page }) => {
  await losePlace(page);
  await openWith(page, '/pet/2', { worker: { me: ME_PIXEL, owned: ['9'] } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  // not the page the sign-in began on, and no «Feed» on it
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toHaveCount(0);
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Sign-in flow › вошёл со страницы × обмен без ответа
test('вошёл со страницы × обмен без ответа: «Try again» of Home asks again, and the tab is led to the place', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { session: { fail: { status: 0, code: 'unreachable' } } } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  // the exchange of the sign-in answers nothing at `/`: Home's own connection page, the place waits in the tab
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("We can't reach the game right now. Try again in a moment.").first()).toBeVisible();
  expect(JSON.parse((await placeOf(page))!)).toEqual({ path: '/pet/2', action: 'signin' });
  await setWorker(page, { session: { ok: true } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Sign-in flow › вход не удался
test('вход не удался: «We couldn\'t sign you in with Google…» and «Try again»; the screen as before the tap', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: { outcome: 'failed' } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/2$/);
  // on a desktop browser there is no fallback line
  await expect(page.getByText(FALLBACK)).toHaveCount(0);
});

// spec: add-account › Sign-in flow › вход не удался × Try again
test('вход не удался × Try again: begins the sign-in again at the same place with the same action', async ({ page }) => {
  await watchReplace(page);
  await openWith(page, '/pet/2', { auth: { outcome: 'failed' } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await setOutcome(page, 'ok');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(FAILED)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  const seen = await places(page);
  expect(JSON.parse(seen.at(-1)!)).toEqual({ path: '/pet/2', action: 'feed' });
});

// spec: add-account › Sign-in flow › вход не удался
test('вход не удался: Google never started on a Pet screen — the line and «Try again» at the place the tab never left', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: { outcome: 'start_failed' } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await expect(page.getByText(FALLBACK)).toHaveCount(0);
  expect(await recordOf(page)).toEqual({ path: '/pet/2', action: 'feed', cancelled: true });
});

// spec: add-account › Sign-in flow › вход не удался
test('вход не удался: Google never started on the Hatch screen — the line and «Try again», the form as before the tap', async ({ page }) => {
  await openWith(page, '/hatch?from=2', { auth: { outcome: 'start_failed' } });
  await page.getByRole('button', { name: 'Sign in with Google to hatch your pet' }).click();
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google to hatch your pet' })).toBeVisible();
  await expect(page).toHaveURL(/\/hatch\?from=2$/);
});

// spec: add-account › Sign-in flow › вход не удался
test('вход не удался: Google never started on Home — the line and «Try again» on Home', async ({ page }) => {
  await openWith(page, '/', { auth: { outcome: 'start_failed' } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Sign-in flow › вход не удался
test('вход не удался: the same on a Home whose address carries the mark of the link to a real browser', async ({ page }) => {
  await openWith(page, '/?ib=x', { auth: { outcome: 'start_failed' } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await expect(page).toHaveURL(/\/\?ib=x$/);
});

// spec: add-account › Sign-in flow › вход не удался × Try again
test('вход не удался × Try again: after Google never started, it goes through with the tapped action', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: { outcome: 'start_failed' } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await setOutcome(page, 'start_failed');
  await page.getByRole('button', { name: 'Try again' }).click();
  // the same failure again: the line goes and comes back, and the button still answers
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login', 'privy:login']);
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await setOutcome(page, 'ok');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(FAILED)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/pet\/2$/);
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Sign-in flow › вход не удался × Try again
test('вход не удался × Try again: while Google is starting again, the record and the address are left alone', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: { outcome: 'start_failed' } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await setOutcome(page, 'held');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login', 'privy:login']);
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  expect(await recordOf(page)).toEqual({ path: '/pet/2', action: 'feed' });
});

// spec: add-account › Sign-in flow › вход начат × второй тап
test('вход начат × второй тап: taps while Google is starting change nothing; the place and the tapped action wait in the tab', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: { outcome: 'held' } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  expect(await gateReads(page)).toBe(1);
  expect(await privyCalls(page)).toEqual(['privy:load', 'privy:login']);
  expect(await recordOf(page)).toEqual({ path: '/pet/2', action: 'feed' });
});

// spec: add-account › Sign-in flow › отменил вход × Back от Google
test('отменил вход × Back от Google: a load at `/` with the place in the tab leads back to it, the record rewritten', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: { outcome: 'held' } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
  await page.reload();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  expect(await recordOf(page)).toEqual({ path: '/pet/2', action: 'feed', cancelled: true });
});

// spec: add-account › Home screen › signed-out × запись отмены
test('signed-out × запись отмены: Home opened by URL after a cancel stays Home, and the cancel\'s record goes', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: { outcome: 'cancelled' } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect.poll(() => recordOf(page)).toEqual({ path: '/pet/2', action: 'feed', cancelled: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Hatch your pet')).toBeVisible();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Home screen › signed-out × запись отмены
test('signed-out × запись отмены: a reload of Home the player reached by a link stays Home', async ({ page }) => {
  await openWith(page, '/hatch', { auth: { outcome: 'cancelled' } });
  await page.getByRole('button', { name: 'Sign in with Google to hatch your pet' }).click();
  await expect.poll(() => recordOf(page)).toEqual({ path: '/hatch', action: 'signin', cancelled: true });
  await page.evaluate(() => {
    history.pushState(null, '', '/');
    window.dispatchEvent(new Event('nearling:navigate'));
  });
  await expect(page.getByText('Hatch your pet')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Hatch your pet')).toBeVisible();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Sign-in flow › отменил вход
test('отменил вход: the same screen with no session, no error line on a desktop; the tapped action and the place are not lost', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: { outcome: 'cancelled' } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await expect(page.getByText(FAILED)).toHaveCount(0);
  await expect(page.getByText(FALLBACK)).toHaveCount(0);
  expect(JSON.parse((await placeOf(page))!)).toEqual({ path: '/pet/2', action: 'feed', cancelled: true });
});

// spec: add-account › Sign-in flow › отменил вход × Sign in сохраняет Feed
test('отменил вход × Sign in сохраняет Feed: «Sign in» after a cancel keeps the tapped «Feed»', async ({ page }) => {
  await watchReplace(page);
  await openWith(page, '/pet/2', { auth: { outcome: 'cancelled' } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(async () => (await places(page)).length).toBe(2);
  expect(JSON.parse((await places(page))[1]!)).toEqual({ path: '/pet/2', action: 'feed' });
});

test.describe('on a phone, in an ordinary browser', () => {
  test.use({ userAgent: UA.android });

  // spec: add-account › Sign-in flow › запасной путь на телефоне
  test('запасной путь на телефоне: after a cancel «Trouble signing in? Try it in your browser.» and «Open in browser»', async ({ page }) => {
    await openWith(page, '/pet/2', { auth: { outcome: 'cancelled' } });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(FALLBACK).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open in browser' })).toBeVisible();
    await expect(page.getByText(FAILED)).toHaveCount(0);
  });

  // spec: add-account › Sign-in flow › запасной путь на телефоне
  test('запасной путь на телефоне: after a sign-in that did not work both lines stand, the error first', async ({ page }) => {
    await openWith(page, '/pet/2', { auth: { outcome: 'failed' } });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(FAILED).first()).toBeVisible();
    await expect(page.getByText(FALLBACK).first()).toBeVisible();
  });

  // spec: add-account › Sign-in flow › запасной путь на телефоне × Open in browser
  test('запасной путь на телефоне × Open in browser: the Open in browser sheet with the link to the same place', async ({ page }) => {
    await openWith(page, '/pet/2', { auth: { outcome: 'cancelled' } });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Open in browser' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: 'Open in your browser to sign in' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Open in browser' }).click();
    const [call] = (await calls(page)).filter((c) => c.startsWith('open:'));
    // not an in-app browser: no mark, the place alone
    expect(call).toMatch(/^open:intent:\/\/127\.0\.0\.1:5199\/pet\/2#Intent;/);
  });

  // spec: add-account › Sign-in flow › запасной путь на телефоне
  test('запасной путь на телефоне: Google never started on a Pet screen — both lines stand at the place', async ({ page }) => {
    await openWith(page, '/pet/2', { auth: { outcome: 'start_failed' } });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(FAILED).first()).toBeVisible();
    await expect(page.getByText(FALLBACK).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open in browser' })).toBeVisible();
    await expect(page).toHaveURL(/\/pet\/2$/);
  });

  // spec: add-account › Sign-in flow › запасной путь на телефоне
  test('запасной путь на телефоне: Google never started on the Hatch screen — both lines stand at the place', async ({ page }) => {
    await openWith(page, '/hatch', { auth: { outcome: 'start_failed' } });
    await page.getByRole('button', { name: 'Sign in with Google to hatch your pet' }).click();
    await expect(page.getByText(FAILED).first()).toBeVisible();
    await expect(page.getByText(FALLBACK).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open in browser' })).toBeVisible();
    await expect(page).toHaveURL(/\/hatch$/);
  });

  // spec: add-account › Sign-in flow › запасной путь на телефоне
  test('запасной путь на телефоне: Google never started on Home — both lines stand on Home', async ({ page }) => {
    await openWith(page, '/', { auth: { outcome: 'start_failed' } });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(FAILED).first()).toBeVisible();
    await expect(page.getByText(FALLBACK).first()).toBeVisible();
  });

  // spec: add-account › Sign-in flow › запасной путь на телефоне
  test('запасной путь на телефоне: back from Google on Home with no callback — the line and «Open in browser» on Home, once', async ({ page }) => {
    await openWith(page, '/', { auth: { outcome: 'held' } });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
    // Back from Google: a load of `/`, the tab's memory as it was, no session, no code in the address
    await page.reload();
    await expect(page.getByText(FALLBACK).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open in browser' })).toBeVisible();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    expect(await placeOf(page)).toBeNull();
    // a plain load of Home has nothing to say
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText(FALLBACK)).toHaveCount(0);
  });

  // spec: add-account › Sign-in flow › запасной путь на телефоне × Open in browser
  test('запасной путь на телефоне × Open in browser: from Home the sheet opens, with the link to Home', async ({ page }) => {
    await openWith(page, '/', { auth: { outcome: 'held' } });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
    await page.reload();
    await page.getByRole('button', { name: 'Open in browser' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: 'Open in your browser to sign in' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Open in browser' }).click();
    const [call] = (await calls(page)).filter((c) => c.startsWith('open:'));
    expect(call).toMatch(/^open:intent:\/\/127\.0\.0\.1:5199\/#Intent;/);
  });
});

// spec: add-account › Sign-in flow › запасной путь на телефоне
test('запасной путь на телефоне: on a desktop browser a Back from Google on Home shows nothing and stays', async ({ page }) => {
  await openWith(page, '/', { auth: { outcome: 'held' } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText(FALLBACK)).toHaveCount(0);
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await expect.poll(() => placeOf(page)).toBeNull();
});

// spec: add-account › Sign-in flow › вход начат × чтение входа не удалось
test('вход начат × чтение входа не удалось: no walk to Google — the connection line and «Try again»; the action is not run', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { signIn: { fail: { status: 0, code: 'unreachable' } } } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  expect(await privyCalls(page)).toEqual([]);
  expect(await placeOf(page)).toBeNull();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await setWorker(page, { signIn: { state: 'open' } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
});

// spec: add-account › Sign-in flow › вход начат × чтение входа не удалось
// spec: add-pet › Connection rule › слишком много запросов
test('слишком много запросов: the gate read at a tap answers 429 — «Lots of visitors right now…», no walk to Google, «Try again» goes on', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { signIn: TOO_MANY } });
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByText(BUSY).first()).toBeVisible();
  await expect(page.getByText(OFFLINE)).toHaveCount(0);
  expect(await privyCalls(page)).toEqual([]);
  expect(await placeOf(page)).toBeNull();
  await setWorker(page, { signIn: { state: 'open' } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => privyCalls(page)).toEqual(['privy:load', 'privy:login']);
});

// spec: add-account › Sign-in flow › вход начат × чтение входа не удалось
// spec: add-pet › Connection rule › слишком много запросов
test('слишком много запросов: the same on the Hatch screen, and the name stays', async ({ page }) => {
  await openWith(page, '/hatch', { worker: { signIn: TOO_MANY } });
  await page.getByRole('button', { name: 'Sign in with Google to hatch your pet' }).click();
  await expect(page.getByText(BUSY).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(await privyCalls(page)).toEqual([]);
});

// spec: add-pet › Connection rule › сервер недоступен
test('сервер недоступен: the exchange of a page load gets no answer — «We can\'t reach the game right now…» and «Try again» in place of the screen', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: { authenticated: true, nearAccountId: 'a'.repeat(64) }, worker: { session: { fail: { status: 0, code: 'unreachable' } } } });
  await expect(page.getByRole('heading', { level: 1, name: "We can't reach the game right now. Try again in a moment." })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toHaveCount(0);
  await setWorker(page, { session: { ok: true } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
});
