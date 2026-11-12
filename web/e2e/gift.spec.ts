import { expect, test, type Page } from '@playwright/test';
import { calls, openMore, openPet, setWorker, SIGNED_IN, OWNER, UA } from './helpers';
import { openWith } from './helpers';

/** «More» opened and its «Give {name} away» tapped (add-game-layout › Pet actions menu screen) */
const openGive = async (page: Page) => {
  await openMore(page);
  await page.getByRole('menuitem', { name: 'Give Pixel away' }).click();
};
import { actions, createTransaction } from 'near-api-js';
import { publicKeyFromImplicitAccount } from '../src/near/privySigner';
import { buildEnvFor } from '../build-env';

const code = 'a'.repeat(48);
const receiver = 'b2'.repeat(32);
const accepted = { status: 'accepted' as const, code, acceptedName: 'Maya', acceptedAccount: receiver, version: 2 };
const readyTransfer = () => {
  const account = 'a'.repeat(64);
  const tx = createTransaction(account, publicKeyFromImplicitAccount(account), buildEnvFor('e2e').VITE_CONTRACT_ID, 1n,
    [actions.functionCall('nft_transfer', { receiver_id: receiver, token_id: '9', approval_id: null, memo: null }, 5n * 10n ** 12n, 1n)],
    new Uint8Array(32).fill(1));
  return { status: 'ready' as const, tx: Buffer.from(tx.encode()).toString('base64'), receiver, acceptedName: 'Maya' };
};
const dialog = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Give Pixel to a friend' });
/** The words on the page, not the screen reader's copy of them in the sheet's hidden status line. */
const shown = (scope: import('@playwright/test').Locator, text: string) => scope.getByText(text, { exact: false }).and(scope.page().locator(':not([role="status"])'));

// spec: add-gift › Gift sheet screen › success
// spec: add-gift › Gift sheet screen › что теряет дарящий
// spec: add-gift › Gift sheet screen › ссылку только другу
// spec: add-gift › Gift sheet screen › рождённый питомец
test('shows the whole pet and public-gift warnings before creating a link', async ({ page }) => {
  await openPet(page, {}, { me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 } });
  await openGive(page);
  await expect(page.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('menu', { name: 'More' })).toHaveCount(0);
  await expect(dialog(page).getByText('Pixel goes to them whole:', { exact: false })).toBeVisible();
  await expect(dialog(page).getByText("Pixel won't be yours anymore", { exact: false })).toBeVisible();
  await expect(dialog(page).getByText('Send this link only to your friend', { exact: false })).toBeVisible();
  await expect(dialog(page).getByText('If Pixel was your only pet, you can hatch a new one after the gift.')).toBeVisible();
});

// spec: add-gift › Gift sheet screen › success
// spec: add-gift › Gift flow › друг принял
test('selects a manually opened Gift rail item but not a self-opened accepted sheet', async ({ page }) => {
  await openPet(page);
  await openMore(page);
  await page.getByRole('menuitem', { name: 'Give Pixel away' }).click();
  const trigger = page.getByRole('button', { name: 'More' });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await setWorker(page, { giftLink: accepted });
  await expect(dialog(page)).toBeVisible({ timeout: 7_000 });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

// spec: add-gift › Gift flow › ссылка создана
// spec: add-gift › Gift flow › ссылка ждёт
test('creates one link, offers it to share, and can cancel it', async ({ page }) => {
  await openPet(page, {}, { createGift: { status: 'waiting', code } });
  await openGive(page);
  await dialog(page).getByRole('button', { name: 'Create gift link' }).click();
  await expect(shown(dialog(page), 'Your gift link is ready.')).toBeVisible();
  await expect(calls(page)).resolves.toContain('worker:createGift');
  await dialog(page).getByRole('button', { name: 'Cancel gift' }).click();
  await expect(shown(dialog(page), "Gift cancelled. That link won't work anymore.")).toBeVisible();
  await expect(calls(page)).resolves.toContain('worker:cancelGift');
});

// spec: add-gift › Gift flow › ссылка создана
test('passes the exact gift invitation and URL to the system share menu', async ({ page }) => {
  await openPet(page, {}, { createGift: { status: 'waiting', code } });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (item: ShareData) => {
      (globalThis as { __giftShare?: ShareData }).__giftShare = item;
    } });
  });
  await openGive(page);
  await dialog(page).getByRole('button', { name: 'Create gift link' }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as { __giftShare?: ShareData }).__giftShare)).toEqual({
    text: "I'm giving you Pixel! Open this link to take Pixel home:",
    url: new URL(`/gift/${code}`, page.url()).toString(),
  });
});

// spec: add-gift › Gift flow › друг принял
// spec: add-gift › Gift flow › имя принявшего не показать
test('opens accepted link by itself and keeps an unnamed friend warning', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, giftLink: { ...accepted, acceptedName: null } } });
  await expect(shown(dialog(page), 'A friend wants to take Pixel home.')).toBeVisible();
  await expect(dialog(page).getByText("We can't show this person's name", { exact: false })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Not sure? Cancel gift' })).toBeVisible();
});

// spec: add-gift › Gift flow › нет NEAR на передачу
// spec: add-gift › Gift flow › chain rejected for gas
test('offers Add NEAR for both short wallet and chain gas rejection', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, giftLink: accepted, prepareGift: { status: 'no_near', missingYocto: '1' } } });
  await dialog(page).getByRole('button', { name: 'Give Pixel to Maya' }).click();
  await expect(shown(dialog(page), 'Add 0.01 NEAR to give Pixel to Maya')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Add NEAR' }).click();
  await expect(page.getByRole('dialog', { name: 'Add NEAR' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(shown(dialog(page), 'Maya wants to take Pixel home.')).toBeVisible();
  await setWorker(page, { prepareGift: { status: 'gas_rejected', missingYocto: '1' } });
  await dialog(page).getByRole('button', { name: 'Give Pixel to Maya' }).click();
  await expect(shown(dialog(page), 'The gift didn\'t go through. Add 0.01 NEAR')).toBeVisible();
});

// spec: add-gift › Gift flow › подарки на паузе
// spec: add-gift › Gift flow › не прошло
test('keeps the accepted friend on a paused gift and a definite failure', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, giftLink: accepted, prepareGift: { status: 'paused' } } });
  await dialog(page).getByRole('button', { name: 'Give Pixel to Maya' }).click();
  await expect(shown(dialog(page), 'Gifts are paused on our side')).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Not Maya? Cancel gift' })).toBeVisible();
});

// spec: add-gift › Gift sheet screen › success × Clear memory
test('opens Clear memory and returns to the Gift sheet', async ({ page }) => {
  await openPet(page);
  await openGive(page);
  await dialog(page).getByRole('button', { name: 'Clear memory' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Keep memory' }).click();
  await expect(dialog(page)).toBeVisible();
});

// spec: add-gift › Gift flow › ссылка ждёт × Share gift link
test('copies the link when system share is absent and shows manual copy when clipboard fails', async ({ page }) => {
  await openPet(page, {}, { giftLink: { status: 'waiting', code } });
  await page.evaluate(() => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => undefined, configurable: true }); });
  await openGive(page);
  await dialog(page).getByRole('button', { name: 'Share gift link' }).click();
  // the visible line is the Toast (a span); the sheet's status region repeats it for a screen reader and is hidden on screen
  await expect(page.locator('span', { hasText: 'Link copied — send it to a friend.' })).toBeVisible();
  await expect(dialog(page).getByRole('status')).toHaveText('Link copied — send it to a friend.');
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw Error('copy unavailable'); }, configurable: true }); });
  await dialog(page).getByRole('button', { name: 'Share gift link' }).click();
  await expect(dialog(page).getByLabel('Copy this link and send it to a friend:')).toHaveValue(new RegExp(`/gift/${code}`));
});

// spec: add-gift › Gift flow › ссылка ждёт × Share gift link
// spec: add-gift › Gift flow › отменил
// spec: add-gift › Gift flow › не прошло
test('keeps focus inside the sheet as link and transfer controls are replaced', async ({ page }) => {
  await openPet(page, {}, { createGift: { status: 'waiting', code } });
  await page.evaluate(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: async () => undefined }); });
  await openGive(page);
  await dialog(page).getByRole('button', { name: 'Create gift link' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Share gift link' })).toBeFocused();
  await dialog(page).getByRole('button', { name: 'Cancel gift' }).click();
  await expect(dialog(page).locator('[data-gift-outcome]')).toBeFocused();
  await setWorker(page, { giftLink: accepted, prepareGift: { status: 'failed' } });
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Give Pixel to Maya' }).click();
  await expect(dialog(page).locator('[data-gift-outcome]')).toBeFocused();
});

// spec: add-gift › Gift flow › друг принял — the giver who waits with the sheet open sees the friend without closing it
test('turns an open waiting sheet into the hand-over when the friend accepts', async ({ page }) => {
  await openPet(page, {}, { createGift: { status: 'waiting', code } });
  await page.evaluate(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: async () => undefined }); });
  await openGive(page);
  await dialog(page).getByRole('button', { name: 'Create gift link' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Share gift link' })).toBeVisible();
  await setWorker(page, { giftLink: accepted });
  await expect(dialog(page).getByRole('button', { name: 'Give Pixel to Maya' })).toBeVisible({ timeout: 8000 });
});

// spec: add-gift › Gift flow › передаёт × second tap/second tab
// spec: add-gift › Gift flow › исход неизвестен × 10 seconds
test('keeps transfer controls inactive while the chain outcome is unknown', async ({ page }) => {
  await page.clock.install();
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, giftLink: accepted, prepareGift: { status: 'unknown' } } });
  await dialog(page).getByRole('button', { name: 'Give Pixel to Maya' }).click();
  await setWorker(page, { giftOutcome: { status: 'unknown' } });
  await expect(dialog(page).getByRole('button', { name: 'Handing Pixel over…' })).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: 'Not Maya? Cancel gift' })).toBeDisabled();
  await page.clock.fastForward(10_000);
  await expect(shown(dialog(page), 'Still checking — this can take a moment.')).toBeVisible();
  expect((await calls(page)).filter((line) => line === 'worker:prepareGift')).toHaveLength(1);
  await setWorker(page, { giftOutcome: { status: 'failed' } });
  await page.clock.fastForward(2_500);
  await expect(shown(dialog(page), "The gift didn't go through, so Pixel is still yours. Try again.")).toBeVisible();
});

// spec: add-gift › Gift flow › исход неизвестен
for (const failure of [500, 502, 504, 0]) {
  test(`keeps a sent transfer locked after HTTP ${failure} until its stored outcome settles`, async ({ page }) => {
    await page.clock.install();
    await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, giftLink: accepted, prepareGift: readyTransfer(), sendGift: { fail: { status: failure, code: 'network_failure' } } } });
    await dialog(page).getByRole('button', { name: 'Give Pixel to Maya' }).click();
    await setWorker(page, { giftOutcome: { status: 'unknown' } });
    await expect(dialog(page).getByRole('button', { name: 'Handing Pixel over…' })).toBeDisabled();
    await expect(dialog(page).getByRole('button', { name: 'Not Maya? Cancel gift' })).toBeDisabled();
    await page.clock.fastForward(10_000);
    await expect(shown(dialog(page), 'Still checking — this can take a moment.')).toBeVisible();
    const sentCalls = await calls(page);
    expect(sentCalls.filter((line) => line === 'worker:sendGift')).toHaveLength(1);
    expect(sentCalls.filter((line) => line === 'worker:prepareGift')).toHaveLength(1);
    await setWorker(page, { giftOutcome: { status: 'ok' } });
    await page.clock.fastForward(2_500);
    await expect(shown(dialog(page), "Pixel is Maya's now.")).toBeVisible();
  });
}

// spec: add-gift › Gift flow › исход неизвестен
test('resends the signed transfer after a no-flight poll without unlocking a new attempt', async ({ page }) => {
  await page.clock.install();
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: {
    ...OWNER, giftLink: accepted, prepareGift: readyTransfer(),
    sendGift: { fail: { status: 0, code: 'unreachable' } },
    giftOutcome: { fail: { status: 409, code: 'gift_unavailable' } },
  } });
  await dialog(page).getByRole('button', { name: 'Give Pixel to Maya' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Handing Pixel over…' })).toBeDisabled();
  await expect.poll(async () => (await calls(page)).filter((line) => line === 'worker:sendGift').length).toBe(1);
  await setWorker(page, { sendGift: { status: 'unknown' } });
  await page.clock.fastForward(2_500);
  await expect(dialog(page).getByRole('button', { name: 'Not Maya? Cancel gift' })).toBeDisabled();
  const first = await calls(page);
  expect(first.filter((line) => line === 'worker:prepareGift')).toHaveLength(1);
  expect(first.filter((line) => line === 'worker:sendGift').length).toBeGreaterThanOrEqual(2);

  await setWorker(page, { giftOutcome: { status: 'ok' } });
  await page.clock.fastForward(2_500);
  await expect(shown(dialog(page), "Pixel is Maya's now.")).toBeVisible();
  const retried = await calls(page);
  expect(retried.filter((line) => line === 'worker:prepareGift')).toHaveLength(1);
  const sendsOnSuccess = retried.filter((line) => line === 'worker:sendGift').length;
  expect(sendsOnSuccess).toBeGreaterThanOrEqual(first.filter((line) => line === 'worker:sendGift').length);
  await page.clock.fastForward(2_500);
  expect((await calls(page)).filter((line) => line === 'worker:sendGift')).toHaveLength(sendsOnSuccess);
});

// spec: add-gift › Gift flow › исход неизвестен
// spec: add-gift › Gift flow › отменил
test('re-reads a cancelled link after the signed resend is definitely refused', async ({ page }) => {
  await page.clock.install();
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: {
    ...OWNER, giftLink: accepted, prepareGift: readyTransfer(),
    sendGift: { fail: { status: 0, code: 'unreachable' } },
    giftOutcome: { fail: { status: 409, code: 'gift_unavailable' } },
  } });
  await dialog(page).getByRole('button', { name: 'Give Pixel to Maya' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Handing Pixel over…' })).toBeDisabled();
  await expect.poll(async () => (await calls(page)).filter((line) => line === 'worker:sendGift').length).toBe(1);
  await setWorker(page, {
    giftLink: { status: 'none' },
    sendGift: { fail: { status: 409, code: 'gift_unavailable' } },
  });
  await page.clock.fastForward(2_500);
  await expect(shown(dialog(page), "Gift cancelled. That link won't work anymore.")).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Create gift link' })).toBeEnabled();
  await expect(dialog(page).getByRole('button', { name: 'Not Maya? Cancel gift' })).toHaveCount(0);
  const settled = await calls(page);
  expect(settled.filter((line) => line === 'worker:prepareGift')).toHaveLength(1);
  expect(settled.filter((line) => line === 'worker:sendGift').length).toBeGreaterThanOrEqual(2);
  expect(settled.filter((line) => line === 'worker:giftLink').length).toBeGreaterThanOrEqual(2);
  await page.clock.fastForward(5_000);
  expect((await calls(page)).filter((line) => line === 'worker:sendGift')).toHaveLength(settled.filter((line) => line === 'worker:sendGift').length);
});

// spec: add-gift › Gift flow › подарен
test('shows the confirmed gift before leaving the giver screen', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, giftLink: accepted, prepareGift: { status: 'ok' } } });
  await dialog(page).getByRole('button', { name: 'Give Pixel to Maya' }).click();
  await expect(shown(dialog(page), "Pixel is Maya's now. Thanks for taking such good care of Pixel!")).toBeVisible();
});

const receiverGift = (status: 'waiting' | 'accepted' | 'transferred' = 'waiting', viewer: 'giver' | 'receiver' | 'visitor' = 'receiver') => ({
  tokenId: '9', name: 'Pixel', fullness: { state: 'full' as const, level: 1 }, status, viewer, errand: null,
});

// spec: add-gift › Gift screen › loading
// spec: add-gift › Gift screen › error
test('shows loading without an active accept control and a dead link without the pet', async ({ page }) => {
  await openWith(page, `/gift/${code}`, { auth: SIGNED_IN, worker: { publicGiftDelayMs: 30_000 } });
  await expect(page.getByText('Opening your gift…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept your gift' })).toBeDisabled();
  await page.goto('/gift/short');
  await expect(page.getByText("This gift link doesn't work anymore. Ask your friend for a new one.")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go home' })).toBeVisible();
  await expect(page.getByText('Pixel')).toHaveCount(0);
});

// spec: add-gift › Gift screen › success
// spec: add-gift › Gift screen › asleep
test('shows the guest pet, both notices and an asleep pet that can still be accepted', async ({ page }) => {
  await openWith(page, `/gift/${code}`, { auth: SIGNED_IN, worker: { publicGift: receiverGift() } });
  await expect(page.getByRole('heading', { name: 'Pixel is a gift for you!' })).toBeVisible();
  await expect(page.getByText('A thought\'s receipt shows', { exact: false })).toBeVisible();
  await expect(page.getByText('To write your pet\'s replies', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause motion' })).toBeVisible();
  await setWorker(page, { publicGift: { ...receiverGift(), fullness: { state: 'asleep', level: 0 } } });
  await expect(page.getByText('Pixel is asleep right now. Once Pixel is yours, a meal will wake Pixel up.')).toBeVisible({ timeout: 6_000 });
  await expect(page.getByRole('button', { name: 'Accept Pixel' })).toBeEnabled();
});

// spec: add-gift › Gift screen › signed-out
// spec: add-gift › Gift accept flow › вход из ссылки
// spec: add-gift › Gift accept flow › принял
test('returns from Google to the link and accepts once without a second tap', async ({ page }) => {
  await openWith(page, `/gift/${code}`, { worker: { publicGift: receiverGift('waiting', 'visitor') } });
  await page.getByRole('button', { name: 'Sign in with Google to accept Pixel' }).click();
  await expect(shown(page.locator('body'), 'You accepted Pixel! Now Pixel\'s owner hands Pixel over')).toBeVisible();
  expect((await calls(page)).filter((line) => line === 'worker:acceptGift')).toHaveLength(1);
  await expect(page).toHaveURL(new RegExp(`/gift/${code}$`));
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Get your own pet' })).toBeVisible();
});

// spec: add-gift › Gift screen › signed-out (подарок уже принят)
// spec: add-gift › Gift accept flow › получил без него
test('asks a signed-out visitor to see an accepted gift and routes the receiver after sign-in', async ({ page }) => {
  await openWith(page, `/gift/${code}`, { worker: { publicGift: receiverGift('transferred', 'visitor') } });
  await expect(page.getByRole('button', { name: 'Sign in with Google to see your gift' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with Google to see your gift' }).click();
  await expect(page.getByRole('heading', { name: 'Pixel is yours!' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Pixel' })).toHaveAttribute('href', '/pet/9');
});

// spec: add-gift › Gift screen › ссылку открыл дарящий
test('does not let the giver accept their own link', async ({ page }) => {
  await openWith(page, `/gift/${code}`, { auth: SIGNED_IN, worker: { publicGift: receiverGift('waiting', 'giver') } });
  await expect(page.getByText("This is your gift link for Pixel. Send it to the friend you're giving Pixel to.")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Pixel' })).toHaveAttribute('href', '/pet/9');
  await expect(page.getByRole('button', { name: 'Accept Pixel' })).toHaveCount(0);
});

// spec: add-gift › Gift accept flow › вход из ссылки
// spec: add-gift › Gift screen › error
test('a sign-in as the giver stays on their own link, while another account sees a dead link', async ({ page }) => {
  await openWith(page, `/gift/${code}`, { worker: { publicGift: receiverGift('waiting', 'giver') } });
  await page.getByRole('button', { name: 'Sign in with Google to accept Pixel' }).click();
  await expect(page.getByText("This is your gift link for Pixel. Send it to the friend you're giving Pixel to.")).toBeVisible();
  expect((await calls(page)).filter((line) => line === 'worker:acceptGift')).toHaveLength(0);
  await setWorker(page, { publicGift: { fail: { status: 404, code: 'gift_unavailable' } } });
  await expect(page.getByText("This gift link doesn't work anymore. Ask your friend for a new one.")).toBeVisible({ timeout: 6_000 });
});

// spec: add-gift › Gift screen › errand still running
test('shows the ordinary errand ceiling before acceptance, including without a session', async ({ page }) => {
  await openWith(page, `/gift/${code}`, { worker: { publicGift: { ...receiverGift('waiting', 'visitor'), errand: { running: true, maxCents: 2 } } } });
  await expect(page.getByText("Pixel is finishing an errand started by the current owner. It may use up to ≈ 2¢ of Pixel's food after you accept.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google to accept Pixel' })).toBeVisible();
});

// spec: add-gift › Gift accept flow › получил
test('turns an open accepted screen into the received state without reloading', async ({ page }) => {
  await openWith(page, `/gift/${code}`, { auth: SIGNED_IN, worker: { publicGift: receiverGift('accepted') } });
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toBeVisible();
  await setWorker(page, { publicGift: receiverGift('transferred') });
  await expect(page.getByRole('heading', { name: 'Pixel is yours!' })).toBeVisible({ timeout: 6_000 });
  await expect(page.getByRole('link', { name: 'Go to Pixel' })).toBeVisible();
});

// spec: add-gift › Gift accept flow › вход из ссылки
test('offers the real browser path from an X in-app phone without losing the gift link', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((ua) => Object.defineProperty(navigator, 'userAgent', { get: () => ua }), UA.xOnIphone);
  await openWith(page, `/gift/${code}`, { worker: { publicGift: receiverGift('waiting', 'visitor') } });
  await page.getByRole('button', { name: 'Sign in with Google to accept Pixel' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Copy link' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/gift/${code}$`));
});

// spec: add-gift › My pets sheet screen › success
// spec: add-gift › Several pets rule › текущий
test('lists owned pets in server order and opens the chosen pet', async ({ page }) => {
  await openPet(page, { ownedCount: 2 }, { owned: ['9', '2'], myPets: {
    pets: [{ tokenId: '9', name: 'Pixel', born: true }, { tokenId: '2', name: 'Biscuit', born: false }],
    currentPet: { tokenId: '9', name: 'Pixel' },
  } });
  await page.getByRole('button', { name: 'My pets' }).click();
  await expect(page.getByRole('button', { name: 'My pets' })).toHaveAttribute('aria-expanded', 'true');
  const list = page.getByRole('list', { name: 'Your pets' });
  await expect(list.getByRole('link')).toHaveCount(2);
  await expect(list.getByRole('link').first()).toHaveAttribute('aria-current', 'page');
  await list.getByRole('link', { name: /Biscuit/ }).click();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await expect(page.getByRole('dialog', { name: 'Your pets' })).toHaveCount(0);
});

// spec: add-gift › My pets sheet screen › success
test('keeps My pets beside Back to a friend when the owner has two pets', async ({ page }) => {
  await openWith(page, '/pet/9?from=2', { auth: SIGNED_IN, worker: { ...OWNER, owned: ['9', '2'], pets: {
    '9': { ...OWNER.pets['9'], owner: { ownedCount: 2 } }, '2': OWNER.pets['2'],
  } } });
  await expect(page.getByRole('link', { name: 'Back to Biscuit' })).toBeVisible();
  const opener = page.getByRole('button', { name: 'My pets' });
  await expect(opener).toBeVisible();
  await opener.click();
  await expect(opener).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog', { name: 'Your pets' })).toBeVisible();
});

// spec: add-gift › Several pets rule › текущий
// spec: add-gift › Several pets rule › текущий подарен
test('uses the selected pet on Home and the remaining pet beneath a confirmed gift', async ({ page }) => {
  const me = { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 2 };
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { ...OWNER, owned: ['9', '2'], me } });
  await openMore(page);
  await expect(page.getByRole('menuitem', { name: 'Give Biscuit away' })).toBeVisible();
  await page.evaluate(() => { history.pushState(null, '', '/'); window.dispatchEvent(new Event('nearling:navigate')); });
  await expect(page).toHaveURL(/\/pet\/2$/);

  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, owned: ['9', '2'], me, giftLink: accepted, prepareGift: { status: 'ok' } } });
  await dialog(page).getByRole('button', { name: 'Give Pixel to Maya' }).click();
  await expect(shown(dialog(page), "Pixel is Maya's now.")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to your Biscuit' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
});

// spec: add-gift › Several pets rule › текущий
// spec: add-gift › Gift accept flow › получил
test('makes a received pet current when the receiver opens it', async ({ page }) => {
  const me = { accountId: 'a'.repeat(64), hatched: { tokenId: '2', name: 'Biscuit' }, currentPet: { tokenId: '2', name: 'Biscuit' }, ownedCount: 2 };
  await openWith(page, `/gift/${code}`, { auth: SIGNED_IN, worker: { ...OWNER, owned: ['9', '2'], me, publicGift: receiverGift('transferred') } });
  await page.getByRole('link', { name: 'Go to Pixel' }).click();
  await openMore(page);
  await expect(page.getByRole('menuitem', { name: 'Give Pixel away' })).toBeVisible();
  await page.evaluate(() => { history.pushState(null, '', '/'); window.dispatchEvent(new Event('nearling:navigate')); });
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-gift › My pets sheet screen › error
test('keeps the open pet when My pets fails and retries the list', async ({ page }) => {
  await openPet(page, { ownedCount: 2 }, { myPets: { fail: { status: 503, code: 'chain_unreachable' } } });
  await page.getByRole('button', { name: 'My pets' }).click();
  await expect(page.getByText("We couldn't load your pets right now. Try again in a moment.")).toBeVisible();
  const retry = page.getByRole('dialog', { name: 'Your pets' }).getByRole('button', { name: 'Try again' });
  await expect.poll(async () => {
    const button = await retry.boundingBox();
    const panel = await page.getByRole('dialog', { name: 'Your pets' }).boundingBox();
    return Boolean(button && panel && button.width < panel.width / 2);
  }).toBe(true);
  await expect(page).toHaveURL(/\/pet\/9$/);
  await setWorker(page, { myPets: { pets: [{ tokenId: '9', name: 'Pixel', born: true }, { tokenId: '2', name: 'Biscuit', born: false }], currentPet: { tokenId: '9', name: 'Pixel' } } });
  await page.getByRole('dialog', { name: 'Your pets' }).getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('list', { name: 'Your pets' }).getByRole('link')).toHaveCount(2);
});

// spec: add-gift › Gift ownership data › открытая вкладка дарящего
// spec: add-gift › Gift rule › дарящий после подарка
test('turns an open giver Pet screen and Feed sheet into the guest view after transfer', async ({ page }) => {
  await openPet(page);
  await page.getByRole('button', { name: 'Feed Pixel' }).first().click();
  const feed = page.getByRole('dialog', { name: 'Feed Pixel' });
  await expect(feed).toBeVisible();
  await setWorker(page, { owned: [] });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Give Pixel away' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Wardrobe' })).toHaveCount(0);
  await expect(feed).toBeVisible();
  await expect(feed.getByRole('button', { name: 'Give Pixel a free snack' })).toBeVisible();
  const before = await calls(page);
  expect(before).toContain('worker:petState');
  expect(before.filter((call) => call === 'worker:say:chat' || call.startsWith('worker:wear:') || call.startsWith('worker:setHireMode:'))).toHaveLength(0);
});

// spec: add-gift › My pets sheet screen › success × asleep entry and close
test('opens My pets from an asleep pet and returns focus on close', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...OWNER.pets['9'], fullness: { state: 'asleep', level: 0 }, owner: { ownedCount: 2 } }, '2': OWNER.pets['2'] } } });
  const opener = page.getByRole('button', { name: 'My pets' });
  await opener.click();
  await expect(page.getByRole('dialog', { name: 'Your pets' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Your pets' }).getByRole('button', { name: 'Close' }).click();
  await expect(opener).toBeFocused();
});

// spec: add-gift › Gift rule › разговор и память
// spec: add-gift › Gift rule › ответ после подарка
// spec: add-gift › Gift rule › ordinary errand after gift
test('labels former owner lines and puts the gift boundary below late replies', async ({ page }) => {
  const at = Date.parse('2026-11-12T10:00:00Z');
  await openPet(page, { hello: true }, { conversation: { lines: [
    { id: 'old:you', who: 'player', text: 'A question before the gift.', at: at - 1000, previousOwner: true },
    { id: 'old:reply', who: 'pet', text: 'The answer arrived after the gift.', at: at - 1000, previousOwner: true },
    { id: 'old:errand', who: 'pet', text: 'An errand report.', at: at - 500, previousOwner: true },
    { id: 'gift:at', who: 'event', code: 'gift', name: 'Pixel', at },
  ], more: false, before: null } });
  const log = page.getByRole('log');
  await expect(log.getByText('Previous owner')).toBeVisible();
  await expect(log.getByText('Pixel came to you as a gift on Nov 12, 2026. The chats above are from before.')).toBeVisible();
  await expect(page.getByPlaceholder('Say hi to Pixel…')).toBeVisible();
});

// spec: add-gift › Gift rule › дневник до подарка
// spec: add-gift › Gift ownership data › запись дневника до подарка
test('leaves a former owner diary closed until Today, then counts its reading', async ({ page }) => {
  await openPet(page, { diaryUnread: false });
  await expect(page).toHaveURL(/\/pet\/9$/);
  await setWorker(page, { diary: { entry: { kind: 'text', id: 'diary-gift', lines: ['Yesterday I counted the fridge.'], question: 'Did the chart surprise anyone?', work: null, previousOwner: true } } });
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page.getByText('Previous owner')).toBeVisible();
  await expect(page.getByText('Pixel wrote this before coming to you.')).toBeVisible();
  await expect(calls(page)).resolves.toContain('worker:readDiary');
});

// spec: add-hatch-again › Hatch again screen › birth closed for the day
test('keeps Visit and a friend exit beneath the closed hatch line', async ({ page }) => {
  await openWith(page, '/hatch?from=2', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily', until: '2026-11-01T00:00:00Z', ownedCount: 0, knownPets: [{ tokenId: '9', name: 'Pixel', asleep: false }] }, pets: { '2': { tokenId: '2', name: 'Biscuit', stage: 'adult', fullness: { state: 'full', level: 1 }, mood: 'happy' } } } });
  await expect(page.getByText(/^That's all the new pets for today\. Hatching is back at \d\d:\d\d\.$/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Biscuit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
});
