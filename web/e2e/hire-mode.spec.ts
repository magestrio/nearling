import { expect, test, type Page } from '@playwright/test';
import type { FakeWorkerState } from '../src/seams/fakes';
import { ASLEEP_PIXEL, BISCUIT, calls, inCard, openCard, openWith, OWNER, setWorker, SIGNED_IN } from './helpers';

// the switch stands in the Work section of the pet's card (add-game-layout › Pet card screen › success (Work))
const openOwner = async (page: Page, worker: FakeWorkerState = OWNER) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker });
  await openCard(page);
};

const AUTO = 'Hiring: Auto — Pixel asks pets it knows when they can help, then tells you what it cost.';
const MANUAL = 'Hiring: Ask me first — Pixel checks with you before paying another pet.';
const group = (page: Page) => page.getByRole('radiogroup', { name: 'Hiring' });
const option = (page: Page, name: string) => group(page).getByRole('radio', { name });
// the phone's card and the desktop's row both stand in the page; the one the viewport shows is the one the player reads
const line = (page: Page, text: string) => page.getByText(text, { exact: true }).filter({ visible: true });

// spec: add-pet-work › Hire mode rule › Auto
test('Auto: an awake owner sees «Auto» chosen and the line of the mode, a new pet reads Auto', async ({ page }) => {
  await openOwner(page);
  await expect(group(page)).toBeVisible();
  await expect(option(page, 'Auto')).toBeChecked();
  await expect(option(page, 'Ask me first')).not.toBeChecked();
  await expect(line(page, AUTO)).toBeVisible();
});

// spec: add-pet-work › Hire mode rule › Ask me first
test('Ask me first: the switch changes the mode at once, the line follows, the server is told once', async ({ page }) => {
  await openOwner(page);
  await option(page, 'Ask me first').click();
  await expect(option(page, 'Ask me first')).toBeChecked();
  await expect(line(page, MANUAL)).toBeVisible();
  await expect(line(page, AUTO)).toHaveCount(0);
  expect((await calls(page)).filter((c) => /^worker:setHireMode:/.test(c))).toEqual(['worker:setHireMode:manual']);
});

// spec: add-pet-work › Hire mode rule › Auto
test('Auto: switching back says the line of Auto again; the arrow keys move and pick as a radio group', async ({ page }) => {
  await openOwner(page, { ...OWNER, pets: { '9': { ...OWNER.pets['9'], owner: { hireMode: 'manual' as const } }, '2': BISCUIT } });
  await expect(option(page, 'Ask me first')).toBeChecked();
  await expect(line(page, MANUAL)).toBeVisible();
  await option(page, 'Ask me first').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(option(page, 'Auto')).toBeChecked();
  await expect(option(page, 'Auto')).toBeFocused();
  await expect(line(page, AUTO)).toBeVisible();
  expect((await calls(page)).filter((c) => /^worker:setHireMode:/.test(c))).toEqual(['worker:setHireMode:auto']);
});

// spec: add-pet-work › Hire mode rule › Ask me first
test('Ask me first: a switch the server refused goes back to the mode it was, and the connection line says so', async ({ page }) => {
  await openOwner(page, { ...OWNER, setHireMode: { fail: { status: 503, code: 'chain_unreachable' } } });
  await option(page, 'Ask me first').click();
  await expect(option(page, 'Auto')).toBeChecked();
  await expect(line(page, AUTO)).toBeVisible();
  await expect(page.getByText("Can't reach Pixel right now. Nothing's lost — try again in a moment.").first()).toBeVisible();
});

// spec: add-pet-work › Hire mode rule › Auto × asleep
test('Auto × asleep: an asleep pet has no switch, and it is back once a meal woke the pet', async ({ page }) => {
  await openOwner(page, { ...OWNER, pets: { '9': ASLEEP_PIXEL, '2': BISCUIT } });
  await expect(inCard(page).getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(group(page)).toHaveCount(0);
  await expect(page.getByText(AUTO)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await setWorker(page, { pets: { '9': { ...ASLEEP_PIXEL, fullness: { state: 'full' as const, level: 1 } }, '2': BISCUIT } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await openCard(page);
  await expect(group(page)).toBeVisible();
});
