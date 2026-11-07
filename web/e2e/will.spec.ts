import { expect, test } from '@playwright/test';
import { calls, lookAgain, openDiary, openPet, setPixel, setWorker, SIGNED_IN, OWNER, PIXEL, WARDROBE_OWNS } from './helpers';
import { openWith } from './helpers';
import { sampleDiary } from '../src/seams/diary.sample';
import type { OutfitSlug } from '../src/seams/worker-types';
import { verificationFakes } from './verification.fixtures';

const wish = { item: 'smart-glasses' as const, reason: 'I want to see every tiny detail.', status: 'active' as const,
  reserveYocto: '660000000000000000000' };
const wishOwner = { wish, wishReserveYocto: wish.reserveYocto, wishActive: true,
  outfits: WARDROBE_OWNS, worn: 'thinking-cap' };

// spec: add-pet-will › Wish pursuit flow › wish chosen
// spec: add-pet-will › Wish sheet screen › success
test('owner sees cents-first progress, opens the private wish and closes without changing it', async ({ page }) => {
  await openPet(page, wishOwner);
  await expect(page.getByText('Pixel wants Smart glasses').first()).toBeVisible();
  await expect(page.getByText('Saved 0.30¢ of 0.76¢').first()).toBeVisible();
  const opener = page.getByRole('link', { name: "Pixel's wish" }).first();
  await opener.click();
  const sheet = page.getByRole('dialog', { name: "Pixel's wish" });
  await expect(sheet).toContainText('I want to see every tiny detail.');
  await expect(sheet).toContainText('0.00066 of 0.00166 NEAR');
  await expect(sheet).toContainText('Earned food only');
  await expect(sheet.locator('.ds-facts')).toHaveText(/^Earned food only\s*$/);
  await expect(sheet).toContainText("Saved food and a bought outfit are public on NEAR forever. The wish's words stay private.");
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect((await calls(page)).filter((c) => c === 'worker:cancelWish')).toHaveLength(0);
});

// spec: add-pet-will › Will chain disclosure data › savings notice × Reload
test('reload recovers the private wish and public reserve without a browser draft', async ({ page }) => {
  await openPet(page, wishOwner);
  await expect(page.getByText('Full', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved 0.30¢ of 0.76¢').first()).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: "Pixel's wish" }).first().click();
  await expect(page.getByRole('dialog', { name: "Pixel's wish" })).toContainText('0.00066 of 0.00166 NEAR');
});

// spec: add-pet-will › Wish sheet screen › error
test('failed fresh read offers retry and no cancellation', async ({ page }) => {
  await openPet(page, wishOwner, { wish: { fail: { status: 503, code: 'chain_unreachable' } } });
  await page.getByRole('link', { name: "Pixel's wish" }).first().click();
  const sheet = page.getByRole('dialog', { name: "Pixel's wish" });
  await expect(sheet).toContainText('Wish unavailable. Try again.');
  await expect(sheet.getByRole('button', { name: 'Cancel wish' })).toHaveCount(0);
  await setWorker(page, { wish: { wish, reserveYocto: wish.reserveYocto, active: true, releaseStatus: null } });
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await expect(sheet).toContainText('Saved 0.30¢ of 0.76¢');
});

// spec: add-pet-will › Wish pursuit flow › owner cancels
test('cancellation closes only after the Worker confirms release', async ({ page }) => {
  await openPet(page, wishOwner, { cancelWish: { status: 'pending' } });
  await page.getByRole('link', { name: "Pixel's wish" }).first().click();
  const sheet = page.getByRole('dialog', { name: "Pixel's wish" });
  await sheet.getByRole('button', { name: 'Cancel wish' }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Cancel wish' })).toHaveAttribute('aria-disabled', 'true');
  await setWorker(page, { wish: { wish: null, reserveYocto: '0', active: false, releaseStatus: 'confirmed' },
    pets: { '9': { ...PIXEL, owner: { ...wishOwner, wish: null, wishReserveYocto: '0', wishActive: false } }, '2': OWNER.pets['2'] } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(sheet).toHaveCount(0);
  expect((await calls(page)).filter((c) => c === 'worker:cancelWish')).toHaveLength(1);
});

// spec: add-pet-will › Wish pursuit flow › owner cancels
test('an unknown release can be closed and a failed release can be retried', async ({ page }) => {
  await openPet(page, wishOwner, { cancelWish: { status: 'pending' } });
  await page.getByRole('link', { name: "Pixel's wish" }).first().click();
  const sheet = page.getByRole('dialog', { name: "Pixel's wish" });
  await sheet.getByRole('button', { name: 'Cancel wish' }).click();
  await setWorker(page, { wish: { wish: { ...wish, status: 'paused' }, reserveYocto: wish.reserveYocto,
    active: false, releaseStatus: 'unknown' } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(sheet.getByRole('button', { name: 'Cancel wish' })).toHaveAttribute('aria-disabled', 'true');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
  await setWorker(page, { wish: { wish: { ...wish, status: 'paused' }, reserveYocto: wish.reserveYocto,
    active: false, releaseStatus: 'failed' } });
  await page.getByRole('link', { name: "Pixel's wish" }).first().click();
  await expect(sheet.getByRole('alert')).toContainText('Wish cancellation failed. Try again.');
  await expect(sheet.getByRole('button', { name: 'Cancel wish' })).not.toHaveAttribute('aria-disabled', 'true');
  await sheet.getByRole('button', { name: 'Cancel wish' }).click();
  expect((await calls(page)).filter((c) => c === 'worker:cancelWish')).toHaveLength(2);
});

// spec: add-pet-will › Wish pursuit flow › purchase waits for daily reset
test('cap-held full reserve says Buying tomorrow without an earned outfit', async ({ page }) => {
  await openPet(page, { ...wishOwner, wish: { ...wish, status: 'waiting_day', reserveYocto: '1660000000000000000000' } });
  await page.getByRole('link', { name: "Pixel's wish" }).first().click();
  const sheet = page.getByRole('dialog', { name: "Pixel's wish" });
  await expect(sheet).toContainText('Buying tomorrow');
  await expect(sheet).toContainText('Saved 0.76¢ of 0.76¢');
  await expect(page.getByText('Pixel earned Smart glasses!')).toHaveCount(0);
});

// spec: add-pet-will › Wish pursuit flow › no target
test('all purchasable outfits owned shows no target and opens no wish sheet', async ({ page }) => {
  await openPet(page, { outfits: [...WARDROBE_OWNS, 'smart-glasses', 'bow-tie', 'headphones'] });
  await expect(page.getByText('Pixel has every outfit for now.')).toBeVisible();
  await expect(page.getByRole('link', { name: "Pixel's wish" })).toHaveCount(0);
});

// spec: add-pet-will › Wish pursuit flow › automatic purchase
test('confirmed wish purchase appears on Pet and Wardrobe without a second Buy', async ({ page }) => {
  const owner = { outfits: [...WARDROBE_OWNS, 'smart-glasses' as OutfitSlug], worn: 'thinking-cap' as OutfitSlug };
  const worker = { ...OWNER, wardrobe: { outcome: { id: 'wish-buy', item: 'smart-glasses' as const, status: 'bought' as const, code: null, source: 'pet_wish' as const } },
    pets: { '9': { ...PIXEL, owner }, '2': OWNER.pets['2'] } };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker });
  await expect(page.getByText('Pixel earned Smart glasses!')).toBeVisible();
  await page.getByRole('link', { name: 'Wardrobe' }).click();
  await expect(page.getByText('Pixel earned Smart glasses!')).toBeVisible();
  await expect(page.getByRole('button', { name: /Buy.*Smart glasses/ })).toHaveCount(0);
});

// spec: add-pet-will › Wish pursuit flow › target bought by owner
test('owner Wardrobe buy ends the visible wish after the confirmed release', async ({ page }) => {
  await openPet(page, wishOwner, { wardrobe: { outcome: { id: 'owner-buy', item: 'smart-glasses', status: 'bought', code: null, source: 'owner' } } });
  await expect(page.getByText('Pixel wants Smart glasses').first()).toBeVisible();
  await setPixel(page, { ...wishOwner, wish: null, wishReserveYocto: '0', wishActive: false,
    outfits: [...WARDROBE_OWNS, 'smart-glasses'] });
  await lookAgain(page);
  await expect(page.getByText('Pixel already has Smart glasses.')).toBeVisible();
  await expect(page.getByRole('link', { name: "Pixel's wish" })).toHaveCount(0);
});

// spec: add-pet-will › Will ownership rule › former owner opens
test('gift while sheet is open removes private words and shows the public Pet page', async ({ page }) => {
  await openPet(page, wishOwner);
  await page.getByRole('link', { name: "Pixel's wish" }).first().click();
  await expect(page.getByRole('dialog', { name: "Pixel's wish" })).toBeVisible();
  await setWorker(page, { owned: [] });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('main').getByText('This pet belongs to someone else now.')).toBeVisible();
  await expect(page.getByText('I want to see every tiny detail.')).toHaveCount(0);
});

// spec: add-pet-will › Will ownership rule › gift confirmed
// spec: add-pet-will › Will ownership rule › new owner continues
test('the new owner continues the same paused wish with one request', async ({ page }) => {
  await openPet(page, { ...wishOwner, wish: { ...wish, status: 'paused' }, wishActive: false });
  await page.getByRole('link', { name: "Pixel's wish" }).first().click();
  const sheet = page.getByRole('dialog', { name: "Pixel's wish" });
  await expect(sheet).toContainText('Pixel has a wish in progress');
  await sheet.getByRole('button', { name: 'Continue wish' }).click();
  await expect(sheet).not.toContainText('Pixel has a wish in progress');
  await expect(sheet).toContainText('I want to see every tiny detail.');
  expect((await calls(page)).filter((c) => c === 'worker:continueWish')).toHaveLength(1);
  expect((await calls(page)).filter((c) => c === 'worker:cancelWish')).toHaveLength(0);
});

// spec: add-pet-will › Will ownership rule › gift confirmed
// spec: add-pet-will › Wish pursuit flow › owner cancels
test('the new owner can cancel the paused reserve without buying an outfit', async ({ page }) => {
  await openPet(page, { ...wishOwner, wish: { ...wish, status: 'paused' }, wishActive: false });
  await page.getByRole('link', { name: "Pixel's wish" }).first().click();
  await page.getByRole('dialog', { name: "Pixel's wish" }).getByRole('button', { name: 'Cancel wish' }).click();
  await expect(page.getByRole('dialog', { name: "Pixel's wish" })).toHaveCount(0);
  expect((await calls(page)).filter((c) => c === 'worker:cancelWish')).toHaveLength(1);
  expect((await calls(page)).filter((c) => c === 'worker:continueWish')).toHaveLength(0);
});

// spec: add-pet-will › Will memory clear flow › release fails
// spec: add-pet-will › Will memory clear flow › deletion fails after release
for (const status of [503, 500]) {
  test(`a failed will clear at HTTP ${status} keeps the wish and private memory`, async ({ page }) => {
    await openPet(page, wishOwner, { clearMemory: { fail: { status, code: 'clear_failed' } } });
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
    const dialog = page.getByRole('alertdialog', { name: "Clear Pixel's memory?" });
    await dialog.getByRole('button', { name: 'Clear memory' }).click();
    await expect(dialog.getByRole('alert')).toHaveText("Memory wasn't cleared. Try again.");
    await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
    await dialog.getByRole('button', { name: 'Keep memory' }).click();
    await page.getByRole('link', { name: "Pixel's wish" }).first().click();
    await expect(page.getByRole('dialog', { name: "Pixel's wish" })).toContainText('I want to see every tiny detail.');
    expect((await calls(page)).filter((c) => c === 'worker:clearMemory:9')).toHaveLength(1);
  });
}

// spec: add-pet-will › Reserved food invariant contract › ordinary debit cannot spend reserve
test('feeding reads spendable fullness while the public wish reserve stays separate', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: {
    '9': { ...PIXEL, fullness: { state: 'hungry', level: 0.25 }, owner: wishOwner }, '2': OWNER.pets['2'],
  } } });
  await expect(page.getByText('Saved 0.30¢ of 0.76¢').first()).toBeVisible();
  await expect(page.getByText('Hungry', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Feed Pixel' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Feed Pixel' }).getByText('Hungry', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved 0.30¢ of 0.76¢').first()).toBeVisible();
});

// spec: add-pet-will › Will ownership rule › former owner opens × Session expiry
test('expired session closes the sheet and removes private wish words', async ({ page }) => {
  await openPet(page, wishOwner);
  await page.getByRole('link', { name: "Pixel's wish" }).first().click();
  await expect(page.getByRole('dialog', { name: "Pixel's wish" })).toBeVisible();
  await setWorker(page, { sessionExpired: true });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('dialog', { name: "Pixel's wish" })).toHaveCount(0);
  await expect(page.getByText('I want to see every tiny detail.')).toHaveCount(0);
  await expect(page.getByText('Pixel wants Smart glasses')).toHaveCount(0);
});

// spec: add-pet-will › Wish pursuit flow › wish chosen
test('Diary shows the single private will line from the paid thought', async ({ page }) => {
  const entry = sampleDiary().entry;
  if (entry.kind !== 'text') throw new Error('sample diary must have a text entry');
  await openDiary(page, { entry: { ...entry, willLine: 'I keep thinking about the Smart glasses. My saved food is getting closer.' } });
  await expect(page.getByText('I keep thinking about the Smart glasses. My saved food is getting closer.')).toHaveCount(1);
});

const invite = (id: string, workerId: string, name: string, createdAt: number) => ({ id, workerId, name, label: null,
  price: { cents: 0.38, yocto: '830000000000000000000' }, createdAt, expiresAt: Date.UTC(2099, 0, 1) });
const cards = [invite('b'.repeat(24), '3', 'Nori', 2), invite('a'.repeat(24), '2', 'Biscuit', 1)];

// spec: add-pet-will › Work invitation card screen › several valid invitations
// spec: add-pet-will › Work seeking flow › recipient dismisses
test('several invitations stay separate and Dismiss removes only the selected card', async ({ page }) => {
  await openPet(page, {}, { invitations: { invitations: cards } });
  const list = page.getByRole('list', { name: 'Work invitations' }).filter({ visible: true });
  await expect(list.getByRole('heading', { name: 'Work invitation' })).toHaveCount(2);
  await expect(list.locator('li').first()).toContainText('Nori');
  await list.getByRole('button', { name: 'Dismiss Nori' }).click();
  await expect(list).not.toContainText('Nori');
  await expect(list).toContainText('Biscuit');
  expect((await calls(page)).filter((call) => call === 'worker:dismissInvitation')).toHaveLength(1);
});

// spec: add-pet-will › Work seeking flow › recipient accepts
test('Ask accepts only that card and opens blank advice at the current quote', async ({ page }) => {
  await openPet(page, {}, { invitations: { invitations: cards },
    me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 } });
  await page.getByRole('button', { name: 'Ask Biscuit' }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/pet\/2\?from=9$/);
  await expect(page.getByPlaceholder('Ask Biscuit for advice…')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Ask Biscuit · 0.38¢' })).toBeVisible();
  expect((await calls(page)).filter((call) => call === 'worker:acceptInvitation')).toHaveLength(1);
});

// spec: add-pet-will › Work invitation card screen › error
test('an invitation that ends under Ask offers another pet without a hire', async ({ page }) => {
  await openPet(page, {}, { invitations: { invitations: cards }, acceptInvitation: { fail: { status: 409, code: 'invitation_ended' } } });
  await page.getByRole('button', { name: 'Ask Biscuit' }).filter({ visible: true }).click();
  await expect(page.getByText('This invitation has ended.').filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find another pet' }).filter({ visible: true })).toHaveAttribute('href', '/hire');
  await expect(page.getByText('Nori', { exact: true }).filter({ visible: true })).toBeVisible();
  expect((await calls(page)).filter((call) => call === 'worker:askAdvice')).toHaveLength(0);
});

// spec: add-pet-will › Work invitation card screen › success
test('a failed invitation action stays on its card with an announced retry', async ({ page }) => {
  await openPet(page, {}, { invitations: { invitations: cards }, dismissInvitation: { fail: { status: 503, code: 'chain_unreachable' } } });
  const list = page.getByRole('list', { name: 'Work invitations' }).filter({ visible: true });
  await list.getByRole('button', { name: 'Dismiss Nori' }).click();
  await expect(list.getByRole('alert')).toContainText('Could not update this invitation. Try again.');
  await expect(list).toContainText('Nori');
  await expect(list).toContainText('Biscuit');
  await setWorker(page, { dismissInvitation: { status: 'dismissed' } });
  await list.getByRole('button', { name: 'Try again' }).click();
  await expect(list).not.toContainText('Nori');
  await expect(list).toContainText('Biscuit');
});

// spec: add-pet-will › Work invitation card screen › success
test('a failed invitation list read announces retry without a blank silent page', async ({ page }) => {
  await openPet(page, {}, { invitations: { fail: { status: 503, code: 'chain_unreachable' } } });
  const list = page.getByRole('list', { name: 'Work invitations' }).filter({ visible: true });
  await expect(list.getByRole('alert')).toContainText('Work invitations unavailable. Try again.');
  await setWorker(page, { invitations: { invitations: cards } });
  await list.getByRole('button', { name: 'Try again' }).click();
  await expect(list.getByRole('button', { name: 'Ask Biscuit' })).toBeVisible();
});

// spec: add-pet-will › Work invitation card screen › several valid invitations × gift/session expiry
test('a gift or session loss removes private invitation cards', async ({ page }) => {
  await openPet(page, {}, { invitations: { invitations: cards } });
  await expect(page.getByRole('button', { name: 'Ask Biscuit' }).filter({ visible: true })).toBeVisible();
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(page.getByRole('button', { name: 'Ask Biscuit' })).toHaveCount(0);
});

// spec: add-pet-will › Refusal privacy data › worker owner views refusal
test('worker owner sees only a broad refusal activity code', async ({ page }) => {
  await openPet(page, { willActivity: [{ at: 1, code: 'character' }] });
  await expect(page.getByText('Pixel declined a request · character')).toBeVisible();
  await expect(page.getByText('My cat ignores me after I travel.')).toHaveCount(0);
});

// spec: add-pet-will › Character refusal flow › character declines player advice
// spec: add-pet-will › Character refusal flow › no signed answer
// spec: add-pet-will › Character refusal flow › third screening fails
// spec: add-pet-will › Character refusal flow › refusal capacity reached
for (const [code, line] of [
  ['character_refused', 'I would rather sit this one out. No food was spent.'],
  ['screening_failed', 'Biscuit lost that thought. Nothing was spent — try again.'],
  ['screening_exhausted', 'Biscuit is unavailable until tomorrow.'],
  ['screening_capacity', 'Biscuit is unavailable until tomorrow.'],
] as const) {
  test(`advice shows ${code} without losing the question`, async ({ page }) => {
    await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': OWNER.pets['2'] },
      me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 },
      petState: { code, jobKind: 'advice', characterRefusal: code === 'character_refused'
        ? { id: 'f'.repeat(24), reason: 'I would rather sit this one out.' } : undefined } } });
    const field = page.getByPlaceholder('Ask Biscuit for advice…');
    await field.fill('What should I say?');
    await page.getByRole('button', { name: 'Ask Biscuit · 0.38¢' }).click();
    await expect(page.getByText(line, { exact: false }).filter({ visible: true }).first()).toBeVisible();
    await expect(field).toHaveValue('What should I say?');
    if (code === 'character_refused') await expect(page.getByRole('link', { name: 'Check this thought' }).filter({ visible: true })).toHaveAttribute('href', `/pet/9/verify/refusal/${'f'.repeat(24)}`);
    if (code !== 'screening_failed') await expect(page.getByRole('link', { name: 'Ask another pet' }).filter({ visible: true })).toHaveAttribute('href', '/hire');
  });
}

// spec: add-pet-will › Character refusal flow › no signed answer
test('a failed screening retry shows its question once', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': OWNER.pets['2'] },
    me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 },
    petState: { code: 'screening_failed', jobKind: 'advice' } } });
  const question = 'Can you help me with this?';
  await page.getByPlaceholder('Ask Biscuit for advice…').fill(question);
  await page.getByRole('button', { name: 'Ask Biscuit · 0.38¢' }).click();
  await expect(page.getByText('Biscuit lost that thought. Nothing was spent — try again.').filter({ visible: true })).toBeVisible();
  await setWorker(page, { petState: { pending: true } });
  await page.getByRole('log', { name: 'Advice from Biscuit' }).getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('log', { name: 'Advice from Biscuit' }).getByText(question, { exact: true })).toHaveCount(1);
});

// spec: add-pet-will › Character refusal flow › refusal capacity reached
test('a fresh Worker read reopens advice after UTC reset even with a device clock behind', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-06T23:50:00.000Z') });
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': OWNER.pets['2'] },
    me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 },
    advice: { screeningAvailable: false, screeningResetAt: '2026-11-07T00:00:00.000Z' } } });
  await page.getByPlaceholder('Ask Biscuit for advice…').fill('Can you help?');
  const ask = page.getByRole('button', { name: 'Ask Biscuit · 0.38¢' });
  await expect(ask).toHaveAttribute('aria-disabled', 'true');
  await setWorker(page, { advice: { screeningAvailable: true, screeningResetAt: null } });
  await page.clock.runFor(10_000);
  await expect(ask).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-will › Refusal privacy data › receipt read
test('payer sees signed refusal evidence with an honest absence of chain receipt', async ({ page }) => {
  const proof = verificationFakes();
  await openWith(page, `/pet/9/verify/refusal/${'f'.repeat(24)}`, { ...proof, worker: { ...proof.worker,
    refusalEvidence: { id: 'f'.repeat(24), reason: "I can't answer that as myself. I need to know them better first.", at: 1,
      signedEvidenceBase64: Buffer.from(JSON.stringify({ signature: `0x${'1'.repeat(130)}` })).toString('base64'), onChainReceipt: false } } });
  await expect(page.getByText('No on-chain receipt for this refusal.').filter({ visible: true })).toBeVisible();
  await expect(page.getByText("I can't answer that as myself. I need to know them better first.").filter({ visible: true })).toBeVisible();
  await expect(page.getByText('Request and reply match the receipt on NEAR')).toHaveCount(0);
});

// spec: add-pet-will › Refusal privacy data › receipt read × gift/session expiry
test('a former payer owner cannot read private refusal evidence', async ({ page }) => {
  const proof = verificationFakes();
  await openWith(page, `/pet/9/verify/refusal/${'f'.repeat(24)}`, { ...proof, worker: { ...proof.worker, owned: [],
    refusalEvidence: { id: 'f'.repeat(24), reason: 'Private refusal reason', at: 1,
      signedEvidenceBase64: Buffer.from(JSON.stringify({ signature: `0x${'1'.repeat(130)}` })).toString('base64'), onChainReceipt: false } } });
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(page.getByText('Private refusal reason')).toHaveCount(0);
  await expect(page.getByText('No on-chain receipt for this refusal.')).toHaveCount(0);
});

// spec: add-pet-will › Character refusal flow › society refusal first
test('relationship refusal blocks advice before a character screening starts', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': OWNER.pets['2'] },
    me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 },
    advice: { refusalUntil: '2099-01-01T18:00:00.000Z' } } });
  await page.getByPlaceholder('Ask Biscuit for advice…').fill('Can you help?');
  await expect(page.getByText('Biscuit needs a break from Pixel', { exact: false }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ask another pet' }).filter({ visible: true })).toBeVisible();
  expect((await calls(page)).filter((call) => call === 'worker:askAdvice')).toHaveLength(0);
});

// spec: add-pet-will › Character refusal flow › character declines pet hire
test('Manual hire refusal shows the signed reason before the payer pet answers itself', async ({ page }) => {
  const question = 'How do you make a room care about a chart in one sentence?';
  const offer = { worker: 'Nori', question, price: { yocto: '380000000000000000000', cents: 0.38 } };
  const prior = [
    { id: 'h1:you', who: 'player' as const, text: 'And if they ask why the chart matters?', at: 10 },
    { id: 'h1', who: 'pet' as const, text: question, at: 11, hireTo: 'Nori' },
  ];
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER,
    pets: { '9': { ...PIXEL, owner: { hireMode: 'manual', offer } }, '2': OWNER.pets['2'] },
    conversation: { lines: prior, more: false, before: null }, petState: { pending: true } } });
  await page.getByRole('button', { name: 'Ask Nori' }).click();
  await setWorker(page, { conversation: { lines: [...prior,
    { id: 'h2', who: 'event', code: 'character_refused', worker: { tokenId: '5', name: 'Nori' }, hireMode: 'manual',
      refusal: { id: 'f'.repeat(24), reason: 'I would rather leave this one to Pixel.' }, at: 12 },
    { id: 'h3', who: 'pet', text: 'Say what the chart changed for you — one sentence. Then let the room catch up.', at: 13 }], more: false, before: null },
    pets: { '9': { ...PIXEL, owner: { hireMode: 'manual', offer: null } }, '2': OWNER.pets['2'] },
    petState: { pending: false, jobKind: 'hire', offer: null,
      thought: { id: 'h3', text: 'Say what the chart changed for you — one sentence. Then let the room catch up.', cut: null },
      characterRefusal: { id: 'f'.repeat(24), reason: 'I would rather leave this one to Pixel.' } } });
  await expect(page.getByText('I would rather leave this one to Pixel. Pixel will answer instead.')).toBeVisible();
  await expect(page.getByText('Say what the chart changed for you — one sentence. Then let the room catch up.')).toBeVisible();
  await expect(page.locator(`a[href="/pet/9/verify/refusal/${'f'.repeat(24)}"]`).filter({ visible: true })).toHaveAccessibleName('Check this thought');
  await expect(page.getByText('Pixel asked Nori · 0.38¢')).toHaveCount(0);
});

// spec: add-pet-will › Character refusal flow › character declines pet hire
// spec: add-pet-will › Refusal privacy data › signed refusal
test('a conversation reload keeps the private refusal reason and evidence link', async ({ page }) => {
  const prior = [{ id: 'h2', who: 'event' as const, code: 'character_refused' as const,
    worker: { tokenId: '5', name: 'Nori' }, hireMode: 'manual' as const,
    refusal: { id: 'f'.repeat(24), reason: 'I would rather leave this one to Pixel.' }, at: 12 },
  { id: 'h3', who: 'pet' as const, text: 'I will answer myself.', at: 13 }];
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER,
    conversation: { lines: prior, more: false, before: null } } });
  await expect(page.getByText('I would rather leave this one to Pixel. Pixel will answer instead.')).toBeVisible();
  await expect(page.locator(`a[href="/pet/9/verify/refusal/${'f'.repeat(24)}"]`).filter({ visible: true })).toHaveAccessibleName('Check this thought');
  await page.reload();
  await expect(page.getByText('I would rather leave this one to Pixel. Pixel will answer instead.')).toBeVisible();
  await expect(page.locator(`a[href="/pet/9/verify/refusal/${'f'.repeat(24)}"]`).filter({ visible: true })).toHaveAccessibleName('Check this thought');
});
