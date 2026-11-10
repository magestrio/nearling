import { expect, test } from '@playwright/test';
import { calls, lookAgain, openWith, setWorker, SIGNED_IN } from './helpers';

const pixel = { tokenId: '9', name: 'Pixel', asleep: false };
const petless = { accountId: 'a'.repeat(64), hatched: pixel, latestBirth: pixel, currentPet: null,
  ownedCount: 0, knownPets: [pixel], birth: { open: true } };

// spec: add-hatch-again › Petless Home screen › empty
test('empty: a player with no owned or known pets stays on Home and can hatch or browse', async ({ page }) => {
  await openWith(page, '/', { auth: SIGNED_IN, worker: { me: { ...petless, knownPets: [] } } });
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('No pet of your own right now.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Hatch your pet' }).first()).toHaveAttribute('href', '/hatch');
  await expect(page.getByRole('link', { name: 'Find a pet to ask' }).first()).toHaveAttribute('href', '/hire');
  await expect(page.getByRole('link', { name: /^Visit / })).toHaveCount(0);
});

// spec: add-hatch-again › Petless Home screen › success
test('success: the given-away pet is a visit link; Hatch and Hire are reachable', async ({ page }) => {
  await openWith(page, '/', { auth: SIGNED_IN, worker: { me: petless } });
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toHaveAttribute('href', '/pet/9');
  await page.getByRole('link', { name: 'Visit Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-hatch-again › Petless Home screen › loading
test('loading: a fresh ownership check leaves Hatch and Hire reachable', async ({ page }) => {
  await openWith(page, '/', { auth: SIGNED_IN, worker: { me: petless, meDelayMs: 60_000 } });
  await expect(page.getByText('Finding your pets…').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Hatch your pet' }).first()).toHaveAttribute('href', '/hatch');
  await expect(page.getByRole('link', { name: 'Find a pet to ask' }).first()).toHaveAttribute('href', '/hire');
});

// spec: add-hatch-again › Petless Home screen › error
test('error: unknown ownership keeps the public board and Try again checks anew', async ({ page }) => {
  await openWith(page, '/', { auth: SIGNED_IN, worker: { me: { fail: { status: 503, code: 'chain_unreachable' } } } });
  await expect(page.getByText("We couldn't check your pets. Try again.").first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find a pet to ask' }).first()).toHaveAttribute('href', '/hire');
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toHaveCount(0);
  await setWorker(page, { me: petless });
  await page.getByRole('button', { name: 'Try again' }).first().click();
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toBeVisible();
});

// spec: add-hatch-again › Petless Home screen › closed birth
test('closed birth: paused births leave Hatch, Hire and known pets reachable', async ({ page }) => {
  await openWith(page, '/', { auth: SIGNED_IN, worker: { me: { ...petless, birth: { open: false, reason: 'budget' } } } });
  await expect(page.getByText('New pets are paused for now.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Hatch your pet' }).first()).toHaveAttribute('href', '/hatch');
  await expect(page.getByRole('link', { name: 'Find a pet to ask' }).first()).toHaveAttribute('href', '/hire');
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toHaveAttribute('href', '/pet/9');
});

// spec: add-hatch-again › Petless Home screen › signed-out
test('signed-out: public Home offers Hatch, Hire and sign-in without private links', async ({ page }) => {
  await openWith(page, '/', {});
  await expect(page.getByRole('link', { name: 'Hatch your pet' }).first()).toHaveAttribute('href', '/hatch');
  await expect(page.getByRole('link', { name: 'Find a pet to ask' }).first()).toHaveAttribute('href', '/hire');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toHaveCount(0);
  expect(await calls(page)).not.toContain('worker:me');
});

// spec: add-hatch-again › Petless Home screen › success × receive gift
test('received gift: a fresh ownership read sends Home to the owned pet', async ({ page }) => {
  await openWith(page, '/', { auth: SIGNED_IN, worker: { me: petless } });
  await expect(page.getByText('No pet of your own right now.').first()).toBeVisible();
  await setWorker(page, { me: { ...petless, currentPet: { tokenId: '2', name: 'Biscuit' }, ownedCount: 1 } });
  await lookAgain(page);
  await expect(page).toHaveURL(/\/pet\/2$/);
});
