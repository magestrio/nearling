import { expect, test, type Page } from '@playwright/test';
import { BISCUIT, calls, CLOSED_NEW, lookAgain, openWith, OWNER, PIXEL, privyCalls, setWorker, SIGNED_IN, UA } from './helpers';

const TYPED = 'And if they ask why the chart matters?';
const LINE = "You've been signed out. Sign in to pick up where you left off.";
const OFFLINE = "Can't reach Pixel right now. Nothing's lost — try again in a moment.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';
const FAILED = "We couldn't sign you in with Google. Try again in a moment.";
const FALLBACK = 'Trouble signing in? Try it in your browser.';
const NO_ANSWER = { fail: { status: 0, code: 'unreachable' } };
const TOO_MANY = { fail: { status: 429, code: 'rate_limited' } };
const ME_PIXEL = { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };
const ME_NO_PET = { accountId: 'a'.repeat(64), hatched: null, currentPet: null, ownedCount: 0 };
const START_FAILS = { ...SIGNED_IN, outcome: 'start_failed' as const };
const field = (page: Page) => page.getByPlaceholder('Talk to Pixel…');
const clearDialog = (page: Page) => page.getByRole('alertdialog', { name: "Clear Pixel's memory?" });
const placeOf = (page: Page) => page.evaluate(() => sessionStorage.getItem('nearling.returnPlace'));
const petStateCalls = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:petState').length;
const setOutcome = (page: Page, outcome: 'ok' | 'start_failed') =>
  page.evaluate((o) => {
    const g = globalThis as { __NEARLING_FAKES__?: { auth?: Record<string, unknown> } };
    g.__NEARLING_FAKES__!.auth = { ...g.__NEARLING_FAKES__!.auth, outcome: o };
  }, outcome);
/** The owner's page after a tap found the session ended: the line, the field off with its text. */
const lineOnOwnerPage = async (page: Page, auth: typeof START_FAILS | typeof SIGNED_IN = SIGNED_IN) => {
  await openWith(page, '/pet/9', { auth, worker: OWNER });
  await field(page).fill(TYPED);
  await endSession(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
};
/** The session ends under the open page; the next look of the page finds it. */
const endSession = async (page: Page) => {
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
};
/** Another tab of this browser signed out: Privy in this tab loses its session from under the open page. */
const loseSession = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('nearling:fake-session-lost')));
/** The tab's memory is erased at the moment Privy reads the return address: the sign-in comes back to a tab with no place. */
const losePlace = (page: Page) =>
  page.addInitScript(() => {
    const original = history.replaceState.bind(history);
    history.replaceState = (data, unused, url) => {
      if (String(url) === '/') sessionStorage.removeItem('nearling.returnPlace');
      original(data, unused, url);
    };
  });

// spec: add-account › Session expiry flow › session ended, no tap yet × опрос видит 401
test('session ended, no tap yet × опрос видит 401: nothing on the page changes, the polls stop, the field still takes typing', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await field(page).fill(TYPED);
  const before = await petStateCalls(page);
  await endSession(page);
  await expect.poll(() => petStateCalls(page)).toBeGreaterThan(before);
  // no line, no «Sign in», the pet, the conversation and the typed text as they were
  await expect(page.getByText(LINE)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await expect(field(page)).toHaveValue(TYPED);
  await expect(field(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  // the polls stopped: another look asks nothing more
  const after = await petStateCalls(page);
  await lookAgain(page);
  await page.waitForTimeout(600);
  expect(await petStateCalls(page)).toBe(after);
  // and the field still takes typing
  await field(page).pressSequentially(' More.');
  await expect(field(page)).toHaveValue(`${TYPED} More.`);
});

// spec: add-account › Session expiry flow › session ended, no tap yet × вторая вкладка после выхода
test('session ended, no tap yet × вторая вкладка после выхода: Privy loses the session from under the page — nothing changes, no new data loads', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await field(page).fill(TYPED);
  await loseSession(page);
  await expect(page.getByText(LINE)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await expect(field(page)).toHaveValue(TYPED);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  // the polls stopped: a look asks nothing
  const before = await petStateCalls(page);
  await lookAgain(page);
  await page.waitForTimeout(600);
  expect(await petStateCalls(page)).toBe(before);
  // a tap then shows the line
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
});

// spec: add-account › Session expiry flow › session ended, no tap yet × переход на другой адрес
test('session ended, no tap yet × переход на другой адрес: the new screen is a visitor\'s', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  const before = await petStateCalls(page);
  await endSession(page);
  await expect.poll(() => petStateCalls(page)).toBeGreaterThan(before);
  await page.evaluate(() => {
    window.history.pushState(null, '', '/pet/2');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
  await expect(page.getByText(LINE)).toHaveCount(0);
});

// spec: add-account › Session expiry flow › session ended, no tap yet × 401 на первой загрузке
test('session ended, no tap yet × 401 на первой загрузке: nothing was shown, so the page opens as a visitor\'s, with no line', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, expiredAfterExchange: true } });
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
  await expect(page.getByText(LINE)).toHaveCount(0);
  // the visitor's Stage keeps the advice log, never the owner's conversation
  await expect(page.getByRole('log')).toHaveAccessibleName('Advice from Pixel');
  await expect(page.getByText('Barely. Big presentation at ten.')).toHaveCount(0);
});

// spec: add-account › Session expiry flow › сессия кончилась при открытом экране
test('сессия кончилась при открытом экране: «Send» — the line, nothing sent, the text stays in the field, «Sign in» in «Send»\'s place', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await field(page).fill(TYPED);
  await endSession(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: LINE })).toHaveCount(1);
  await expect(field(page)).toHaveValue(TYPED);
  await expect(field(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  expect((await calls(page)).filter((c) => c.startsWith('worker:say'))).toEqual([]);
  // the conversation shows no line of the player's that was not sent
  await expect(page.getByRole('log').getByText(TYPED)).toHaveCount(0);
});

// spec: add-account › Session expiry flow › сессия кончилась при открытом экране
test('сессия кончилась при открытом экране: the tap itself met the 401 — the same line, the text back in the field', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await field(page).fill(TYPED);
  // the session ended and no look has found it yet: «Send» asks the server and is refused
  await setWorker(page, { sessionExpired: true });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(field(page)).toHaveValue(TYPED);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('log').getByText(TYPED)).toHaveCount(0);
});

// spec: add-account › Session expiry flow › сессия кончилась при открытом экране × тап на Account
test('сессия кончилась при открытом экране × тап на Account: no menu, the line and «Sign in»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await endSession(page);
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

// spec: add-account › Session expiry flow › сессия кончилась при открытом экране × Clear memory
test('сессия кончилась при открытом экране × Clear memory: the menu closes first, the same line', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await endSession(page);
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(clearDialog(page)).toHaveCount(0);
});

const openClearDialog = async (page: Page) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await expect(clearDialog(page)).toBeVisible();
};
const dialogGaveWay = async (page: Page) => {
  await expect(clearDialog(page)).toHaveCount(0);
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
};

// spec: add-account › Session expiry flow › сессия кончилась при открытом экране × Clear memory
test('сессия кончилась при открытом экране × Clear memory: the session ended with the dialog open — the dialog goes, the same line, the conversation stands, nothing is sent', async ({ page }) => {
  await openClearDialog(page);
  const before = await petStateCalls(page);
  await endSession(page);
  await expect.poll(() => petStateCalls(page)).toBeGreaterThan(before);
  await clearDialog(page).getByRole('button', { name: 'Clear memory' }).click();
  await dialogGaveWay(page);
  expect((await calls(page)).filter((c) => c.startsWith('worker:clearMemory'))).toEqual([]);
});

// spec: add-account › Session expiry flow › сессия кончилась при открытом экране × Clear memory
test('сессия кончилась при открытом экране × Clear memory: the tap itself met the 401 — the dialog goes, the same line, the conversation stands', async ({ page }) => {
  await openClearDialog(page);
  await setWorker(page, { clearMemory: { fail: { status: 401, code: 'signed_out' } } });
  await clearDialog(page).getByRole('button', { name: 'Clear memory' }).click();
  await dialogGaveWay(page);
  expect(await calls(page)).toContain('worker:clearMemory:9');
});

const HATCH_VIEWS: Array<[string, Record<string, unknown>, (page: Page) => Promise<void>]> = [
  [
    'closed',
    { hatchStatus: { open: false, reason: 'pool' } },
    async (page) => {
      await expect(page.getByLabel('Name your pet')).toBeVisible();
    },
  ],
  [
    'no exit',
    { hatchStatus: { open: false, reason: 'daily', noPets: true } },
    async (page) => {
      await expect(page.getByLabel('Name your pet')).toBeVisible();
    },
  ],
  [
    'already',
    { hatchStatus: { open: true, already: { tokenId: '9', name: 'Pixel' } } },
    async (page) => {
      await expect(page.getByRole('link', { name: 'Go to Pixel' })).toBeVisible();
    },
  ],
  [
    'unreachable',
    { hatchStatus: NO_ANSWER },
    async (page) => {
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    },
  ],
  [
    'checking',
    { hatchStatusDelayMs: 3_600_000 },
    async (page) => {
      await expect(page.getByText('Checking if hatching is open…').first()).toBeVisible();
    },
  ],
];

for (const [view, worker, shown] of HATCH_VIEWS) {
  // spec: add-account › Session expiry flow › сессия кончилась при открытом экране × тап на Account
  test(`сессия кончилась при открытом экране × тап на Account: Hatch's «${view}» — no menu, the line and «Sign in»`, async ({ page }) => {
    await openWith(page, '/hatch', { auth: SIGNED_IN, worker });
    await shown(page);
    await loseSession(page);
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByText(LINE).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
}

// spec: add-account › Session expiry flow › сессия кончилась при открытом экране
test('сессия кончилась при открытом экране: Hatch\'s «Try again» after the session ended — the line, nothing asked, the view stands', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: NO_ANSWER } });
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await loseSession(page);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Checking if hatching is open…')).toHaveCount(0);
});

// spec: add-account › Session expiry flow › сессия кончилась при открытом экране × тап на Account
test('сессия кончилась при открытом экране × тап на Account: a look of the closed Hatch found the end; the sign-in brings the name back to the field', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'pool' } } });
  await page.getByLabel('Name your pet').fill('Pixel');
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  // the look is refused before the fake records it: the page says nothing of it, and a moment is what it takes
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(page.getByLabel('Name your pet')).toHaveValue('Pixel');
  await setWorker(page, { sessionExpired: false });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/hatch$/);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await expect(page.getByText(LINE)).toHaveCount(0);
  await expect(page.getByLabel('Name your pet')).toHaveValue('Pixel');
  expect(await placeOf(page)).toBeNull();
});

// spec: add-pet › Connection rule › сервер недоступен
test('сервер недоступен: the gate can\'t be read at the owner\'s «Sign in» — the pet\'s line in the Composer and said at once, «Try again» in «Send»\'s place, the text stays', async ({ page }) => {
  await lineOnOwnerPage(page);
  await setWorker(page, { sessionExpired: false, signIn: NO_ANSWER });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: OFFLINE })).toHaveCount(1);
  await expect(page.getByText(LINE)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(field(page)).toHaveValue(TYPED);
  await expect(field(page)).toHaveAttribute('aria-disabled', 'true');
  expect(await privyCalls(page)).not.toContain('privy:login');
  // «Try again» is the same tap once more, and it carries the text on
  await setWorker(page, { signIn: { state: 'open' } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(field(page)).toHaveValue(TYPED);
  await expect(field(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText(OFFLINE)).toHaveCount(0);
  expect(await privyCalls(page)).toContain('privy:login');
});

// spec: add-pet › Connection rule › слишком много запросов
test('слишком много запросов: the gate answers 429 at the owner\'s «Sign in» — «Lots of visitors right now…», not the pet\'s line, and «Try again»', async ({ page }) => {
  await lineOnOwnerPage(page);
  await setWorker(page, { sessionExpired: false, signIn: TOO_MANY });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(BUSY).first()).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: BUSY })).toHaveCount(1);
  await expect(page.getByText(OFFLINE)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(field(page)).toHaveValue(TYPED);
});

// spec: add-account › Sign-in flow › вход не удался
test('вход не удался: Google never started from the owner\'s «Sign in» — the line said at once, «Try again» in «Send»\'s place, the text stays and comes back', async ({ page }) => {
  await lineOnOwnerPage(page, START_FAILS);
  await setWorker(page, { sessionExpired: false });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: FAILED })).toHaveCount(1);
  await expect(page.getByText(LINE)).toHaveCount(0);
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(field(page)).toHaveValue(TYPED);
  // the record lost the text, as after a cancel; the field did not
  expect(JSON.parse((await placeOf(page)) ?? 'null')).toEqual({ path: '/pet/9', action: 'signin', cancelled: true });
  await setOutcome(page, 'ok');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(field(page)).toHaveValue(TYPED);
  await expect(field(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText(FAILED)).toHaveCount(0);
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Sign-in flow › вход не удался
test('вход не удался: from a guest\'s line of an ended session — the failure, not the same line again', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: { ...SIGNED_IN, outcome: 'start_failed' }, worker: { ...OWNER, me: ME_PIXEL } });
  await expect(page.getByRole('link', { name: 'Go to your Pixel' })).toBeVisible();
  await loseSession(page);
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByText(LINE)).toHaveCount(0);
});

// spec: add-account › Sign-in flow › вход не удался
test('вход не удался: from the Hatch form\'s line of an ended session — the failure and «Try again», which carries the name on', async ({ page }) => {
  await openWith(page, '/hatch', { auth: { ...SIGNED_IN, outcome: 'start_failed' } });
  await page.getByLabel('Name your pet').fill('Pixel');
  await setWorker(page, { sessionExpired: true });
  await page.getByRole('button', { name: 'Hatch my pet' }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  await setWorker(page, { sessionExpired: false });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(FAILED).first()).toBeVisible();
  await expect(page.getByText(LINE)).toHaveCount(0);
  await setOutcome(page, 'ok');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/hatch$/);
  await expect(page.getByLabel('Name your pet')).toHaveValue('Pixel');
  await expect(page.getByText(FAILED)).toHaveCount(0);
});

test.describe('on a phone, in an ordinary browser', () => {
  test.use({ userAgent: UA.android });

  // spec: add-account › Sign-in flow › запасной путь на телефоне
  test('запасной путь на телефоне: Google never started from the owner\'s «Sign in» — both lines stand, «Open in browser» opens the sheet', async ({ page }) => {
    await lineOnOwnerPage(page, START_FAILS);
    await setWorker(page, { sessionExpired: false });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(FAILED).first()).toBeVisible();
    await expect(page.getByText(FALLBACK).first()).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: FALLBACK })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await page.getByRole('button', { name: 'Open in browser' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(field(page)).toHaveValue(TYPED);
  });
});

// spec: add-account › Session expiry flow › session ended, no tap yet × переход на другой адрес
test('session ended, no tap yet × переход на другой адрес: a tap had set the line — the visitor\'s next screen has none, and no second «Sign in»', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { ...OWNER, owned: [], me: ME_NO_PET } });
  await expect(page.getByRole('link', { name: 'Get your own pet' })).toBeVisible();
  await loseSession(page);
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  await page.getByRole('link', { name: 'Get your own pet' }).click();
  await expect(page).toHaveURL(/\/hatch/);
  await expect(page.getByRole('button', { name: 'Sign in with Google to hatch your pet' })).toBeVisible();
  await expect(page.getByText(LINE)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
});

// spec: add-account › Session expiry flow › session ended, no tap yet × переход на другой адрес
test('session ended, no tap yet × переход на другой адрес: on a closed Hatch the visitor\'s looks go on, and the page opens when the pause lifts', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { ...OWNER, me: ME_PIXEL, hatchStatus: { open: false, reason: 'service' } } });
  await expect(page.getByRole('link', { name: 'Go to your Pixel' })).toBeVisible();
  await loseSession(page);
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  await page.evaluate(() => {
    window.history.pushState(null, '', '/hatch');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
  // the closed Hatch keeps its discovery exit (`add-hatch-again` › `Hatch again screen` › «birth paused»)
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toBeVisible();
  await setWorker(page, { hatchStatus: { open: true } });
  await lookAgain(page);
  await expect(page.getByRole('button', { name: 'Sign in with Google to hatch your pet' })).toBeVisible();
});

// spec: add-account › Session expiry flow › сессия кончилась при открытом экране × Hatch my pet
test('сессия кончилась при открытом экране × Hatch my pet: the line and «Sign in» under the action, the name stays, no pet is hatched', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await page.getByLabel('Name your pet').fill('Pixel');
  await setWorker(page, { sessionExpired: true });
  await page.getByRole('button', { name: 'Hatch my pet' }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Name your pet')).toHaveValue('Pixel');
  await expect(page.getByRole('button', { name: 'Hatch my pet' })).toBeVisible();
  await expect(page).toHaveURL(/\/hatch$/);
  expect((await calls(page)).filter((c) => c.startsWith('worker:hatch:'))).toEqual([]);
  // the line is known now: a second tap asks nothing
  await page.getByRole('button', { name: 'Hatch my pet' }).click();
  expect((await calls(page)).filter((c) => c === 'worker:hatch')).toEqual([]);
});

// spec: add-account › Session expiry flow › сессия кончилась при открытом экране × Sign in на Pet screen
test('сессия кончилась при открытом экране × Sign in на Pet screen: a guest\'s page — the line and «Sign in» under «Feed», and the sign-in returns to it', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { ...OWNER, me: ME_PIXEL } });
  await expect(page.getByRole('link', { name: 'Go to your Pixel' })).toBeVisible();
  // a guest's page asks nothing again, so the end reaches it from Privy: another tab signed out
  await loseSession(page);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Feed Biscuit' }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  await expect(page.getByText(LINE)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  expect(await privyCalls(page)).toContain('privy:login');
});

// spec: add-account › Session expiry flow › typed text after sign-in
test('typed text after sign-in: the text is back in the field, unsent, and erased from the tab\'s storage', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await field(page).fill(TYPED);
  await endSession(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  await setWorker(page, { sessionExpired: false });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(field(page)).toHaveValue(TYPED);
  await expect(field(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText(LINE)).toHaveCount(0);
  expect((await calls(page)).filter((c) => c.startsWith('worker:say'))).toEqual([]);
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Session expiry flow › typed text after sign-in × нет такого поля на экране
test('typed text after sign-in × нет такого поля на экране: the pet was given away — the screen is a guest\'s, the text is dropped unseen and erased', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await field(page).fill(TYPED);
  await endSession(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  await setWorker(page, { sessionExpired: false, owned: [] });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveCount(0);
  await expect(page.getByText(TYPED)).toHaveCount(0);
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Session expiry flow › typed text after sign-in × имя на Hatch screen
test('typed text after sign-in × имя на Hatch screen: the name is back in the Hatch screen\'s field', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN });
  await page.getByLabel('Name your pet').fill('Pixel');
  await setWorker(page, { sessionExpired: true });
  await page.getByRole('button', { name: 'Hatch my pet' }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  await setWorker(page, { sessionExpired: false });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/hatch$/);
  await expect(page.getByLabel('Name your pet')).toHaveValue('Pixel');
  await expect(page.getByText(LINE)).toHaveCount(0);
  expect(await placeOf(page)).toBeNull();
  expect((await calls(page)).filter((c) => c.startsWith('worker:hatch:'))).toEqual([]);
});

// spec: add-account › Session expiry flow › typed text after sign-in × место потерялось
test('typed text after sign-in × место потерялось: the sign-in came back with no place — the field is empty', async ({ page }) => {
  await losePlace(page);
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, me: ME_PIXEL, owned: ['9'] } });
  await field(page).fill(TYPED);
  await endSession(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await setWorker(page, { sessionExpired: false });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(field(page)).toHaveValue('');
  await expect(page.getByText(TYPED)).toHaveCount(0);
  expect(await placeOf(page)).toBeNull();
});

// spec: add-account › Session expiry flow › typed text after sign-in × вход закрыт и Played here before
test('typed text after sign-in × вход закрыт и Played here before: through the closed sheet the text is carried on and comes back', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await field(page).fill(TYPED);
  await endSession(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(LINE).first()).toBeVisible();
  // sign-in closed for new players in the meantime; the session of the player is live again
  await setWorker(page, { sessionExpired: false, signIn: CLOSED_NEW });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Played here before? Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(field(page)).toHaveValue(TYPED);
  expect(await placeOf(page)).toBeNull();
});

// spec: add-pet › Pet screen › success (владелец) × сессия кончилась при открытом экране
// spec: add-account › Session expiry flow › session ended, no tap yet
test('сессия кончилась при открытом экране (the add-pet test moved here): the owner\'s page stands as it was, and a tap shows the line and «Sign in»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': PIXEL, '2': BISCUIT } } });
  await expect(field(page)).toBeVisible();
  await setWorker(page, { petState: { fail: { status: 401, code: 'signed_out' } } });
  await lookAgain(page);
  // no tap yet: nothing changed
  await expect(field(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  // the tap
  await field(page).fill('hello');
  await page.getByRole('button', { name: 'Think hard' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(field(page)).toHaveValue('hello');
});
