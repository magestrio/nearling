import { expect, test } from '@playwright/test';
import { BISCUIT, calls, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const HATCH = 'Hatch my pet';
const hatchButton = (page: import('@playwright/test').Page) => page.getByRole('button', { name: HATCH });
const nameField = (page: import('@playwright/test').Page) => page.getByLabel('Name your pet');
const PUBLIC_FIRST = "Your pet's name, character, ID, hatch date";

// spec: add-pet › Hatch screen › empty
test('empty: the name field, the limit line, the first notice without a name, «Hatch my pet» inactive', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await expect(page.getByRole('heading', { level: 1, name: 'Hatch your pet' })).toBeVisible();
  await expect(nameField(page)).toHaveValue('');
  await expect(nameField(page)).toHaveAttribute('placeholder', 'e.g. Pixel');
  await expect(page.getByText('Up to 32 characters — fewer with emoji or accents.')).toBeVisible();
  await expect(page.getByText('This name is public forever — even if this game shuts down.')).toHaveCount(0);
  await expect(page.getByText(PUBLIC_FIRST)).toBeVisible();
  await expect(hatchButton(page)).toBeDisabled();
});

// spec: add-pet › Hatch screen › loading
test('loading: the notices, «Hatch my pet» inactive, the line «Checking if hatching is open…» in a status region until the check ends', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatusDelayMs: 1200 } });
  const line = page.getByRole('status').filter({ hasText: 'Checking if hatching is open…' });
  await expect(line).toHaveCount(1);
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

// spec: add-pet › Birth flow › не вылупился × имя остаётся при закрытии и без связи
test('the name stays when hatching closes between opening the screen and the tap', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await nameField(page).fill('Pixel');
  await setWorker(page, { hatchResult: { fail: { status: 409, code: 'closed' } }, hatchStatus: { open: false, reason: 'pool' } });
  await hatchButton(page).click();
  await expect(page.getByText('New pets are paused for now. You can still feed and visit pets you know.').first()).toBeVisible();
  await expect(nameField(page)).toHaveValue('Pixel');
  await expect(page.getByRole('link', { name: 'Go home' })).toBeVisible();
});

// spec: add-pet › Birth flow › не вылупился × имя остаётся при закрытии и без связи
test('the name stays when the game can\'t be reached at the tap, and «Try again» brings the form back', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchResult: { fail: { status: 503, code: 'chain_unreachable' } } } });
  await nameField(page).fill('Pixel');
  await hatchButton(page).click();
  await expect(page.getByText("We can't reach the game right now. Try again in a moment.").first()).toBeVisible();
  await expect(nameField(page)).toHaveValue('Pixel');
  await expect(hatchButton(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(hatchButton(page)).toBeEnabled();
  await expect(nameField(page)).toHaveValue('Pixel');
});

// spec: add-pet › Hatch screen › уже есть рождённый питомец
test('already hatched: the line and «Go to {name}» to the current pet', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: true, already: { tokenId: '9', name: 'Pixel' } } } });
  await expect(page.getByRole('heading', { level: 1, name: "You've already hatched a pet — one per player." })).toBeVisible();
  await page.getByRole('link', { name: 'Go to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-pet › Hatch screen › уже есть рождённый питомец × перезагрузка посреди рождения
test('a reload in the middle of a birth shows «already hatched» when the birth went through', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchDelayMs: 5000 } });
  // registered after the fakes' own script, so on the reload it runs second: the network now knows the pet
  await page.addInitScript(() => {
    const f = (globalThis as { __NEARLING_FAKES__?: { worker?: Record<string, unknown> } }).__NEARLING_FAKES__;
    if (f?.worker) f.worker.hatchStatus = { open: true, already: { tokenId: '9', name: 'Pixel' } };
  });
  await nameField(page).fill('Pixel');
  await hatchButton(page).click();
  await expect(page.getByRole('button', { name: 'Hatching…' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Go to Pixel' })).toBeVisible();
});

// spec: add-pet › Hatch screen › error
test('error: paused — the line and «Go home» in the button\'s place, the name stays', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'service' } } });
  await nameField(page).fill('Pixel');
  await expect(page.getByText('New pets are paused for now. You can still feed and visit pets you know.').first()).toBeVisible();
  await expect(hatchButton(page)).toHaveCount(0);
  await expect(nameField(page)).toHaveValue('Pixel');
});

// spec: add-pet › Hatch screen › рождения на сегодня закрыты
test('closed for today: the line with the reset time in the player\'s clock, the way out, no hatch button', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily', until: '2026-10-31T00:00:00.000Z' } } });
  await expect(page.getByText(/^That's all the new pets for today\. Hatching is back at \d\d:\d\d\. You can still feed and visit pets you know\.$/).first()).toBeVisible();
  await expect(hatchButton(page)).toHaveCount(0);
});

// spec: add-pet › Hatch screen › выход к питомцу друга
test('closed, from a friend\'s pet: «Back to Biscuit» leads to the friend\'s Pet screen', async ({ page }) => {
  await openWith(page, '/hatch?from=2', { worker: { hatchStatus: { open: false, reason: 'daily' } } });
  await page.getByRole('link', { name: 'Back to Biscuit' }).click();
  await expect(page).toHaveURL(/\/pet\/2$/);
});

// spec: add-pet › Hatch screen › выход на главную
test('closed, not from a friend, no session: «Go home» leads to the home address', async ({ page }) => {
  await openWith(page, '/hatch', { worker: { hatchStatus: { open: false, reason: 'pool' } } });
  await page.getByRole('link', { name: 'Go home' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: /^This pet pays for its own thoughts/ })).toBeVisible();
});

// spec: add-pet › Hatch screen › выход на главную
test('closed, not from a friend, a pet of their own: «Go home» leads to the home address, which leads on to the pet', async ({ page }) => {
  const me = { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { ...OWNER, me, hatchStatus: { open: false, reason: 'pool' } } });
  await page.getByRole('link', { name: 'Go home' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-pet › Hatch screen › выход к питомцу друга × the pet in the address doesn't exist
test('a ?from= with no pet: the way out is «Go home»', async ({ page }) => {
  await openWith(page, '/hatch?from=77', { worker: { hatchStatus: { open: false, reason: 'service' } } });
  await expect(page.getByRole('link', { name: 'Go home' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Back to/ })).toHaveCount(0);
});

// spec: add-pet › Hatch screen › рождения на сегодня закрыты × a visitor without a session
test('closed for a visitor without a session: the line and the way out, no sign-in, not one request to Privy', async ({ page }) => {
  await openWith(page, '/hatch?from=2', { worker: { hatchStatus: { open: false, reason: 'daily' } } });
  await expect(page.getByRole('link', { name: 'Back to Biscuit' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Sign in with Google/ })).toHaveCount(0);
  expect((await calls(page)).filter((c) => c.startsWith('privy:'))).toEqual([]);
});

// spec: add-pet › Hatch screen › error × a player who already hatched
test('closed for a player who already hatched: the closed line, not «already hatched»', async ({ page }) => {
  await openWith(page, '/hatch', {
    auth: SIGNED_IN,
    worker: { hatchStatus: { open: false, reason: 'pool', already: { tokenId: '9', name: 'Pixel' } } },
  });
  await expect(page.getByText('New pets are paused for now. You can still feed and visit pets you know.').first()).toBeVisible();
  await expect(page.getByText("You've already hatched a pet — one per player.")).toHaveCount(0);
});

// spec: add-pet › Hatch screen › no exit
test('no exit: a signed-in player with no pet and no friend link can find a pet to ask; «Account» and the name stay', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily', noPets: true } } });
  await nameField(page).fill('Pixel');
  await expect(page.getByText(/^That's all the new pets for today\. Hatching is back at \d\d:\d\d\. You can still feed and visit pets you know\.$/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
  await expect(hatchButton(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await expect(nameField(page)).toHaveValue('Pixel');
});

// spec: add-pet › Hatch screen › no exit
test('no exit: a friend\'s pet that exists still wins — «Back to Biscuit»', async ({ page }) => {
  await openWith(page, '/hatch?from=2', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily', noPets: true } } });
  await expect(page.getByRole('link', { name: 'Back to Biscuit' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go home' })).toHaveCount(0);
});

// spec: add-pet › Hatch screen › no exit
test('no exit: a player with a pet of their own (the answer has no `noPets`) keeps «Go home»', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily' } } });
  await expect(page.getByRole('link', { name: 'Go home' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
});

// spec: add-pet › Connection rule › сервер недоступен
test('the game can\'t be reached on a fresh load: the line, «Try again», «Hatch my pet» inactive, the name kept', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { fail: { status: 0, code: 'unreachable' } } } });
  await expect(page.getByText("We can't reach the game right now. Try again in a moment.").first()).toBeVisible();
  await expect(hatchButton(page)).toBeDisabled();
  await setWorker(page, { hatchStatus: { open: true } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(hatchButton(page)).toBeVisible();
});
