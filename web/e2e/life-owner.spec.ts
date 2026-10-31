import { expect, test, type Page } from '@playwright/test';
import { BISCUIT, calls, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const MIDNIGHT = '2026-11-02T00:00:00.000Z';
const OUT_LINE = /^Pixel worked hard today and is out of energy for big thoughts until \d\d:\d\d\. Chatting still works\.$/;
const HUNGRY_LINE = 'Pixel is too hungry to think hard right now.';
const TIRED_LINE = /^Pixel is tired for today\. Back at \d\d:\d\d\.$/;
const SLEEP_LINE = 'Pixel is asleep. A meal will wake Pixel up.';
const PAUSED_LINE = 'Chatting is paused on our side while we top up. Your message is kept — Pixel will be back soon.';

/** Pixel as its owner sees it, with the day's energy and what else the test lays over it */
const withPixel = (owner: Record<string, unknown>, pixel: Record<string, unknown> = {}) => ({
  ...OWNER,
  pets: { '9': { ...PIXEL, ...pixel, owner: { ownedCount: 1, ...owner } }, '2': BISCUIT },
});
const OUT = { energy: 0, until: MIDNIGHT };

const field = (page: Page) => page.getByPlaceholder('Talk to Pixel…');
const think = (page: Page) => page.getByRole('button', { name: /Think hard/ });
const send = (page: Page) => page.getByRole('button', { name: 'Send' });
const meter = (page: Page) => page.getByRole('meter', { name: 'Energy' });
const seen = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true });
const said = async (page: Page, call: string) => (await calls(page)).filter((c) => c === call).length;
const face = (page: Page) => page.locator('.ds-pet').first();

// spec: add-pet-life › Energy rule › энергия на нуле
test('энергия на нуле: «Think hard» is off with the energy\'s words; nothing is sent when it is tapped', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel(OUT) });
  await expect(seen(page, OUT_LINE).first()).toBeVisible();
  await expect(think(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '0');
  await field(page).fill('Tell me a story');
  // Playwright will not click an aria-disabled button: force the tap a finger would make
  await think(page).click({ force: true });
  expect(await said(page, 'worker:say:deep')).toBe(0);
  await expect(field(page)).toHaveValue('Tell me a story');
});

// spec: add-pet-life › Energy rule › энергия на нуле × Send
test('энергия на нуле × Send: chatting works, the energy stays at zero', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel(OUT) });
  await expect(seen(page, OUT_LINE).first()).toBeVisible();
  await expect(send(page)).not.toHaveAttribute('aria-disabled', 'true');
  await field(page).fill('Good morning');
  await send(page).click();
  await expect(page.getByRole('log')).toContainText('Good morning');
  expect(await said(page, 'worker:say:chat')).toBe(1);
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '0');
});

// spec: add-pet-life › Energy rule › энергия на нуле × Feed
test('энергия на нуле × Feed: «Feed Pixel» opens the sheet; the energy stays at zero', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel(OUT) });
  await expect(seen(page, OUT_LINE).first()).toBeVisible();
  await page.getByRole('button', { name: 'Feed Pixel' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Feed Pixel' })).toBeVisible();
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '0');
});

// spec: add-pet-life › Energy rule › энергия на нуле × hungry
test('энергия на нуле × hungry: «Think hard» shows the energy\'s words, not the hunger\'s', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel(OUT, { fullness: { state: 'hungry', level: 0.25 } }) });
  await expect(seen(page, OUT_LINE).first()).toBeVisible();
  await expect(page.getByText(HUNGRY_LINE)).toHaveCount(0);
  await expect(think(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(send(page)).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-life › Energy rule › энергия на нуле × asleep
test('энергия на нуле × asleep: the sleep line and «Feed Pixel»; the meter stands at zero', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel(OUT, { fullness: { state: 'asleep', level: 0 } }) });
  await expect(seen(page, SLEEP_LINE).first()).toBeVisible();
  await expect(page.getByText(OUT_LINE)).toHaveCount(0);
  await expect(field(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Feed Pixel' }).first()).toBeVisible();
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '0');
});

// spec: add-pet-life › Energy rule › энергия на нуле × tired
test('энергия на нуле × tired: the tired line, not the energy\'s; the meter stands at zero', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel({ ...OUT, tired: true }) });
  await expect(seen(page, TIRED_LINE).first()).toBeVisible();
  await expect(page.getByText(OUT_LINE)).toHaveCount(0);
  await expect(field(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(think(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '0');
});

// spec: add-pet-life › Energy rule › энергия на нуле × chatting paused
test('энергия на нуле × chatting paused: the pause\'s Banner stands over the energy\'s line', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel({ ...OUT, paused: true }) });
  await expect(page.getByText(PAUSED_LINE).first()).toBeVisible();
  await expect(seen(page, OUT_LINE).first()).toBeVisible();
  await expect(field(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(think(page)).toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-life › Energy rule › энергия на нуле × an open page, a step spent
test('энергия на нуле × an open page, a step spent: the meter follows the look; the last step turns «Think hard» off', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel({ energy: 2 }) });
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '2');
  await expect(think(page)).not.toHaveAttribute('aria-disabled', 'true');
  await setWorker(page, withPixel({ energy: 1 }));
  await lookAgain(page);
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '1');
  await expect(think(page)).not.toHaveAttribute('aria-disabled', 'true');
  await setWorker(page, withPixel(OUT));
  await lookAgain(page);
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '0');
  await expect(seen(page, OUT_LINE).first()).toBeVisible();
  await expect(think(page)).toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-life › Energy rule › энергия на нуле × 00:00 UTC
test('энергия на нуле × 00:00 UTC: the energy is full with no reload — the line goes, «Think hard» works', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel(OUT) });
  await expect(seen(page, OUT_LINE).first()).toBeVisible();
  await setWorker(page, withPixel({ energy: 10 }));
  await lookAgain(page);
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '10');
  await expect(page.getByText(OUT_LINE)).toHaveCount(0);
  await expect(think(page)).not.toHaveAttribute('aria-disabled', 'true');
  await field(page).fill('A big one');
  await think(page).click();
  expect(await said(page, 'worker:say:deep')).toBe(1);
});

// spec: add-pet-life › Energy rule › энергия на нуле × a stale page taps Think hard
test('энергия на нуле × a stale page taps Think hard: the line goes back to the field, the energy\'s words stand, nothing is spent', async ({
  page,
}) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel({ energy: 3 }) });
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '3');
  await field(page).fill('Tell me a story');
  await think(page).click();
  expect(await said(page, 'worker:say:deep')).toBe(1);
  // the server spent the last steps on another tab: the job is refused with `no_energy`
  await setWorker(page, { ...withPixel(OUT), petState: { code: 'no_energy' } });
  await lookAgain(page);
  await expect(field(page)).toHaveValue('Tell me a story');
  await expect(seen(page, OUT_LINE).first()).toBeVisible();
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByRole('log')).not.toContainText('Tell me a story');
  await expect(page.getByText('lost that thought')).toHaveCount(0);
  await expect(think(page)).toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-life › Pet life display rule › владелец
test('владелец: a grown-up shows its stage word, its two traits and the «Energy» meter', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel({ traits: ['clever', 'sociable'], energy: 7 }) });
  await expect(seen(page, 'Grown-up').first()).toBeVisible();
  await expect(seen(page, 'clever').first()).toBeVisible();
  await expect(seen(page, 'sociable').first()).toBeVisible();
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '7');
  await expect(page.getByText('gets a trait when it grows up.')).toHaveCount(0);
});

// spec: add-pet-life › Pet life display rule › владелец
test('владелец: a baby shows «Baby» and its line in the traits\' place; a teen shows «Teen» and its trait', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel({ traits: [], energy: 10 }, { stage: 'baby' }) });
  await expect(seen(page, 'Baby').first()).toBeVisible();
  await expect(seen(page, 'Pixel gets a trait when it grows up.').first()).toBeVisible();
  await expect(page.getByText('Grown-up')).toHaveCount(0);
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '10');
  // it grew while the page was open: the next look brings the stage and the trait, and the baby's line goes
  await setWorker(page, withPixel({ traits: ['cozy'], energy: 9 }, { stage: 'teen' }));
  await lookAgain(page);
  await expect(seen(page, 'Teen').first()).toBeVisible();
  await expect(seen(page, 'cozy').first()).toBeVisible();
  await expect(page.getByText('gets a trait when it grows up.')).toHaveCount(0);
  await expect(page.getByText('Baby', { exact: true })).toHaveCount(0);
});

// spec: add-pet-life › Trait rule › черта уже есть × the owner's screen
test('черта уже есть × the owner\'s screen: a trait held twice is named once', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel({ traits: ['clever', 'clever'] }) });
  await expect(seen(page, 'Grown-up').first()).toBeVisible();
  await expect(page.getByText('clever', { exact: true }).filter({ visible: true })).toHaveCount(1);
});

// spec: add-pet-life › Mood rule › новые сутки × the owner's page
test('новые сутки × the owner\'s page: 00:00 UTC turns the happy face calm with no reload', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withPixel({}, { mood: 'happy' }) });
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(face(page)).not.toHaveAttribute('data-face', /.*/);
  await setWorker(page, withPixel({}, { mood: 'calm' }));
  await lookAgain(page);
  await expect(face(page)).toHaveAttribute('data-face', 'calm');
});
