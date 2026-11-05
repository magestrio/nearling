import { expect, test, type Page } from '@playwright/test';
import { calls, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';
import { SAMPLE_SHOWCASE } from '../src/seams/showcase.sample';

const ASLEEP = { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 } };
const PLAY = { pet: { hold: false } };

// software GL: one moving pet at a time, and a frame takes most of a second
test.describe.configure({ mode: 'serial' });

const frames = (page: Page) => page.evaluate(() => (globalThis as { __nearlingFrames?: number }).__nearlingFrames ?? 0);
const shot = (page: Page) => page.locator('[data-illustration] canvas').screenshot();

/** Frames drawn over this long. */
async function drawnOver(page: Page, ms: number): Promise<number> {
  const before = await frames(page);
  await page.waitForTimeout(ms);
  return (await frames(page)) - before;
}

/** The canvas comes to rest: frames in flight end (a capture's hook also asks for a few on a new page), then none. */
const comesToRest = (page: Page) => expect.poll(() => drawnOver(page, 1500), { timeout: 30_000 }).toBe(0);

async function ready(page: Page) {
  await expect(page.locator('[data-illustration]')).toHaveAttribute('data-view', '3d');
  await expect.poll(() => frames(page)).toBeGreaterThan(2);
}

// spec: add-pet › Pet motion rule › пауза
test('пауза: the pet moves — frames come and the picture changes — until «Pause motion», then it stands, here and after a reload', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER, ...PLAY });
  await ready(page);
  // while it plays, the canvas keeps being drawn with a pet that is not where it was
  expect(await drawnOver(page, 2500)).toBeGreaterThan(1);
  const a = await shot(page);
  await page.waitForTimeout(900);
  const b = await shot(page);
  expect(a.equals(b), 'the picture changes while the pet plays').toBe(false);

  await page.getByRole('button', { name: 'Pause motion' }).click();
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  await comesToRest(page);
  const c = await shot(page);
  await page.waitForTimeout(800);
  expect(c.equals(await shot(page)), 'the picture stands still on pause').toBe(true);

  // the browser remembers it, under the game's own key
  expect(await page.evaluate(() => [localStorage.getItem('nearling.motion'), localStorage.getItem('pet-motion')])).toEqual(['paused', null]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  await comesToRest(page);

  await page.getByRole('button', { name: 'Play motion' }).click();
  await expect(page.getByRole('button', { name: 'Pause motion' })).toBeVisible();
  expect(await drawnOver(page, 2500)).toBeGreaterThan(1);
});

// spec: add-pet › Pet motion rule › пауза
test('a visitor pauses a pet, finds the Home meadow paused, and plays it there for the next visit', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { showcase: SAMPLE_SHOWCASE }, ...PLAY });
  await expect(page.locator('[data-illustration]')).toHaveAttribute('data-view', '3d');
  await page.getByRole('button', { name: 'Pause motion' }).click();
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('nearling.motion'))).toBe('paused');

  await page.goto('/');
  const meadow = page.locator('.ds-meadow');
  await expect(meadow.locator('.ds-meadow__pet')).toHaveCount(10);
  await meadow.scrollIntoViewIfNeeded();
  await expect(meadow).toHaveClass(/ds-meadow--paused/);
  await expect(meadow.getByRole('button', { name: 'Play motion' })).toBeVisible();
  await comesToRest(page);
  await page.reload();
  await meadow.scrollIntoViewIfNeeded();
  await expect(meadow).toHaveClass(/ds-meadow--paused/);

  await meadow.getByRole('button', { name: 'Play motion' }).click();
  await expect(meadow).not.toHaveClass(/ds-meadow--paused/);
  // the ten pets share one canvas and a software-GL frame of it takes seconds
  await expect.poll(() => drawnOver(page, 6000), { timeout: 60_000 }).toBeGreaterThan(1);
  expect(await page.evaluate(() => localStorage.getItem('nearling.motion'))).toBe('playing');
  await page.goto('/pet/2');
  await expect(page.getByRole('button', { name: 'Pause motion' })).toBeVisible();
});

// spec: add-pet › Pet motion rule › система просит меньше движения
test('система просит меньше движения: the pet stands from the first show; «Play motion» starts it and is remembered', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER, ...PLAY });
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  await comesToRest(page);
  await page.getByRole('button', { name: 'Play motion' }).click();
  expect(await drawnOver(page, 2500)).toBeGreaterThan(1);
  expect(await page.evaluate(() => localStorage.getItem('nearling.motion'))).toBe('playing');
});

// spec: add-pet › Pet motion rule › пауза × вкладка скрыта
test('пауза × вкладка скрыта: a hidden tab asks for no frames, and the pet goes on when it is seen again', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER, ...PLAY });
  await ready(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await comesToRest(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await drawnOver(page, 2500)).toBeGreaterThan(1);
});

// spec: add-pet › Sleep and wake flow › разбудил друг при открытой странице
test('the moments of the built flows: thinking, talking, falling asleep, waking', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } }, ...PLAY });
  await ready(page);
  await page.getByPlaceholder('Talk to Pixel…').fill('hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Pixel, thinking' })).toBeVisible();

  await setWorker(page, { petState: { pending: false, thought: { id: 't1', text: 'Hi there!', cut: null } } });
  await lookAgain(page);
  await expect(page.getByRole('log')).toContainText('Hi there!');
  await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
  await expect.poll(async () => (await calls(page)).filter((c) => c === 'pet:talk').length).toBe(1);

  await setWorker(page, { pets: { '9': ASLEEP }, petState: {} });
  await lookAgain(page);
  await expect(page.getByRole('img', { name: 'Pixel, asleep' })).toBeVisible();

  // a meal: the boot log first, then its state
  await setWorker(page, { pets: { '9': PIXEL }, petState: {} });
  await lookAgain(page);
  await expect(page.getByRole('img', { name: 'Pixel, waking up' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
});

// spec: add-daily-ritual › Diary screen › success × the small pet stands still
test('the Diary\'s small pet stands still with no «Pause motion», in its state, while the choice stays «play»', async ({ page }) => {
  await openWith(page, '/pet/9/diary', { auth: SIGNED_IN, worker: { ...OWNER, diary: {} }, ...PLAY });
  const figure = page.locator('[data-illustration]');
  await expect(figure).toHaveAttribute('data-view', '3d');
  await expect(figure).toHaveAttribute('data-still', '');
  await expect(figure.locator('[data-motion]')).toHaveAttribute('data-motion', 'paused');
  await expect(page.getByRole('button', { name: 'Pause motion' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Play motion' })).toHaveCount(0);
  await comesToRest(page);
  expect(await page.evaluate(() => localStorage.getItem('nearling.motion'))).toBeNull();
});

// spec: add-pet › Birth flow › вылупился
test('вылупился: the newborn is born on its first show, once', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { ...OWNER, owned: ['9'] }, ...PLAY });
  await page.getByLabel('Name your pet').fill('Pixel');
  await page.getByRole('button', { name: 'Hatch my pet' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect.poll(async () => (await calls(page)).filter((c) => c === 'pet:birth').length).toBe(1);
  await page.reload();
  await ready(page);
  expect((await calls(page)).filter((c) => c === 'pet:birth')).toEqual([]);
});

// spec: add-pet › Pet motion rule › пауза × сон и пробуждение на паузе
test('пауза × сон и пробуждение на паузе: the new state shows without motion, the toggle stays «Play motion»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER, ...PLAY });
  const figure = page.locator('[data-illustration]');
  const motion = figure.locator('[data-motion]');
  await expect(figure).toHaveAttribute('data-view', '3d');
  await page.getByRole('button', { name: 'Pause motion' }).click();
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  await expect(motion).toHaveAttribute('data-motion', 'paused');
  await page.waitForTimeout(500);

  // the food ran out: the pet falls asleep on the open page — still, in its new state
  await setWorker(page, { pets: { '9': ASLEEP }, petState: { events: ['fell_asleep'] } });
  await lookAgain(page);
  await expect(page.getByRole('img', { name: 'Pixel, asleep' })).toBeVisible();
  await expect(page.getByText('Pixel fell asleep.')).toBeVisible();
  await expect(motion).toHaveAttribute('data-motion', 'paused');
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  // a cut: a frame for the change, and nothing that keeps moving
  await comesToRest(page);

  // a meal came: it wakes without motion: a cut to the boot log, a cut to its state
  await setWorker(page, { pets: { '9': PIXEL }, petState: {} });
  await lookAgain(page);
  await expect(page.getByRole('img', { name: 'Pixel, waking up' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
  await expect(motion).toHaveAttribute('data-motion', 'paused');
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  // the choice is the browser's: the tap that plays it again is remembered as ever
  await page.getByRole('button', { name: 'Play motion' }).click();
  await expect(motion).toHaveAttribute('data-motion', 'playing');
});
