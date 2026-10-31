import { expect, test, type Page } from '@playwright/test';
import type { PetBase, SheetPortion } from '../src/seams/worker-types';
import { BISCUIT, calls, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

// the date of a snack line is the player's local time: the zone is the test's
test.use({ timezoneId: 'UTC' });

const HUNGRY_PIXEL: PetBase = { ...PIXEL, fullness: { state: 'hungry', level: 0.25 } };
const ASLEEP_PIXEL: PetBase = { ...PIXEL, fullness: { state: 'asleep', level: 0 } };
const ownerWith = (pixel: PetBase = HUNGRY_PIXEL) => ({ ...OWNER, pets: { '9': pixel, '2': BISCUIT } });
const sheet = (page: Page, name = 'Feed Pixel') => page.getByRole('dialog', { name });

// spec: add-feeding › Feed sheet screen › success (владелец)
test('success (владелец): the three portions with their price and NEAR, the balance, «Ask friends to feed Pixel», no snack for an awake pet', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: ownerWith() });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  for (const [usd, near] of [['5¢', '0.01'], ['23¢', '0.05'], ['92¢', '0.2']]) {
    const row = dialog.getByRole('button', { name: new RegExp(`^Feed · ${usd}\\s*${near} NEAR$`) });
    await expect(row).toBeVisible();
    await expect(row).toBeEnabled();
  }
  await expect(dialog.getByText('You have 0.31 NEAR')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ask friends to feed Pixel' })).toBeVisible();
  // `Snack rule` › «питомец владельца не спит»: no snack, no line in its place
  await expect(dialog.getByRole('button', { name: /free snack/ })).toHaveCount(0);
  await expect(dialog.getByText(/snack/i)).toHaveCount(0);
  await expect(dialog.getByText('Add NEAR')).toHaveCount(0);
  // the opener shows the sheet
  await expect(page.getByRole('button', { name: 'Feed Pixel', expanded: true })).toHaveCount(1);
});

// spec: add-feeding › Feed sheet screen › success (владелец)
test('success (владелец): an asleep pet gets «Give a free snack» under the portions, and the field does not take the focus', async ({ page }) => {
  await openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: { ...ownerWith(ASLEEP_PIXEL), feedSheet: { fullness: { state: 'asleep', level: 0 }, snack: { state: 'ready' } } },
  });
  // asleep: «Feed Pixel» stands in «Send»'s place
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const dialog = sheet(page);
  await expect(dialog.getByRole('button', { name: 'Give a free snack' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ask friends to feed Pixel' })).toBeVisible();
  await expect(page.locator('.ds-composer__field')).not.toBeFocused();
});

// spec: add-feeding › Feed sheet screen › мало NEAR
test('мало NEAR: the rows that fit stay active, the short one is off with «Add {missing} NEAR to give this meal.» and «Add NEAR»', async ({ page }) => {
  const portions: SheetPortion[] = [
    { near: '0.01', yocto: '10000000000000000000000', cents: 5, missing: null },
    { near: '0.05', yocto: '50000000000000000000000', cents: 23, missing: null },
    { near: '0.2', yocto: '200000000000000000000000', cents: 92, missing: '0.13' },
  ];
  await openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: { ...ownerWith(), feedSheet: { portions, wallet: { state: 'some', balance: '80000000000000000000000' } } },
  });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const dialog = sheet(page);
  await expect(dialog.getByRole('button', { name: /^Feed · 5¢/ })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: /^Feed · 23¢/ })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: /^Feed · 92¢/ })).toBeDisabled();
  await expect(dialog.getByText('Add 0.13 NEAR to give this meal.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add NEAR' })).toBeVisible();
  await expect(dialog.getByText('You have 0.08 NEAR')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ask friends to feed Pixel' })).toBeVisible();
});

// spec: add-feeding › Feed sheet screen › success (владелец)
test('success (владелец): {balance} is rounded down, under 0.01 to three decimals', async ({ page }) => {
  const portions: SheetPortion[] = (['0.01', '0.05', '0.2'] as const).map((near, i) => ({ near, yocto: '1', cents: [5, 23, 92][i]!, missing: near }));
  await openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: { ...ownerWith(), feedSheet: { portions, wallet: { state: 'some', balance: '6000000000000000000000' } } },
  });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(sheet(page).getByText('You have 0.006 NEAR')).toBeVisible();
});

// spec: add-feeding › Own pet feeding flow › открыл кормление
test('открыл кормление: the owner\'s «Feed Pixel» opens the sheet of that pet in its state on the page of the tap', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: ownerWith() });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
});

// spec: add-feeding › Own pet feeding flow › открыл кормление
test('открыл кормление: on a friend\'s page the whole sheet names the pet «your Pixel», «Your Pixel» at the start of a sentence', async ({ page }) => {
  await openWith(page, '/pet/2', {
    auth: SIGNED_IN,
    worker: {
      owned: ['9'],
      pets: { '9': ASLEEP_PIXEL, '2': BISCUIT },
      feedSheet: { fullness: { state: 'asleep', level: 0 }, snack: { state: 'not_ready', at: '2026-11-12T21:40:00.000Z' } },
    },
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  // the hook stands for «Feed your {my_pet}» of `add-pet-work`, which is not built yet
  await page.evaluate(() => (globalThis as { __nearlingOpenFeed?: (r: unknown) => void }).__nearlingOpenFeed?.({ tokenId: '9', name: 'Pixel', label: 'your Pixel', elsewhere: true }));
  const dialog = sheet(page, 'Feed your Pixel');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ask friends to feed your Pixel' })).toBeVisible();
  await expect(dialog.getByText("Your Pixel's next free snack is ready Nov 12 at 9:40 PM. Until then, a meal or a friend can wake your Pixel up.")).toBeVisible();
  // the own pet is not on this page: its fullness stands in the sheet's head
  await expect(dialog.getByText('Asleep', { exact: true })).toBeVisible();
  // «Feed Biscuit» did not open it
  await expect(page.getByRole('button', { name: 'Feed Biscuit', expanded: true })).toHaveCount(0);
});

// spec: add-pet › Sleep and wake flow › разбудил друг при открытой странице
test('разбудил друг при открытой странице: the page sends the wakes it knows, and a later wake comes back with the friend\'s name', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...ASLEEP_PIXEL, owner: { wakes: 3 } }, '2': BISCUIT } } });
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await setWorker(page, {
    pets: { '9': { ...PIXEL, owner: { wakes: 4 } }, '2': BISCUIT },
    petState: { events: ['woke'], friend: 'A friend', wakes: 4 },
  });
  await lookAgain(page);
  await expect(page.getByText('A friend fed Pixel.')).toBeVisible();
  // the next look carries the number the last answer gave
  await lookAgain(page);
  await expect.poll(() => calls(page)).toEqual(expect.arrayContaining(['worker:petState:wakes:3', 'worker:petState:wakes:4']));
});

// spec: add-feeding › Own pet feeding flow › накормил бодрствующего
test('накормил бодрствующего: «Yum! Pixel is fuller now.» and «Done»; Done closes the sheet on the same page, the fullness is higher', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: ownerWith() });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const dialog = sheet(page);
  await expect(page.getByRole('img', { name: 'Pixel, hungry' })).toBeVisible();
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT } });
  await dialog.getByRole('button', { name: /^Feed · 5¢/ }).click();
  await expect(dialog.getByText('Yum! Pixel is fuller now.').last()).toBeVisible();
  // the sheet says it on its live region, and the focus stays on «Done» (DS › Sheet › After an outcome)
  await expect(dialog.getByRole('status').filter({ hasText: 'Yum! Pixel is fuller now.' })).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
  // no portions any more: the meal is over
  await expect(dialog.getByRole('button', { name: /^Feed · / })).toHaveCount(0);
  // the page learns of it at once, without waiting for its poll
  await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeFocused();
});

// spec: add-feeding › Own pet feeding flow › разбудил
test('разбудил: the sheet closes by itself, and Pixel wakes on the page', async ({ page }) => {
  await openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: { ...ownerWith(ASLEEP_PIXEL), feedSheet: { fullness: { state: 'asleep', level: 0 }, snack: { state: 'ready' } } },
  });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const dialog = sheet(page);
  await expect(page.getByRole('img', { name: 'Pixel, asleep' })).toBeVisible();
  const polls = async () => (await calls(page)).filter((c) => c === 'worker:petState').length;
  const before = await polls();
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT }, petState: { events: ['woke'] } });
  await dialog.getByRole('button', { name: /^Feed · 5¢/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/Yum!/)).toHaveCount(0);
  // the page reads the pet at once and shows it awake (the boot first)
  await expect.poll(polls).toBeGreaterThan(before);
  await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
  // the Dock's button changed under the focus: the focus comes back to the field, as `useWaking` says
  await expect(page.locator('.ds-composer__field')).toBeFocused();
});

// spec: add-feeding › Own pet feeding flow › открыл кормление
test('открыл кормление: on a friend\'s page «Feeding your Pixel…», «Yum! Your Pixel is fuller now.» and the failure name the pet «your Pixel»', async ({ page }) => {
  await page.clock.install();
  await openWith(page, '/pet/2', {
    auth: SIGNED_IN,
    worker: { owned: ['9'], pets: { '9': HUNGRY_PIXEL, '2': BISCUIT }, feedSendDelayMs: 3000, sendFeed: { status: 'failed', hatched: true } },
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Biscuit' })).toBeVisible();
  await page.evaluate(() => (globalThis as { __nearlingOpenFeed?: (r: unknown) => void }).__nearlingOpenFeed?.({ tokenId: '9', name: 'Pixel', label: 'your Pixel', elsewhere: true }));
  const dialog = sheet(page, 'Feed your Pixel');
  await dialog.getByRole('button', { name: /^Feed · 5¢/ }).click();
  await expect(dialog.getByRole('button', { name: 'Feeding your Pixel…' })).toBeVisible();
  await page.clock.fastForward(3500);
  await expect(dialog.locator('#feed-failed')).toHaveText("That meal didn't reach your Pixel, so its NEAR stays in your wallet. Try again.");
  await setWorker(page, { sendFeed: { status: 'ok', hatched: true }, feedSendDelayMs: 0 });
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByText('Yum! Your Pixel is fuller now.').last()).toBeVisible();
});

// spec: add-feeding › Own pet feeding flow › владелец вошёл после «Feed {name}»
test('владелец вошёл после «Feed {name}»: the sheet opens on his Pet screen in his own state, not the friend\'s', async ({ page }) => {
  await openWith(page, '/pet/9', { worker: ownerWith() });
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ask friends to feed Pixel' })).toBeVisible();
  await expect(dialog.getByText(/will learn your first name from Google/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
});

// A sheet opening or closing remounts nothing under it: a node keeps its mark only if it stays the same node
test.describe('the page under the sheet', () => {
  const PHONE = { width: 390, height: 844 };
  const DESKTOP = { width: 1440, height: 900 };
  const figure = (page: Page) => page.locator('[data-illustration]');
  const mark = (page: Page, selector: string) => page.locator(selector).evaluate((el) => el.setAttribute('data-kept', ''));
  /** The same canvas, and still the 3D pet once a lost canvas would have told the page so (R3F forces the loss after it unmounts). */
  const petStands = async (page: Page) => {
    await expect(page.locator('[data-illustration] canvas[data-kept]')).toHaveCount(1);
    await page.waitForTimeout(1000);
    await expect(figure(page)).toHaveAttribute('data-view', '3d');
  };
  const openClose = async (page: Page, opener: ReturnType<Page['getByRole']>) => {
    await opener.click();
    await expect(sheet(page)).toBeVisible();
    await petStands(page);
    await sheet(page).getByRole('button', { name: 'Close' }).click();
    await expect(sheet(page)).toHaveCount(0);
    await petStands(page);
  };

  // spec: add-feeding › Feed sheet screen › success (владелец) × Close
  test('success (владелец) × Close on the phone: the pet stays the 3D pet with «Pause motion», the focus back on «Feed Pixel»', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: ownerWith() });
    await expect(figure(page)).toHaveAttribute('data-view', '3d');
    await mark(page, '[data-illustration] canvas');
    const opener = page.getByRole('button', { name: 'Feed Pixel' });
    await openClose(page, opener);
    await expect(page.getByRole('button', { name: 'Pause motion' })).toBeVisible();
    await expect(opener).toBeFocused();
  });

  for (const [viewport, size] of [['phone', PHONE], ['desktop', DESKTOP]] as const) {
    // spec: add-feeding › Feed sheet screen › success (владелец) × Close
    test(`success (владелец) × Close, asleep · ${viewport}: «Feed Pixel» in the Dock is the same button and takes the focus back`, async ({ page }) => {
      await page.setViewportSize(size);
      await openWith(page, '/pet/9', {
        auth: SIGNED_IN,
        worker: { ...ownerWith(ASLEEP_PIXEL), feedSheet: { fullness: { state: 'asleep', level: 0 }, snack: { state: 'ready' } } },
      });
      await expect(figure(page)).toHaveAttribute('data-view', '3d');
      await mark(page, '[data-illustration] canvas');
      const opener = page.getByRole('button', { name: 'Feed Pixel' });
      await opener.evaluate((el) => el.setAttribute('data-kept', ''));
      await openClose(page, opener);
      await expect(page.locator('button[data-kept]')).toHaveCount(1);
      await expect(opener).toBeFocused();
    });

    // spec: add-feeding › Feed sheet screen › success (владелец) × Close
    test(`success (владелец) × Close · ${viewport}: a player who scrolled up finds the conversation where it was`, async ({ page }) => {
      await page.setViewportSize(size);
      const lines = Array.from({ length: 16 }, (_, i) => ({ id: `c${i}${i % 2 ? ':you' : ''}`, who: (i % 2 ? 'player' : 'pet') as 'player' | 'pet', text: `Line ${i} of a long talk about the fridge, the chart and the slide nobody understands.`, at: i + 1 }));
      await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...ownerWith(), conversation: { lines, more: false, before: null } } });
      const log = page.getByRole('log');
      await expect(log).toContainText('Line 15');
      await mark(page, '[role="log"]');
      await log.evaluate((el) => {
        el.scrollTop = 40;
      });
      await page.getByRole('button', { name: 'Feed Pixel' }).click();
      await expect(sheet(page)).toBeVisible();
      await sheet(page).getByRole('button', { name: 'Close' }).click();
      await expect(sheet(page)).toHaveCount(0);
      await expect(page.locator('[role="log"][data-kept]')).toHaveCount(1);
      expect(await log.evaluate((el) => el.scrollTop)).toBe(40);
    });
  }
});

// The pet moves in software GL: one moving pet at a time, and a frame takes most of a second
test.describe('the moment', () => {
  test.describe.configure({ mode: 'serial' });
  const frames = (page: Page) => page.evaluate(() => (globalThis as { __nearlingFrames?: number }).__nearlingFrames ?? 0);
  const drawnOver = async (page: Page, ms: number) => {
    const before = await frames(page);
    await page.waitForTimeout(ms);
    return (await frames(page)) - before;
  };
  const MOVING = { pet: { hold: false } };

  // spec: add-feeding › Own pet feeding flow › накормил бодрствующего
  test('hungry becomes full at the outcome on the page that stands: the state reaches the figure, which plays on', async ({ page }) => {
    await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: ownerWith(), ...MOVING });
    await expect(page.locator('[data-illustration]')).toHaveAttribute('data-view', '3d');
    await expect(page.getByRole('img', { name: 'Pixel, hungry' })).toBeVisible();
    await page.getByRole('button', { name: 'Feed Pixel' }).click();
    await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT } });
    const atTap = await frames(page);
    await sheet(page).getByRole('button', { name: /^Feed · 5¢/ }).click();
    await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
    await expect(page.locator('[data-illustration] [data-motion]')).toHaveAttribute('data-motion', 'playing');
    // the perk-up and the hop are frames drawn after the state changed
    await expect.poll(async () => (await frames(page)) - atTap, { timeout: 20_000 }).toBeGreaterThan(1);
  });

  // spec: add-feeding › Own pet feeding flow › накормил бодрствующего
  test('a friend\'s page: the same change reaches the guest\'s figure with no poll of its own', async ({ page }) => {
    await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { pets: { '9': PIXEL, '2': { ...BISCUIT, fullness: { state: 'hungry', level: 0.25 } } } }, ...MOVING });
    await expect(page.locator('[data-illustration]')).toHaveAttribute('data-view', '3d');
    await page.getByRole('button', { name: 'Feed Biscuit' }).click();
    await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT } });
    const atTap = await frames(page);
    await sheet(page, 'Feed Biscuit').getByRole('button', { name: /^Feed · 5¢/ }).click();
    await expect(page.getByRole('img', { name: 'Biscuit, full' })).toBeVisible();
    await expect.poll(async () => (await frames(page)) - atTap, { timeout: 20_000 }).toBeGreaterThan(1);
  });

  // spec: add-feeding › Own pet feeding flow › накормил бодрствующего
  test('reduced motion cuts: the new state shows with nothing that keeps moving', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: ownerWith(), ...MOVING });
    const motion = page.locator('[data-illustration] [data-motion]');
    await expect(motion).toHaveAttribute('data-motion', 'paused');
    await page.getByRole('button', { name: 'Feed Pixel' }).click();
    await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT } });
    await sheet(page).getByRole('button', { name: /^Feed · 5¢/ }).click();
    await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
    await expect(motion).toHaveAttribute('data-motion', 'paused');
    // a frame for the change, then none
    await expect.poll(() => drawnOver(page, 1500), { timeout: 30_000 }).toBe(0);
  });
});
