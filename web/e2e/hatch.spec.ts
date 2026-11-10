import { expect, test } from '@playwright/test';
import { BISCUIT, calls, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const HATCH = 'Hatch my pet';
const hatchButton = (page: import('@playwright/test').Page) => page.getByRole('button', { name: HATCH });
const nameField = (page: import('@playwright/test').Page) => page.getByLabel('Name your pet');
const PUBLIC_FIRST = "Your pet's name, character, ID, hatch date";
// DS 0.48: both notices start folded to one line each; their complete text opens by «Read what's public» / «Read what goes to NEAR AI»
const expandNotices = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: "Read what's public" }).click();
  await page.getByRole('button', { name: 'Read what goes to NEAR AI' }).click();
};

// spec: add-pet › Birth flow › birth pending
test('the pending Egg rocks for ordinary motion and holds still for reduced motion', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchDelayMs: 60_000 } });
  await nameField(page).fill('Pixel');
  await hatchButton(page).click();
  const shell = page.locator('.ds-egg--cracking .ds-egg__shell');
  await expect(shell).toBeVisible();
  await expect.poll(() => shell.evaluate((node) => getComputedStyle(node).animationName)).toBe('ds-egg-rock');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => shell.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
});

// spec: add-pet › Birth flow › birth pending
test('the pending Egg stops rocking after about five seconds and stands cracked while «Hatching…» stays', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchDelayMs: 60_000 } });
  await nameField(page).fill('Pixel');
  await hatchButton(page).click();
  const shell = page.locator('.ds-egg--cracking .ds-egg__shell');
  await expect(shell).toBeVisible();
  await expect.poll(() => shell.evaluate((node) => node.getAnimations().length)).toBe(1);
  await expect.poll(() => shell.evaluate((node) => node.getAnimations().length), { timeout: 9_000, intervals: [250] }).toBe(0);
  await expect(page.locator('.ds-egg--cracking')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hatching…' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toBeVisible();
});

// spec: add-pet › Hatch screen › empty
test('empty: the name field, the limit line, the first notice without a name, «Hatch my pet» inactive', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await expect(page.getByRole('heading', { level: 1, name: 'Hatch your pet' })).toBeVisible();
  await expect(nameField(page)).toHaveValue('');
  await expect(nameField(page)).toHaveAttribute('placeholder', 'e.g. Pixel');
  await expect(page.getByText('Up to 32 characters — fewer with emoji or accents.')).toBeVisible();
  await expect(page.getByText('This name is public forever — even if this game shuts down.')).toHaveCount(0);
  await expandNotices(page);
  await expect(page.getByText(PUBLIC_FIRST)).toBeVisible();
  await expect(hatchButton(page)).toBeDisabled();
});

// spec: add-pet › Hatch screen › loading
test('loading: the notices, «Hatch my pet» inactive, the line «Checking if hatching is open…» in a status region until the check ends', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatusDelayMs: 1200 } });
  const line = page.getByRole('status').filter({ hasText: 'Checking if hatching is open…' });
  await expect(line).toHaveCount(1);
  await expandNotices(page);
  await expect(page.getByText(PUBLIC_FIRST)).toBeVisible();
  await expect(hatchButton(page)).toBeDisabled();
  await expect(page.getByText('Checking if hatching is open…')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Checking if hatching is open…' })).toHaveCount(0);
});

// spec: add-pet › Hatch screen › success
test('success: a name makes the second line and the button active; «Hatch my pet» leads to Birth flow', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchDelayMs: 600 } });
  await nameField(page).fill('Pixel');
  await expect(page.getByText('This name is public forever — even if this game shuts down.')).toBeVisible();
  await expandNotices(page);
  await expect(page.getByText('Your pet\'s name "Pixel", character, ID')).toBeVisible();
  await expect(page.getByText("A thought's receipt shows how long the reply was and whether your pet thought hard — never what was said.")).toBeVisible();
  await expect(page.getByText("To write your pet's replies, we send NEAR AI")).toBeVisible();
  await expect(hatchButton(page)).toBeEnabled();
  await hatchButton(page).click();
  // spec: add-pet › Birth flow › вылупился (the client's part: the new pet's screen)
  await expect(page.getByRole('button', { name: 'Hatching…' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-pet › Hatch screen › signed-out
test('signed-out: the form is there, «Sign in with Google to hatch your pet» in the button\'s place; the place waits in the tab and Privy gets `/`', async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (globalThis as { __REPLACED__?: string[] }).__REPLACED__ = seen;
    const original = history.replaceState.bind(history);
    history.replaceState = (data, unused, url) => {
      seen.push(String(url));
      original(data, unused, url);
    };
  });
  await openWith(page, '/hatch', {});
  await expect(nameField(page)).toBeVisible();
  await expandNotices(page);
  await expect(page.getByText("To write your pet's replies, we send NEAR AI")).toBeVisible();
  await expect(hatchButton(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in with Google to hatch your pet' }).click();
  // Privy was given `/`, then the tab went back to the Hatch screen
  await expect(page).toHaveURL(/\/hatch$/);
  expect(await page.evaluate(() => (globalThis as { __REPLACED__?: string[] }).__REPLACED__)).toEqual(['/', '/hatch']);
  await expect(hatchButton(page)).toBeDisabled();
});

// spec: add-pet › Birth flow › пришёл по ссылке друга × вход на Hatch screen с адресом друга
test('a visitor from a friend\'s pet signs in and is back on the Hatch screen with the friend in the address', async ({ page }) => {
  await openWith(page, '/hatch?from=2', {});
  await page.getByRole('button', { name: 'Sign in with Google to hatch your pet' }).click();
  await expect(page).toHaveURL(/\/hatch\?from=2$/);
  await nameField(page).fill('Pixel');
  await hatchButton(page).click();
  // spec: add-pet › Birth flow › пришёл по ссылке друга
  await expect(page).toHaveURL(/\/pet\/9\?from=2$/);
});

// spec: add-pet › Birth flow › пришёл по ссылке друга
test('the newborn that came from a friend\'s pet has «Back to Biscuit» in the header, leading to the friend\'s Pet screen', async ({ page }) => {
  await openWith(page, '/pet/9?from=2', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, stage: 'baby', owner: { hello: true } }, '2': BISCUIT }, conversation: { lines: [], more: false, before: null }, petState: { pending: true } } });
  const back = page.getByRole('link', { name: 'Back to Biscuit' });
  await expect(back).toHaveAttribute('href', '/pet/2');
  await back.click();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
});

// spec: add-pet › Birth flow › пришёл по ссылке друга
test('without a friend in the address the Pet screen has no «Back to»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);
});

// spec: add-pet › Public pet data › имя до «Hatch my pet»
test('the name is cleaned in the browser for the notice and goes to the server only on the tap, as typed', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchDelayMs: 300 } });
  const typed = 'Pi\u200Bxel ';
  await nameField(page).fill(typed);
  await expandNotices(page);
  await expect(page.getByText('Your pet\'s name "Pixel", character, ID')).toBeVisible();
  expect((await calls(page)).filter((c) => c.startsWith('worker:hatch:'))).toEqual([]);
  await hatchButton(page).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  expect((await calls(page)).filter((c) => c.startsWith('worker:hatch:'))).toEqual([`worker:hatch:${typed}`]);
});

// spec: add-pet › Hatch screen › уведомление о публичности
test('the public-data notice names every public item, the skill included, with the cleaned name', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await nameField(page).fill('Pixel');
  await expandNotices(page);
  await expect(
    page.getByText(
      'Your pet\'s name "Pixel", character, ID, hatch date, owner and who gave it to whom, growth, traits, streak and freezes (so the days you finish its ritual), every outfit, meal and thought receipt, every pet it asks for help or helps, whether a skill shaped it, and every price and fee are public forever — even if this game shuts down.',
      { exact: true },
    ),
  ).toBeVisible();
});

// spec: add-pet › Hatch screen › уведомление о публичности × в поле одни пробелы или невидимые
test('only blanks or invisibles in the field: the notice has no name, the button is active, the refusal keeps the text', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await nameField(page).fill('   \u200B ');
  await expandNotices(page);
  await expect(page.getByText(PUBLIC_FIRST)).toBeVisible();
  await expect(page.getByText('This name is public forever — even if this game shuts down.')).toHaveCount(0);
  await expect(hatchButton(page)).toBeEnabled();
  await hatchButton(page).click();
  // spec: add-pet › Birth flow › имя не принято
  await expect(page.getByText("Let's pick a different name.")).toBeVisible();
  await expect(nameField(page)).toHaveValue('   \u200B ');
  await expect(hatchButton(page)).toBeEnabled();
  await expect(page).toHaveURL(/\/hatch$/);
});

// spec: add-pet › Birth flow › вылупился × второй тап
test('a second tap while hatching makes no second request', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchDelayMs: 800 } });
  await nameField(page).fill('Pixel');
  await hatchButton(page).dblclick();
  await expect(page).toHaveURL(/\/pet\/9$/);
  expect((await calls(page)).filter((c) => c === 'worker:hatch')).toHaveLength(1);
});

// spec: add-pet › Birth flow › не вылупился
test('not hatched: the line and «Try again»; the name is kept and the retry hatches', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchResult: { fail: { status: 502, code: 'not_hatched' } } } });
  await nameField(page).fill('Pixel');
  await hatchButton(page).click();
  await expect(page.getByText("Your pet didn't hatch this time. Nothing was lost — try again.").first()).toBeVisible();
  await expect(nameField(page)).toHaveValue('Pixel');
  await setWorker(page, { hatchResult: { tokenId: '9' } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-pet › Birth flow › birth pending
test('birth pending: an unheard birth remains pending with its name after a reload', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchDelayMs: 60_000 } });
  await nameField(page).fill('Pixel');
  await hatchButton(page).click();
  await expect(page.getByRole('button', { name: 'Hatching…' })).toBeVisible();
  await page.reload();
  await expect(nameField(page)).toHaveValue('Pixel');
  await expect(page.getByRole('button', { name: 'Hatching…' })).toBeVisible();
  await expect(hatchButton(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect((await calls(page)).filter((call) => call.startsWith('worker:hatch:'))).toEqual([]);
});

/** After the next reload the Worker's status answer is `status` (the fakes themselves start over on a reload). */
async function statusAfterReload(page: import('@playwright/test').Page, status: Record<string, unknown>): Promise<void> {
  await page.addInitScript((s) => {
    const g = globalThis as { __NEARLING_FAKES__?: { worker?: Record<string, unknown> } };
    if (sessionStorage.getItem('e2e:status-after-reload') === '1') {
      g.__NEARLING_FAKES__ = { ...g.__NEARLING_FAKES__, worker: { ...g.__NEARLING_FAKES__?.worker, hatchStatus: s } };
    }
  }, status);
  await page.evaluate(() => sessionStorage.setItem('e2e:status-after-reload', '1'));
}

// spec: add-pet › Birth flow › не вылупился
test('a reload after a failed birth restores the typed name and «Try again» hatches', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchResult: { fail: { status: 503, code: 'chain_unreachable' } } } });
  await nameField(page).fill('Pixel');
  await hatchButton(page).click();
  await expect(page.getByRole('button', { name: 'Hatching…' })).toBeVisible();
  await statusAfterReload(page, { open: true, failed: true });
  await page.reload();
  await expect(page.getByText("Your pet didn't hatch this time. Nothing was lost — try again.").first()).toBeVisible();
  await expect(nameField(page)).toHaveValue('Pixel');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeEnabled();
  await setWorker(page, { hatchResult: { tokenId: '9' }, hatchStatus: { open: true } });
  await retry.click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-pet › Birth flow › birth pending
test('no birth in flight after a reload: «Hatching…» ends, the saved name returns and the form hatches', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchResult: { fail: { status: 503, code: 'chain_unreachable' } } } });
  await nameField(page).fill('Pixel');
  await hatchButton(page).click();
  await expect(page.getByRole('button', { name: 'Hatching…' })).toBeVisible();
  await statusAfterReload(page, { open: true });
  await page.reload();
  await expect(nameField(page)).toHaveValue('Pixel');
  await expect(page.getByRole('button', { name: 'Hatching…' })).toHaveCount(0);
  await expect(hatchButton(page)).toBeEnabled();
  await setWorker(page, { hatchResult: { tokenId: '9' } });
  await hatchButton(page).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-pet › Birth flow › не вылупился × имя остаётся при закрытии и без связи
// spec: add-hatch-again › Hatch again screen › birth paused
test('the name stays when hatching closes between opening the screen and the tap', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await nameField(page).fill('Pixel');
  await setWorker(page, { hatchResult: { fail: { status: 409, code: 'closed' } }, hatchStatus: { open: false, reason: 'pool' } });
  await hatchButton(page).click();
  await expect(page.getByText('New pets are paused for now.').first()).toBeVisible();
  await expect(nameField(page)).toHaveValue('Pixel');
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
});

// spec: add-pet › Birth flow › birth pending
test('a lost connection at the tap is an unknown outcome: «Hatching…», the name stays, until the original hash is confirmed', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchResult: { fail: { status: 503, code: 'chain_unreachable' } } } });
  await nameField(page).fill('Pixel');
  await hatchButton(page).click();
  await expect(page.getByRole('button', { name: 'Hatching…' })).toBeVisible();
  await expect(nameField(page)).toHaveValue('Pixel');
  await expect(page.getByText("We can't reach the game right now. Try again in a moment.")).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  // the original attempt's token, never the earlier birth pointer, settles it (`Repeat birth recovery data`)
  await setWorker(page, { hatchStatus: { open: true, tokenId: '9' } });
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-hatch-again › Hatch again screen › already owns a pet
test('already owns a pet: the line and «Go to {name}» to the current pet', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: true, ownedCount: 1, currentPet: { tokenId: '9', name: 'Pixel' }, already: { tokenId: '9', name: 'Pixel' } } } });
  await expect(page.getByText('You have a pet already.').first()).toBeVisible();
  await page.getByRole('link', { name: 'Go to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-pet › Hatch screen › уже есть рождённый питомец × перезагрузка посреди рождения
// spec: add-hatch-again › Repeat birth flow › confirmed birth
test('a reload in the middle of a birth leads to the pet when the birth went through', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchDelayMs: 5000 } });
  // registered after the fakes' own script, so on the reload it runs second: the network now knows the pet
  await page.addInitScript(() => {
    const f = (globalThis as { __NEARLING_FAKES__?: { worker?: Record<string, unknown> } }).__NEARLING_FAKES__;
    if (f?.worker) f.worker.hatchStatus = { open: true, tokenId: '9' };
  });
  await nameField(page).fill('Pixel');
  await hatchButton(page).click();
  await expect(page.getByRole('button', { name: 'Hatching…' })).toBeVisible();
  await page.reload();
  // the name is held for this account, so a confirmed birth leads to the pet (`Birth flow` › «вылупился»)
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-hatch-again › Hatch again screen › birth paused
test('paused: the line in the button\'s place, the board link stays, the name stays', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'service' } } });
  await nameField(page).fill('Pixel');
  await expect(page.getByText('New pets are paused for now.').first()).toBeVisible();
  await expect(hatchButton(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
  await expect(nameField(page)).toHaveValue('Pixel');
});

// spec: add-hatch-again › Hatch again screen › birth paused
test('a visitor at a paused Hatch sees the pause and board exit', async ({ page }) => {
  await openWith(page, '/hatch', { worker: { hatchStatus: { open: false, reason: 'service' } } });
  await expect(page.getByText('New pets are paused for now.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
});

// spec: add-hatch-again › Hatch again screen › birth closed for the day
test('closed for today: the line with the reset time in the player\'s clock, the way out, no hatch button', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily', until: '2026-10-31T00:00:00.000Z' } } });
  await expect(page.getByText(/^That's all the new pets for today\. Hatching is back at \d\d:\d\d\.$/).first()).toBeVisible();
  await expect(hatchButton(page)).toHaveCount(0);
});

// spec: add-pet › Hatch screen › выход к питомцу друга
test('closed, from a friend\'s pet: «Back to Biscuit» leads to the friend\'s Pet screen', async ({ page }) => {
  await openWith(page, '/hatch?from=2', { worker: { hatchStatus: { open: false, reason: 'daily' } } });
  // the frame `hatch-closed-today` draws «Find a pet to ask» beside «Back to Biscuit»
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveCount(1);
  await page.getByRole('link', { name: 'Back to Biscuit' }).click();
  await expect(page).toHaveURL(/\/pet\/2$/);
});

// spec: add-hatch-again › Hatch again screen › birth paused
test('closed, not from a friend, no session: the board exit stays available', async ({ page }) => {
  await openWith(page, '/hatch', { worker: { hatchStatus: { open: false, reason: 'pool' } } });
  await expect(page.getByText('New pets are paused for now.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
});

// spec: add-hatch-again › Hatch again screen › already owns a pet
test('closed, a pet of their own: «Go to {name}» replaces «Go home» and leads to the pet', async ({ page }) => {
  const pixel = { tokenId: '9', name: 'Pixel' };
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { ...OWNER, hatchStatus: { open: false, reason: 'pool', ownedCount: 1, currentPet: pixel } } });
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Go to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-hatch-again › Hatch again screen › birth paused
test('a ?from= with no pet keeps the board exit', async ({ page }) => {
  await openWith(page, '/hatch?from=77', { worker: { hatchStatus: { open: false, reason: 'service' } } });
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
  await expect(page.getByRole('link', { name: /Back to/ })).toHaveCount(0);
});

// spec: add-hatch-again › Hatch again screen › birth closed for the day
test('closed for a visitor without a session: the line and the way out, no sign-in, not one request to Privy', async ({ page }) => {
  await openWith(page, '/hatch?from=2', { worker: { hatchStatus: { open: false, reason: 'daily' } } });
  await expect(page.getByText(/^That's all the new pets for today\. Hatching is back at \d\d:\d\d\.$/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
  await expect(page.getByRole('link', { name: 'Back to Biscuit' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Sign in with Google/ })).toHaveCount(0);
  expect((await calls(page)).filter((c) => c.startsWith('privy:'))).toEqual([]);
});

// spec: add-hatch-again › Hatch again screen › birth paused
test('paused for a player who hatched before and owns nothing now: the paused line, not «already»', async ({ page }) => {
  await openWith(page, '/hatch', {
    auth: SIGNED_IN,
    worker: { hatchStatus: { open: false, reason: 'pool', ownedCount: 0, currentPet: null, latestBirth: { tokenId: '9', name: 'Pixel' }, knownPets: [{ tokenId: '9', name: 'Pixel', asleep: false }] } },
  });
  await expect(page.getByText('New pets are paused for now.').first()).toBeVisible();
  await expect(page.getByText('You have a pet already.')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toHaveAttribute('href', '/pet/9');
});

// spec: add-hatch-again › Hatch again screen › birth closed for the day
test('exit to the board: a signed-in player with no pet can find a pet to ask; «Account» and the name stay', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily' } } });
  await nameField(page).fill('Pixel');
  await expect(page.getByText(/^That's all the new pets for today\. Hatching is back at \d\d:\d\d\.$/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
  await expect(hatchButton(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await expect(nameField(page)).toHaveValue('Pixel');
  await page.getByRole('link', { name: 'Find a pet to ask' }).click();
  await expect(page).toHaveURL(/\/hire$/);
});

// spec: add-hatch-again › Hatch again screen › friend's pet return
test('exit to the board: a friend link keeps «Back to Biscuit» beside «Find a pet to ask»', async ({ page }) => {
  await openWith(page, '/hatch?from=2', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily' } } });
  await expect(page.getByRole('link', { name: 'Back to Biscuit' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveCount(0);
});

// spec: add-hatch-again › Hatch again screen › birth closed for the day
test('exit to the board: a player who gave every pet away sees the closed line, «Visit Pixel» and «Find a pet to ask»', async ({ page }) => {
  await openWith(page, '/hatch', {
    auth: SIGNED_IN,
    worker: { hatchStatus: { open: false, reason: 'daily', knownPets: [{ tokenId: '9', name: 'Pixel', asleep: false }] } },
  });
  await expect(page.getByText(/^That's all the new pets for today\./).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toHaveAttribute('href', '/pet/9');
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
});

// spec: add-hatch-again › Hatch again screen › already owns a pet
test('a player with a pet of their own at a closed screen has «Go to {name}» and «Account»', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily', ownedCount: 1, currentPet: { tokenId: '9', name: 'Pixel' } } } });
  await expect(page.getByRole('link', { name: 'Go to Pixel' })).toHaveAttribute('href', '/pet/9');
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
});

// spec: add-hatch-again › Hatch again screen › error
test('the game can\'t be reached on a fresh load: the line, «Try again» in the hatch button\'s place, no birth sent', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { fail: { status: 0, code: 'unreachable' } } } });
  await expect(page.getByText("We couldn't check hatching right now. Try again.").first()).toBeVisible();
  await expect(hatchButton(page)).toHaveCount(0);
  await setWorker(page, { hatchStatus: { open: true } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(hatchButton(page)).toBeVisible();
});

// ── add-game-layout › Hatch notice rule ──────────────────────────────────────────────────────────────────────

const PUBLIC_LINE = "Your pet's name, character and on-chain history are public forever.";
const AI_LINE = "Your words and your pet's memories about you and friends who feed it go to NEAR AI.";
const SAVED = "Saved food and a bought outfit are public on NEAR forever. The wish's words stay private.";
const AI_FULL = "To write your pet's replies, we send NEAR AI what you say";
const publicOpener = (page: import('@playwright/test').Page) => page.getByRole('button', { name: "Read what's public" });
const aiOpener = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Read what goes to NEAR AI' });
const hide = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Hide details' });
// with a name in the field the full notice carries it: Your pet's name "Pixel", character, ID, hatch date …
const fullPublic = (page: import('@playwright/test').Page) => page.getByText(/^Your pet's name( ".*")?, character, ID, hatch date/);
const fullAi = (page: import('@playwright/test').Page) => page.getByText(AI_FULL);

// spec: add-game-layout › Hatch notice rule › public notice folded
test('public notice folded: its short line and «Read what\'s public»; the full text comes only with the tap', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await expect(page.getByText(PUBLIC_LINE)).toBeVisible();
  await expect(publicOpener(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(fullPublic(page)).toHaveCount(0);
  await expect(page.getByText(SAVED)).toHaveCount(0);
  await publicOpener(page).click();
  await expect(fullPublic(page)).toBeVisible();
  await expect(page.getByText(SAVED)).toBeVisible();
  await expect(page.getByText("A thought's receipt shows how long the reply was and whether your pet thought hard — never what was said.")).toBeVisible();
});

// spec: add-game-layout › Hatch notice rule › AI notice folded
test('AI notice folded: its short line and «Read what goes to NEAR AI»; the full provider notice comes with the tap', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await expect(page.getByText(AI_LINE)).toBeVisible();
  await expect(aiOpener(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(fullAi(page)).toHaveCount(0);
  await aiOpener(page).click();
  await expect(fullAi(page)).toBeVisible();
});

// spec: add-game-layout › Hatch notice rule › public notice folded × expand public
// spec: add-game-layout › Hatch notice rule › AI notice folded × expand AI
test('expanding one notice opens only its own full text', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await publicOpener(page).click();
  await expect(fullPublic(page)).toBeVisible();
  await expect(fullAi(page)).toHaveCount(0);
  await hide(page).click();
  await expect(fullPublic(page)).toHaveCount(0);
  await aiOpener(page).click();
  await expect(fullAi(page)).toBeVisible();
  await expect(fullPublic(page)).toHaveCount(0);
});

// spec: add-game-layout › Hatch notice rule › notice expanded
// spec: add-game-layout › Hatch notice rule › notice expanded × expand other
// spec: add-game-layout › Hatch notice rule › notice expanded × Hide details
test('notice expanded: its short line stays, «Hide details» folds only that notice, the other one is its own', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await nameField(page).fill('Pixel');
  await publicOpener(page).click();
  await aiOpener(page).click();
  await expect(page.getByText(PUBLIC_LINE)).toBeVisible();
  await expect(page.getByText(AI_LINE)).toBeVisible();
  await expect(fullPublic(page)).toBeVisible();
  await expect(fullAi(page)).toBeVisible();
  await expect(hide(page)).toHaveCount(2);
  await hide(page).first().click();
  await expect(fullPublic(page)).toHaveCount(0);
  await expect(fullAi(page)).toBeVisible();
  await expect(page.getByText(PUBLIC_LINE)).toBeVisible();
  await expect(nameField(page)).toHaveValue('Pixel');
});

// spec: add-game-layout › Hatch notice rule › notice expanded × name edit
test('a name edit with a notice open puts the current name in the full text and leaves the other notice as it was', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await publicOpener(page).click();
  await nameField(page).fill('Pixel');
  await expect(page.getByText('Your pet\'s name "Pixel", character, ID')).toBeVisible();
  await nameField(page).fill('Nori');
  await expect(page.getByText('Your pet\'s name "Nori", character, ID')).toBeVisible();
  await expect(aiOpener(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(fullAi(page)).toHaveCount(0);
});

// spec: add-game-layout › Hatch notice rule › public notice folded × submit
// spec: add-game-layout › Hatch notice rule › notice expanded × submit
test('the button below both lines stays the consent: the birth starts folded or expanded', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchDelayMs: 600 } });
  await nameField(page).fill('Pixel');
  await publicOpener(page).click();
  await expect(hatchButton(page)).toBeEnabled();
  await hatchButton(page).click();
  await expect(page.getByRole('button', { name: 'Hatching…' })).toHaveAttribute('aria-disabled', 'true');
  expect((await calls(page)).filter((call) => call === 'worker:hatch')).toHaveLength(1);
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-game-layout › Hatch notice rule › public notice folded × submit
test('folded notices: the consent button still hatches, and the full texts were never needed to ask it', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchDelayMs: 300 } });
  await nameField(page).fill('Pixel');
  await expect(publicOpener(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(aiOpener(page)).toHaveAttribute('aria-expanded', 'false');
  await hatchButton(page).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-game-layout › Hatch notice rule › notice expanded × sign-out
test('sign-out with a notice open: the signed-out Hatch, folded again', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await publicOpener(page).click();
  await expect(fullPublic(page)).toBeVisible();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/hatch');
  await expect(publicOpener(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(fullPublic(page)).toHaveCount(0);
});

// spec: add-game-layout › Hatch notice rule › notice expanded × session expiry
test('a session that ends with a notice open leaves the signed-out Hatch with the notices folded', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await aiOpener(page).click();
  await expect(fullAi(page)).toBeVisible();
  // Privy loses the session from under the open page (another tab signed out); the next tap on «Account» finds it
  await page.evaluate(() => window.dispatchEvent(new Event('nearling:fake-session-lost')));
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByText("You've been signed out. Sign in to pick up where you left off.").first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  // the next entry to Hatch has the notices folded
  await page.goto('/hatch');
  await expect(aiOpener(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(fullAi(page)).toHaveCount(0);
});

// spec: add-game-layout › Hatch notice rule › notice expanded × reload
// spec: add-game-layout › Hatch notice rule › notice expanded × site data erased
test('a reload or erased site data brings the notices back folded', async ({ page, context }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await publicOpener(page).click();
  await aiOpener(page).click();
  await page.reload();
  await expect(fullPublic(page)).toHaveCount(0);
  await expect(fullAi(page)).toHaveCount(0);
  await publicOpener(page).click();
  await context.clearCookies();
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await expect(fullPublic(page)).toHaveCount(0);
  await expect(publicOpener(page)).toHaveAttribute('aria-expanded', 'false');
});

// spec: add-game-layout › Hatch notice rule › notice expanded × tab hidden then back
// spec: add-game-layout › Hatch notice rule › notice expanded × UTC midnight
test('the tab coming back or midnight passing leaves the eligibility to the Hatch read and the open notice open', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await nameField(page).fill('Pixel');
  await publicOpener(page).click();
  const reads = async () => (await calls(page)).filter((c) => c === 'worker:hatchStatus').length;
  const before = await reads();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // the tab's return reads the eligibility again (`Hatch again screen`); it is answered before the pool is spent
  await expect.poll(reads).toBeGreaterThan(before);
  await expect(fullPublic(page)).toBeVisible();
  await expect(hatchButton(page)).toBeEnabled();
  // hatching closed meanwhile (the day's pool is spent): the tap is the authority, as without a notice open
  await setWorker(page, { hatchResult: { fail: { status: 409, code: 'closed' } }, hatchStatus: { open: false, reason: 'pool' } });
  await hatchButton(page).click();
  await expect(page.getByText('New pets are paused for now.').first()).toBeVisible();
  await expect(nameField(page)).toHaveValue('Pixel');
});
