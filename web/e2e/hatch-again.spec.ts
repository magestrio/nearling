import { expect, test } from '@playwright/test';
import { BISCUIT, calls, openWith, PIXEL, reloadHolding, setWorker, SIGNED_IN } from './helpers';

const oldPet = { tokenId: '9', name: 'Pixel', asleep: false };
const petless = { open: true, ownedCount: 0, latestBirth: { tokenId: '9', name: 'Pixel' }, currentPet: null, knownPets: [oldPet] };

// spec: add-hatch-again › Hatch again screen › empty
test('an empty repeat form keeps discovery available and disables birth', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: petless } });
  await expect(page.getByLabel('Name your pet')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Hatch my pet' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toHaveAttribute('href', '/pet/9');
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
});

// spec: add-hatch-again › Hatch again screen › loading
test('checking disables birth and keeps the public board link', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatusDelayMs: 60_000 } });
  await expect(page.getByText('Checking if hatching is open…').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hatch my pet' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
});

// spec: add-hatch-again › Hatch again screen › error
test('an unconfirmed ownership read offers retry without sending a mint', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { fail: { status: 503, code: 'chain_unreachable' } } } });
  await expect(page.getByText("We couldn't check hatching right now. Try again.").first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
  expect((await calls(page)).filter((call) => call.startsWith('worker:hatch:'))).toHaveLength(0);
});

// spec: add-hatch-again › Hatch again screen › signed-out
test('a visitor sees the notices, Google sign-in and board link', async ({ page }) => {
  await openWith(page, '/hatch', { worker: { hatchStatus: { open: true } } });
  await expect(page.getByLabel('Name your pet')).toBeVisible();
  await expect(page.getByRole('button', { name: "Read what's public" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read what goes to NEAR AI' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google to hatch your pet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
});

// spec: add-hatch-again › Hatch again screen › success
// spec: add-hatch-again › Repeat birth flow › no owned pet after gift
// spec: add-hatch-again › Repeat birth flow › repeat attempt
test('a former owner can hatch again and visit the given-away pet', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: petless, hatchResult: { tokenId: '12' } } });
  await expect(page.getByRole('heading', { name: 'Hatch your pet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toHaveAttribute('href', '/pet/9');
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
  await page.getByLabel('Name your pet').fill('Nova');
  await expect(page.getByRole('button', { name: 'Hatch my pet' })).toBeEnabled();
  await page.getByRole('button', { name: 'Hatch my pet' }).click();
  await expect(page).toHaveURL(/\/pet\/12$/);
  expect((await calls(page)).filter((call) => call === 'worker:hatch:Nova')).toHaveLength(1);
});

// spec: add-hatch-again › Hatch again screen › birth closed for the day
// spec: add-hatch-again › Hatch again screen › birth paused
test('closed hatching keeps discovery and the former pet reachable', async ({ page }) => {
  await openWith(page, '/hatch?from=2', { auth: SIGNED_IN, worker: { hatchStatus: { ...petless, open: false, reason: 'daily', until: '2026-11-02T00:00:00.000Z' }, pets: { '2': BISCUIT } } });
  await expect(page.getByText(/That's all the new pets for today/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hatch my pet' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toHaveAttribute('href', '/pet/9');
  await expect(page.getByRole('link', { name: 'Back to Biscuit' })).toHaveAttribute('href', '/pet/2');
  await setWorker(page, { hatchStatus: { ...petless, open: false, reason: 'budget' } });
  await reloadHolding(page);
  await expect(page.getByText('New pets are paused for now.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find a pet to ask' })).toHaveAttribute('href', '/hire');
});

// spec: add-hatch-again › Hatch again screen › already owns a pet
// spec: add-hatch-again › Repeat eligibility rule › gift after opening Hatch
test('a gift received while Hatch stands replaces eligibility with the current pet', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: petless } });
  await page.getByLabel('Name your pet').fill('Nova');
  await setWorker(page, { hatchStatus: { ...petless, ownedCount: 1, currentPet: { tokenId: '12', name: 'Biscuit' }, already: { tokenId: '12', name: 'Biscuit' } } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('You have a pet already.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Biscuit' })).toHaveAttribute('href', '/pet/12');
  await expect(page.getByRole('button', { name: 'Hatch my pet' })).toHaveCount(0);
  expect((await calls(page)).filter((call) => call === 'worker:hatch:Nova')).toHaveLength(0);
});

// spec: add-hatch-again › Repeat birth recovery data › old birth exists during pending repeat
test('an old birth pointer does not settle a pending repeat', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { ...petless, pending: true } } });
  await expect(page.getByRole('button', { name: 'Hatching…' })).toHaveAttribute('aria-disabled', 'true');
  await page.reload();
  await expect(page).toHaveURL(/\/hatch$/);
  await expect(page.getByRole('button', { name: 'Hatching…' })).toHaveAttribute('aria-disabled', 'true');
  expect((await calls(page)).filter((call) => call.startsWith('worker:hatch:'))).toHaveLength(0);
});

// spec: add-hatch-again › Repeat birth recovery data › repeat confirmed failed after lost response
test('a failed original repeat keeps the name and offers a retry', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: petless, hatchResult: { pending: true } } });
  await page.getByLabel('Name your pet').fill('Nova');
  await page.getByRole('button', { name: 'Hatch my pet' }).click();
  await expect(page.getByRole('button', { name: 'Hatching…' })).toBeVisible();
  await setWorker(page, { hatchStatus: { ...petless, failed: true } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText("Your pet didn't hatch this time. Nothing was lost — try again.").first()).toBeVisible();
  await expect(page.getByLabel('Name your pet')).toHaveValue('Nova');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
});

// spec: add-hatch-again › Petless discovery flow › former pet viewed
test('a former owner sees the public pet and can return to Hatch', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: {
    pets: { '9': PIXEL },
    me: { accountId: 'a'.repeat(64), hatched: oldPet, currentPet: null, ownedCount: 0, knownPets: [oldPet] },
  } });
  await expect(page.getByText('This pet belongs to someone else now.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Ask Pixel/ })).toHaveCount(0);
  const hatch = page.getByRole('link', { name: 'Get your own pet' });
  await expect(hatch).toHaveAttribute('href', '/hatch?from=9');
  await hatch.click();
  await expect(page).toHaveURL(/\/hatch\?from=9$/);
});

// spec: add-hatch-again › Repeat birth flow › confirmed birth
// spec: add-hatch-again › Repeat birth recovery data › repeat confirmed after lost response
test('the original repeat confirmation opens only the newborn and starts its first thought', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: petless, hatchResult: { pending: true } } });
  await page.getByLabel('Name your pet').fill('Nova');
  await page.getByRole('button', { name: 'Hatch my pet' }).click();
  await expect(page.getByRole('button', { name: 'Hatching…' })).toBeVisible();
  await setWorker(page, {
    hatchStatus: { ...petless, tokenId: '12', pending: false, ownedCount: 1, currentPet: { tokenId: '12', name: 'Nova' } },
    owned: ['12'],
    pets: { '9': PIXEL, '12': { ...PIXEL, tokenId: '12', name: 'Nova', stage: 'baby', owner: { hello: true } } },
    conversation: { lines: [], more: false, before: null },
    petState: { pending: true },
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page).toHaveURL(/\/pet\/12$/);
  await expect(page.getByRole('status').filter({ hasText: 'Nova is thinking…' })).toBeVisible();
  expect((await calls(page)).filter((call) => call === 'worker:greeting')).toHaveLength(1);
  expect((await calls(page)).filter((call) => call === 'worker:hatch:Nova')).toHaveLength(1);
});

// spec: add-hatch-again › Hatch again screen › known pet asleep
test('an asleep known pet stays visitable', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { ...petless, knownPets: [{ ...oldPet, asleep: true }] } } });
  await expect(page.getByText('Pixel is asleep')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toHaveAttribute('href', '/pet/9');
});

// spec: add-hatch-again › Hatch again screen › friend's pet return
test('the friend link survives the repeat form', async ({ page }) => {
  await openWith(page, '/hatch?from=2', { auth: SIGNED_IN, worker: { hatchStatus: petless, pets: { '2': BISCUIT } } });
  await expect(page.getByRole('link', { name: 'Back to Biscuit' })).toHaveAttribute('href', '/pet/2');
  await page.getByRole('link', { name: 'Back to Biscuit' }).click();
  await expect(page).toHaveURL(/\/pet\/2$/);
});
