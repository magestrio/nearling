import { expect, test } from '@playwright/test';
import { BISCUIT, openWith, OWNER, PIXEL, SIGNED_IN } from './helpers';

const PIXEL_REF = { tokenId: '9', name: 'Pixel' };
const ME = { accountId: 'a'.repeat(64), hatched: PIXEL_REF, currentPet: PIXEL_REF, ownedCount: 1 };

// spec: add-pet › Pet screen › success (гость)
test('success (гость): the pet, its name and fullness, no conversation with the pet; «Go to your Pixel», «Feed Biscuit», the advice column', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { me: ME } });
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  await expect(page.getByText('Full', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to your Pixel' })).toHaveAttribute('href', '/pet/9');
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  // a player with a pet of their own has `Advice flow` here, not a conversation with Biscuit: the one log and the one field are the advice's
  await expect(page.getByRole('log')).toHaveCount(1);
  await expect(page.getByRole('log')).toHaveAccessibleName('Advice from Biscuit');
  await expect(page.getByRole('textbox')).toHaveCount(1);
  await expect(page.getByRole('textbox')).toHaveAccessibleName('Ask Biscuit for advice…');
  await expect(page.getByPlaceholder('Talk to Biscuit…')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Get your own pet' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause motion' })).toBeVisible();
});

// spec: add-pet › Pet screen › success (гость)
test('success (гость): a player who never hatched gets «Get your own pet» → `/hatch?from=<token_id>`', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN });
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  const own = page.getByRole('link', { name: 'Get your own pet' });
  await expect(own).toHaveAttribute('href', '/hatch?from=2');
  await expect(page.getByRole('link', { name: /Go to your/ })).toHaveCount(0);
  await own.click();
  await expect(page).toHaveURL(/\/hatch\?from=2$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Hatch your pet' })).toBeVisible();
});

// spec: add-pet › Pet screen › success (гость)
test('success (гость): a sleeping pet — «Biscuit is asleep — food from you would wake Biscuit up.»', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { me: ME, pets: { '2': { ...BISCUIT, fullness: { state: 'asleep', level: 0 } } } } });
  await expect(page.getByRole('paragraph').filter({ hasText: 'Biscuit is asleep — food from you would wake Biscuit up.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await expect(page.getByText('Asleep', { exact: true })).toBeVisible();
});

// spec: add-pet › Pet screen › error
test('error: «We couldn\'t find this pet. The link may be broken.» and «Go home» to `/`', async ({ page }) => {
  await openWith(page, '/pet/77', {});
  await expect(page.getByRole('heading', { level: 1, name: "We couldn't find this pet. The link may be broken." })).toBeVisible();
  await page.getByRole('link', { name: 'Go home' }).click();
  await expect(page).toHaveURL(/\/$/);
});

// spec: add-pet › Pet screen › проверка питомца
test('проверка питомца: the owner, a guest and a visitor each have «Check it\'s really {name}» → `/pet/<id>/verify`', async ({ page }) => {
  for (const [route, fakes, name] of [
    ['/pet/9', { auth: SIGNED_IN, worker: OWNER }, 'Pixel'],
    ['/pet/2', { auth: SIGNED_IN, worker: { me: ME } }, 'Biscuit'],
    ['/pet/2', {}, 'Biscuit'],
  ] as const) {
    await openWith(page, route, fakes);
    const check = page.getByRole('link', { name: `Check it's really ${name}` }).first();
    await expect(check).toHaveAttribute('href', `${route}/verify`);
  }
  // a sleeping pet too, for a visitor
  await openWith(page, '/pet/2', { worker: { pets: { '2': { ...BISCUIT, fullness: { state: 'asleep', level: 0 } }, '9': PIXEL } } });
  await expect(page.getByRole('link', { name: "Check it's really Biscuit" })).toHaveAttribute('href', '/pet/2/verify');
});
