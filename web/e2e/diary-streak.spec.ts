import { expect, test, type Page } from '@playwright/test';
import { drawn, openDiary, setWorker } from './helpers';

const cells = (page: Page) => page.locator('.ds-streak__cell');
const kinds = async (page: Page) => (await cells(page).evaluateAll((els) => els.map((el) => /ds-streak__cell--(\w+)/.exec(el.className)?.[1] ?? ''))) as string[];

const SAVED = { days: 2, freezes: 0, done: false, line: 'frozen', n: 2, k: 0, missed: 1, note: ['forecast'] };
const RESET = { days: 0, freezes: 0, done: false, line: 'fresh', n: 2, k: 0, missed: 2, note: ['forecast'] };
const FROZEN_LINE = 'A streak freeze kept your 2-day streak safe. Freezes left: 0.';
const FRESH_LINE = 'A fresh streak starts today! Your last one ran 2 days.';
const FORECAST = "Saved once today's ritual is done.";

/** «Back to Pixel» and Account work, and the riddle's field takes text, as in success */
async function controlsWork(page: Page) {
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toHaveAttribute('href', '/pet/9');
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByLabel("What has hands but can't clap?").fill('a clock');
  await expect(page.getByRole('button', { name: 'Send answer' })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Answer Pixel' })).toBeVisible();
}

// spec: add-daily-ritual › Streak rule › заработал заморозку × the line
test('заработал заморозку: «{n} days in a row! You earned a streak freeze — it covers a day you miss.» and the freezes grown', async ({ page }) => {
  await openDiary(page, { streak: { days: 7, freezes: 2, done: false, line: 'earned', n: 7, k: 2, missed: 0, note: [] } });
  await expect(page.getByText('7 days in a row! You earned a streak freeze — it covers a day you miss.')).toBeVisible();
  await expect(page.getByText('Streak: 7 days · Freezes: 2')).toBeVisible();
});

// spec: add-daily-ritual › Streak rule › заморозка спасла серию × controls
// spec: add-daily-ritual › Streak rule › заморозка спасла серию × the spec's words on screen
test('заморозка спасла серию: the spec\'s words, the forecast note, the covered day dashed beside today', async ({ page }) => {
  await openDiary(page, { streak: SAVED });
  await expect(page.getByText(FROZEN_LINE)).toBeVisible();
  await expect(page.getByText(FORECAST)).toBeVisible();
  await expect(page.getByText('Streak: 2 days · Freezes: 0')).toBeVisible();
  expect(await kinds(page)).toEqual(['none', 'none', 'none', 'lit', 'lit', 'frozen', 'today']);
  await controlsWork(page);
});

// spec: add-daily-ritual › Streak rule › серия началась заново
// spec: add-daily-ritual › Streak rule › серия началась заново × controls
test('серия началась заново: the fresh start with no reproach, «Streak: 0 days · Freezes: 0», today alone in the strip', async ({ page }) => {
  await openDiary(page, { streak: RESET });
  await expect(page.getByText(FRESH_LINE)).toBeVisible();
  await expect(page.getByText(FORECAST)).toBeVisible();
  await expect(page.getByText('Streak: 0 days · Freezes: 0')).toBeVisible();
  expect(await kinds(page)).toEqual(['none', 'none', 'none', 'none', 'none', 'none', 'today']);
  await controlsWork(page);
});

// spec: add-daily-ritual › Streak rule › заморозка спасла серию × a gifted pet on screen
test('a gifted pet: the forecast number and its note, and no line about a miss', async ({ page }) => {
  await openDiary(page, { streak: { ...SAVED, line: null } });
  await expect(page.getByText('Streak: 2 days · Freezes: 0')).toBeVisible();
  await expect(page.getByText(FORECAST)).toBeVisible();
  await expect(page.getByText('A streak freeze kept', { exact: false })).toHaveCount(0);
  await expect(page.getByText('A fresh streak starts', { exact: false })).toHaveCount(0);
});

// spec: add-daily-ritual › Streak rule › серия началась заново × «ran 1 day»
// spec: add-daily-ritual › Streak rule › заморозка спасла серию × «Streak: 1 day»
test('singular at 1: «Streak: 1 day» and «ran 1 day»', async ({ page }) => {
  await openDiary(page, { streak: { ...RESET, n: 1, days: 1, freezes: 0 } });
  await expect(page.getByText('Streak: 1 day · Freezes: 0')).toBeVisible();
  await expect(page.getByText('A fresh streak starts today! Your last one ran 1 day.')).toBeVisible();
});

// spec: add-daily-ritual › Streak rule › серия записана позже × the new number with no reload
test('серия записана позже: «Saving your streak…» with the recorded number, then the new number on the open screen', async ({ page }) => {
  await openDiary(page, { streak: { days: 2, freezes: 1, done: true, line: null, n: 2, k: 1, missed: 0, note: ['saving'] }, parts: [], complete: true });
  await expect(page.getByText('Saving your streak…')).toBeVisible();
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  expect(await kinds(page)).toEqual(['none', 'none', 'none', 'none', 'lit', 'lit', 'today']);
  await setWorker(page, { diary: { streak: { days: 3, freezes: 1, done: true, line: null, n: 3, k: 1, missed: 0, note: [] }, parts: [], complete: true } });
  await page.clock.fastForward(5_100);
  await expect(drawn(page, 'Streak: 3 days · Freezes: 1')).toBeVisible();
  await expect(page.getByText('Saving your streak…')).toHaveCount(0);
  expect(await kinds(page)).toEqual(['none', 'none', 'none', 'none', 'lit', 'lit', 'lit']);
});

// spec: add-daily-ritual › Streak rule › день не записан × the line
test('день не записан: «We couldn\'t save that day on our side.» in place of «Saving your streak…», the number stays', async ({ page }) => {
  await openDiary(page, { streak: { days: 2, freezes: 1, done: true, line: null, n: 2, k: 1, missed: 0, note: ['lost'] }, parts: [], complete: true });
  await expect(page.getByText("We couldn't save that day on our side.")).toBeVisible();
  await expect(page.getByText('Saving your streak…')).toHaveCount(0);
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
});
