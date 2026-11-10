import { expect, test } from '@playwright/test';
import { BISCUIT, calls, openWith, PIXEL, setWorker, SIGNED_IN } from './helpers';

const petless = { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: null, ownedCount: 0 };
const price = { cents: 0.38, yocto: '380000000000000000000' };
const board = { pets: [{ tokenId: '2', opaqueId: 'biscuit', name: 'Biscuit', label: 'storytelling', price, status: 'available' as const, yours: false }], visits: [] };

// spec: add-hatch-again › Petless discovery flow › board opened
test('a former owner can browse priced worker pets without a paying pet', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { me: petless, hireBoard: board, pets: { '2': BISCUIT } } });
  await expect(page.getByText('Browse pets now. To ask for paid advice, hatch or receive a pet first.')).toBeVisible();
  await expect(page.getByText('Good at storytelling')).toBeVisible();
  await expect(page.getByText('0.38¢ to ask')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Visit Biscuit' })).toHaveAttribute('href', '/pet/2');
  expect((await calls(page)).filter((call) => call.startsWith('worker:askAdvice'))).toHaveLength(0);
});

// spec: add-hatch-again › Petless discovery flow › empty board with no pets to visit
test('an empty board sends the petless player to Hatch', async ({ page }) => {
  await openWith(page, '/hire', { auth: SIGNED_IN, worker: { me: petless, hireBoard: { pets: [], visits: [] } } });
  await expect(page.getByText('No pets with skills are on the board yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toHaveAttribute('href', '/hatch');
});

// spec: add-hatch-again › Petless discovery flow › advice attempted without a pet
test('the blocked advice state keeps the question and payment unsent', async ({ page }) => {
  await openWith(page, '/hire?advice=without-pet', { auth: SIGNED_IN, worker: { me: petless, hireBoard: board } });
  await expect(page.getByText('You need a pet of your own to pay for advice.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toHaveAttribute('href', '/hatch');
  const asked = await calls(page);
  expect(asked.filter((call) => call.startsWith('worker:askAdvice'))).toHaveLength(0);
  expect(asked.filter((call) => call.startsWith('worker:prepareAdvice'))).toHaveLength(0);
});

// spec: add-hatch-again › Petless discovery flow › advice attempted without a pet
test('a gift while the advice form is open redirects before the question leaves the browser', async ({ page }) => {
  const owned = { ...petless, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: {
    owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT }, me: owned, advice: { price }, hireBoard: board,
  } });
  const question = page.getByPlaceholder('Ask Biscuit for advice…');
  await question.fill('Could Biscuit help?');
  await setWorker(page, { me: petless, owned: [] });
  await page.getByRole('button', { name: 'Ask Biscuit · 0.38¢' }).click();
  await expect(page).toHaveURL(/\/hire\?advice=without-pet$/);
  await expect(page.getByText('You need a pet of your own to pay for advice.')).toBeVisible();
  expect((await calls(page)).filter((call) => call.startsWith('worker:askAdvice'))).toHaveLength(0);
});

// spec: add-hatch-again › Repeat ownership data › prior owner reads old memory
test('a refused former-owner memory read says the memories belong to the new owner', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL }, conversation: { fail: { status: 403, code: 'former_owner' } } } });
  await expect(page.getByText('You can visit Pixel, but its memories belong to its new owner.').first()).toBeVisible();
});
