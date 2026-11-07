import { expect, test } from '@playwright/test';
import { calls, lookAgain, openWith, PIXEL, setWorker, SIGNED_IN } from './helpers';
import type { RelationshipSummary } from '../src/seams/worker-types';

const summary: RelationshipSummary = { tokenId: '9', name: 'Pixel', relationships: [
  { tokenId: '2', name: 'Biscuit', stance: 'liked', breakUntil: null },
] };
const worker = (relationships: RelationshipSummary | { fail: { status: number; code: string } } = summary) =>
  ({ owned: ['9'], pets: { '9': { ...PIXEL, worn: 'thinking-cap' as const } }, relationships });

// spec: add-pet-society › Society summary screen › success
test('owner entry opens the private summary and Back returns to the pet', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker() });
  await page.getByRole('link', { name: 'Relationships' }).first().click();
  await expect(page).toHaveURL(/\/pet\/9\/relationships$/);
  await expect(page.getByText('Biscuit')).toBeVisible();
  await expect(page.getByText('Likes')).toBeVisible();
  await page.getByRole('link', { name: 'Back to Pixel' }).first().click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-pet-society › Society summary screen › empty
test('empty summary leads to the hire board', async ({ page }) => {
  await openWith(page, '/pet/9/relationships', { auth: SIGNED_IN, worker: worker({ ...summary, relationships: [] }) });
  await expect(page.getByText("No relationships yet. Feed a friend's pet or ask one for help.")).toBeVisible();
  await page.getByRole('link', { name: 'Find a pet to ask' }).click();
  await expect(page).toHaveURL(/\/hire$/);
});

// spec: add-pet-society › Society summary screen › loading
test('loading does not show cached rows', async ({ page }) => {
  await openWith(page, '/pet/9/relationships', { auth: SIGNED_IN, worker: { ...worker(), relationshipsDelayMs: 3_600_000 } });
  await expect(page.getByText("Getting Pixel's relationships…").first()).toBeVisible();
  await expect(page.getByText('Biscuit')).toHaveCount(0);
});

// spec: add-pet-society › Society summary screen › error
test('a failed ownership read has no rows and retries from the Worker', async ({ page }) => {
  await openWith(page, '/pet/9/relationships', { auth: SIGNED_IN, worker: worker({ fail: { status: 503, code: 'chain_unreachable' } }) });
  await expect(page.getByText("Couldn't load relationships. Try again.").first()).toBeVisible();
  await expect(page.getByText('Biscuit')).toHaveCount(0);
  await setWorker(page, { relationships: summary });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Biscuit')).toBeVisible();
});

// spec: add-pet-society › Society summary screen › signed-out
test('visitor sees the public pet link without asking for private rows', async ({ page }) => {
  await openWith(page, '/pet/9/relationships', { worker: worker() });
  await expect(page.getByText("Sign in to see Pixel's relationships").first()).toBeVisible();
  await expect(page.getByText('Biscuit')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Back to Pixel' }).last()).toHaveAttribute('href', '/pet/9');
  expect((await calls(page)).filter((name) => name === 'worker:relationships')).toHaveLength(0);
});

// spec: add-pet-society › Society summary screen › asleep
test('sleeping pet keeps its rows and offers Feed', async ({ page }) => {
  await openWith(page, '/pet/9/relationships', { auth: SIGNED_IN, worker: { ...worker(), pets: { '9': { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 } } } } });
  await expect(page.getByText('Pixel is asleep. Feed Pixel to ask a friend for help.')).toBeVisible();
  await expect(page.getByText('Biscuit')).toBeVisible();
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

// spec: add-pet-society › Society ownership flow › old owner requests
test('a former owner loses displayed rows on the next read', async ({ page }) => {
  await openWith(page, '/pet/9/relationships', { auth: SIGNED_IN, worker: worker() });
  await expect(page.getByText('Biscuit')).toBeVisible();
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(page.getByText('This pet has a new owner.').first()).toBeVisible();
  await expect(page.getByText('Biscuit')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Visit Pixel' })).toHaveAttribute('href', '/pet/9');
});
