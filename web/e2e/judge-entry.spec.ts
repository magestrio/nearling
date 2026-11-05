import { expect, test } from '@playwright/test';
import { calls, CLOSED_ALL, CLOSED_NEW, openWith, privyCalls, setWorker, UA } from './helpers';

const CODE = 'sample-private-code';
test.beforeEach(async ({ page }) => { await page.clock.install({ time: new Date('2026-11-05T12:00:00.000Z') }); });
const sheet = (page: import('@playwright/test').Page) => page.getByRole('dialog');
const enter = async (page: import('@playwright/test').Page) => {
  await page.getByRole('link', { name: 'Enter judge code' }).first().click();
  await sheet(page).getByLabel('Judge code').fill(CODE);
};

// spec: add-showcase › Judge admission flow › ordinary entry closed
test('closed Home and the closed sign-in sheet each open the judge code sheet; closing preserves the public page', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: CLOSED_NEW } });
  await enter(page);
  await expect(sheet(page)).toContainText('Have a judge code? Enter it to make your own pet.');
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/pet/2');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await sheet(page).getByRole('link', { name: 'Enter judge code' }).click();
  await expect(sheet(page).getByLabel('Judge code')).toBeVisible();
});

// spec: add-showcase › Judge code sheet screen › error
// spec: add-showcase › Judge code sheet screen › success × Try again
test('unavailable check keeps the typed code for Try again', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: CLOSED_NEW, judgeCheck: { fail: { status: 503, code: 'judge_unavailable' } } }, auth: { outcome: 'held' } });
  await enter(page);
  await sheet(page).getByRole('button', { name: 'Continue with Google' }).click();
  await expect(sheet(page)).toContainText("We couldn't check that code. Try again.");
  await expect(sheet(page).getByLabel('Judge code')).toHaveValue(CODE);
  expect(await privyCalls(page)).toEqual([]);
  await setWorker(page, { judgeCheck: { ok: true } });
  await sheet(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(await privyCalls(page)).toContain('privy:login');
});

for (const [reason, line, action] of [
  ['invalid', "That code doesn't work. Check it and try again.", 'Continue with Google'],
  ['exhausted', 'This code has used both places. You can still explore the demo.', 'View demo pet'],
  ['expired', 'This judge code has expired. You can still explore the demo.', 'View demo pet'],
] as const) {
  // spec: add-showcase › Judge admission flow › invalid code
  // spec: add-showcase › Judge admission flow › exhausted code
  // spec: add-showcase › Judge admission flow › expired code
  test(`${reason} code stays on the public page and never starts Google`, async ({ page }) => {
    await openWith(page, '/', { worker: { signIn: CLOSED_NEW, judgeCheck: { fail: { status: 403, code: `judge_${reason}` } } } });
    await enter(page);
    await sheet(page).getByRole('button', { name: 'Continue with Google' }).click();
    await expect(sheet(page)).toContainText(line);
    await expect(sheet(page).getByLabel('Judge code')).toHaveValue(CODE);
    await expect(sheet(page).getByRole(action === 'View demo pet' ? 'link' : 'button', { name: action })).toBeVisible();
    expect(await privyCalls(page)).toEqual([]);
  });
}

// spec: add-showcase › Judge admission flow › valid code
test('check precedes Google; the bearer goes only in the session body and is erased after an admitted return', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { signIn: CLOSED_NEW }, auth: { outcome: 'held' } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await sheet(page).getByRole('link', { name: 'Enter judge code' }).click();
  await sheet(page).getByLabel('Judge code').fill(CODE);
  await sheet(page).getByRole('button', { name: 'Continue with Google' }).click();
  expect(await calls(page)).toContain('worker:judgeCheck:body');
  expect(await privyCalls(page)).toContain('privy:login');
  const stored = await page.evaluate(() => sessionStorage.getItem('nearling.judgeCode'));
  expect(stored).toBe(CODE);
  await expect(page).not.toHaveURL(new RegExp(CODE));
});

// spec: add-showcase › Judge admission data › admitted Google return
test('a fresh Google return sends the code in the session body and erases it on success', async ({ page }) => {
  await page.addInitScript((code) => {
    sessionStorage.setItem('nearling.judgeCode', code);
    sessionStorage.setItem('nearling.returnPlace', JSON.stringify({ path: '/pet/2', action: 'feed', judge: true }));
  }, CODE);
  await openWith(page, '/', { auth: { authenticated: true, nearAccountId: 'a'.repeat(64), fresh: true }, worker: { signIn: CLOSED_NEW } });
  await expect(page).toHaveURL(/\/pet\/2$/);
  expect(await calls(page)).toContain('worker:session:judge-code-body');
  expect(await page.evaluate(() => sessionStorage.getItem('nearling.judgeCode'))).toBeNull();
});

// spec: add-showcase › Judge admission flow › second identity
test('the same code admits a second identity that can enter feed-by-link and accept a gift', async ({ page, browser }) => {
  const identities = [page, await browser.newPage()];
  try {
    for (const [index, identity] of identities.entries()) {
      // Seed the Google return once: a later goto in the same tab must not return to /pet/2 again.
      await identity.addInitScript((code) => {
        if (sessionStorage.getItem('test.seeded')) return;
        sessionStorage.setItem('test.seeded', '1');
        sessionStorage.setItem('nearling.judgeCode', code);
        sessionStorage.setItem('nearling.returnPlace', JSON.stringify({ path: '/pet/2', action: 'feed', judge: true }));
      }, CODE);
      await openWith(identity, '/', { auth: { authenticated: true, nearAccountId: (index === 0 ? 'a' : 'b').repeat(64), fresh: true }, worker: { signIn: CLOSED_NEW, publicGift: { tokenId: '9', name: 'Pixel', fullness: { state: 'full', level: 1 }, status: 'waiting', viewer: 'receiver', errand: null } } });
      await expect(identity).toHaveURL(/\/pet\/2$/);
      expect(await calls(identity)).toContain('worker:session:judge-code-body');
      await expect(identity.getByRole('dialog', { name: 'Feed Biscuit' })).toBeVisible();
    }
    const second = identities[1]!;
    await second.getByRole('dialog', { name: 'Feed Biscuit' }).getByRole('button', { name: 'Close' }).click();
    const code = 'a'.repeat(48);
    await second.goto(`/gift/${code}`);
    await expect(second.getByRole('button', { name: 'Accept Pixel' })).toBeVisible();
    await second.getByRole('button', { name: 'Accept Pixel' }).click();
    // the sheet-less page also says it in a hidden status line: match the shown words
    await expect(second.locator('#gift-accepted-line')).toContainText("You accepted Pixel! Now Pixel's owner hands Pixel over");
    expect((await calls(second)).filter((call) => call === 'worker:acceptGift')).toHaveLength(1);
  } finally {
    await identities[1]?.close();
  }
});

for (const reason of ['judge_exhausted', 'judge_expired'] as const) {
  // spec: add-showcase › Judge admission data › concurrent return takes last place
  // spec: add-showcase › Judge admission data › code expired during Google
  test(`${reason} at the Google return reopens the sheet without a game session`, async ({ page }) => {
    await page.addInitScript((code) => {
      sessionStorage.setItem('nearling.judgeCode', code);
      sessionStorage.setItem('nearling.returnPlace', JSON.stringify({ path: '/', action: 'signin', judge: true }));
    }, CODE);
    await openWith(page, '/', { auth: { authenticated: true, nearAccountId: 'a'.repeat(64), fresh: true }, worker: { signIn: CLOSED_NEW, session: { refused: { reason } } } });
    await expect(sheet(page)).toContainText(reason === 'judge_exhausted' ? 'This code has used both places.' : 'This judge code has expired.');
    expect(await calls(page)).toContain('worker:session:judge-code-body');
    expect(await page.evaluate(() => sessionStorage.getItem('nearling.judgeCode'))).toBeNull();
  });
}

// spec: add-showcase › Judge admission flow › closed to everyone
test('the 490 ceiling reached during a check closes entry before Google', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: CLOSED_NEW } });
  await enter(page);
  await setWorker(page, { signIn: CLOSED_ALL });
  await sheet(page).getByRole('button', { name: 'Continue with Google' }).click();
  await expect(sheet(page)).toContainText('Sign-in is closed for everyone');
  expect(await privyCalls(page)).toEqual([]);
});

// spec: add-showcase › Judge admission flow › code after Google failure
test('failed Google leaves the public page and offers a new code entry', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: CLOSED_NEW }, auth: { outcome: 'failed' } });
  await enter(page);
  await sheet(page).getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByRole('link', { name: 'Try Google again' }).click();
  await expect(sheet(page).getByLabel('Judge code')).toHaveValue('');
  expect(await page.evaluate(() => sessionStorage.getItem('nearling.judgeCode'))).toBeNull();
});

// spec: add-showcase › Judge admission flow › embedded browser
test('X in-app exit carries the public destination and requires the code again', async ({ page }) => {
  await page.addInitScript((ua) => Object.defineProperty(navigator, 'userAgent', { get: () => ua }), UA.xOnIphone);
  await openWith(page, '/pet/2', { worker: { signIn: CLOSED_NEW } });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await sheet(page).getByRole('link', { name: 'Enter judge code' }).click();
  await sheet(page).getByLabel('Judge code').fill(CODE);
  await sheet(page).getByRole('button', { name: 'Continue with Google' }).click();
  await expect(sheet(page)).toContainText('Open in your browser to sign in');
  expect(await page.evaluate(() => sessionStorage.getItem('nearling.judgeCode'))).toBeNull();
  expect(await privyCalls(page)).toEqual([]);
});
