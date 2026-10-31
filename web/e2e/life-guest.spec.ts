import { expect, test, type Page } from '@playwright/test';
import type { FakeState } from '../src/seams/fakes';
import { BISCUIT, calls, lookAgain, openWith, PIXEL, setWorker, SIGNED_IN } from './helpers';

const PIXEL_REF = { tokenId: '9', name: 'Pixel' };
const ME = { accountId: 'a'.repeat(64), hatched: PIXEL_REF, currentPet: PIXEL_REF, ownedCount: 1 };
const OFFLINE = "Can't reach Biscuit right now. Nothing's lost — try again in a moment.";
const down = { fail: { status: 503, code: 'chain_unreachable' } };

/** Biscuit in a mood of the day; Pixel beside it, as everywhere */
const withMood = (mood: 'happy' | 'calm' | 'sleepy' | null, stage: 'baby' | 'teen' | 'adult' = 'adult') => ({ pets: { '9': PIXEL, '2': { ...BISCUIT, stage, mood } } });
type Who = 'guest' | 'visitor';
const WHO: Who[] = ['guest', 'visitor'];
/** A signed-in player with a pet of their own, or a visitor with no session, on Biscuit's page */
const as = (who: Who, mood: 'happy' | 'calm' | 'sleepy' | null, stage: 'baby' | 'teen' | 'adult' = 'adult'): FakeState =>
  who === 'guest' ? { auth: SIGNED_IN, worker: { me: ME, ...withMood(mood, stage) } } : { worker: withMood(mood, stage) };
const face = (page: Page) => page.locator('.ds-pet').first();
const looks = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:pet').length;
const hide = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

// spec: add-pet-life › Pet life display rule › гость
test('гость: a guest and a visitor see the model and the face — no stage word, no traits, no energy', async ({ page }) => {
  for (const who of WHO) {
    // a teen: the figure's own default is the adult, so a stage that is not passed down shows
    await openWith(page, '/pet/2', as(who, 'calm', 'teen'));
    await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
    await expect(face(page)).toHaveAttribute('data-face', 'calm');
    // the model is by the stage (`Pet life display rule` › «гость»: «модель по стадии»)
    await expect(face(page)).toHaveAttribute('data-stage', 'teen');
    await expect(page.getByRole('meter')).toHaveCount(0);
    for (const word of ['Baby', 'Teen', 'Grown-up', 'clever', 'sociable', 'hard-working', 'thoughtful', 'cozy', 'Energy']) {
      await expect(page.getByText(word, { exact: true })).toHaveCount(0);
    }
  }
});

// spec: add-pet-life › Pet life display rule › гость
test('гость: the pet falls asleep while the page is open — the page says it in its live region, and says nothing when it wakes', async ({ page }) => {
  const asleepLine = 'Biscuit is asleep — food from you would wake Biscuit up.';
  for (const who of WHO) {
    await openWith(page, '/pet/2', as(who, 'calm'));
    await expect(face(page)).toHaveAttribute('data-face', 'calm');
    await expect(page.getByRole('status').filter({ hasText: asleepLine })).toHaveCount(0);
    await setWorker(page, { pets: { '9': PIXEL, '2': { ...BISCUIT, fullness: { state: 'asleep' as const, level: 0 } } } });
    await lookAgain(page);
    await expect(page.getByRole('paragraph').filter({ hasText: asleepLine })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: asleepLine })).toHaveCount(1);
    await setWorker(page, withMood('calm'));
    await lookAgain(page);
    await expect(page.getByRole('paragraph').filter({ hasText: asleepLine })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: asleepLine })).toHaveCount(0);
  }
});

// spec: add-pet-life › Mood rule › радостный × a guest page open
for (const who of WHO) {
  test(`радостный × a guest page open: the face changes by itself within 10 s, with no reload — a ${who}'s page`, async ({ page }) => {
    await page.clock.install();
    await openWith(page, '/pet/2', as(who, 'calm'));
    await expect(face(page)).toHaveAttribute('data-face', 'calm');
    const before = await looks(page);
    // the pet is fed meanwhile: the day's mood is happy; the page looks again by itself, every 10 s
    await setWorker(page, withMood('happy'));
    await page.clock.fastForward(10_000);
    await expect(face(page)).not.toHaveAttribute('data-face', /.*/);
    expect(await looks(page)).toBeGreaterThan(before);
  });
}

// spec: add-pet-life › Mood rule › новые сутки × a guest's page
test('новые сутки × a guest\'s page: 00:00 UTC turns the happy face calm on the next look, with no reload', async ({ page }) => {
  await openWith(page, '/pet/2', as('guest', 'happy'));
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  await expect(face(page)).not.toHaveAttribute('data-face', /.*/);
  await setWorker(page, withMood('calm'));
  await lookAgain(page);
  await expect(face(page)).toHaveAttribute('data-face', 'calm');
});

// spec: add-pet-life › Pet life display rule › гость × tab hidden and back
test('гость × tab hidden and back: a hidden tab looks at nothing; coming back looks once, at once', async ({ page }) => {
  await page.clock.install();
  await openWith(page, '/pet/2', as('guest', 'calm'));
  await expect(face(page)).toHaveAttribute('data-face', 'calm');
  await hide(page, true);
  const hiddenAt = await looks(page);
  for (let i = 0; i < 3; i += 1) await page.clock.fastForward(10_000);
  expect(await looks(page)).toBe(hiddenAt);
  await setWorker(page, withMood('happy'));
  await hide(page, false);
  await expect(face(page)).not.toHaveAttribute('data-face', /.*/);
  expect(await looks(page)).toBe(hiddenAt + 1);
});

// spec: add-pet-life › Pet life display rule › гость × connection lost
test('гость × connection lost: the connection line over the last known pet; it goes with the next answer', async ({ page }) => {
  await openWith(page, '/pet/2', as('guest', 'calm'));
  await expect(face(page)).toHaveAttribute('data-face', 'calm');
  await setWorker(page, { petResult: down });
  await lookAgain(page);
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  await expect(face(page)).toHaveAttribute('data-face', 'calm');
  await expect(page.getByRole('status').filter({ hasText: OFFLINE })).toHaveCount(1);
  await setWorker(page, { petResult: undefined });
  await lookAgain(page);
  await expect(page.getByText(OFFLINE)).toHaveCount(0);
});

// spec: add-pet-life › Pet life display rule › гость × connection lost
test('гость × connection lost: a visitor\'s page gets the same line over the last known pet', async ({ page }) => {
  await openWith(page, '/pet/2', as('visitor', 'calm'));
  await expect(face(page)).toHaveAttribute('data-face', 'calm');
  await setWorker(page, { petResult: down });
  await lookAgain(page);
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
});

// spec: add-pet-life › Pet life display rule › гость × session ended
test('гость × session ended: the look stops, the page stands as it was', async ({ page }) => {
  await openWith(page, '/pet/2', as('guest', 'calm'));
  await expect(face(page)).toHaveAttribute('data-face', 'calm');
  const before = await looks(page);
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await expect.poll(() => looks(page)).toBeGreaterThan(before);
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await expect(face(page)).toHaveAttribute('data-face', 'calm');
  const after = await looks(page);
  await lookAgain(page);
  await page.waitForTimeout(600);
  expect(await looks(page)).toBe(after);
});

// spec: add-pet-life › Pet life display rule › гость
test('гость: a pet that became this player\'s own turns the page into the owner\'s, with its field', async ({ page }) => {
  await openWith(page, '/pet/2', as('guest', 'calm'));
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await expect(page.getByPlaceholder('Talk to Biscuit…')).toHaveCount(0);
  await setWorker(page, { owned: ['2'] });
  await lookAgain(page);
  await expect(page.getByPlaceholder('Talk to Biscuit…')).toBeVisible();
});
