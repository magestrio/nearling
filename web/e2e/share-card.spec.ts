import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { calls, lookAgain, openPet, openWith, OWNER, PIXEL, SIGNED_IN, setWorker } from './helpers';

const menu = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Share Pixel' });
// The sheet also announces its status line in a visually hidden live region: match the shown copy only.
const shown = (scope: import('@playwright/test').Locator | import('@playwright/test').Page, text: string) =>
  scope.getByText(text).and(scope.locator(':not(.ds-hidden)'));
const choose = async (page: import('@playwright/test').Page, kind: 'a thought' | 'growth' | 'outfit') => {
  await menu(page).click();
  await page.getByRole('menuitem', { name: `Share ${kind}` }).click();
};

test.describe('owner pet cards', () => {
  // spec: add-showcase › Pet card source data › owner selects a retained line
  test('offers newest eligible card lines without paging the conversation', async ({ page }) => {
    await openPet(page, {}, { cardLines: { lines: [
      { id: 'new', text: 'Newest retained pet line.' },
      { id: 'old', text: 'Older retained pet line.' },
    ] } });
    // The Pet screen reads its own conversation on arrival: count after that read, so only the card's paging could add one.
    await expect.poll(async () => (await calls(page)).filter((call) => call === 'worker:conversation').length).toBeGreaterThan(0);
    const before = (await calls(page)).filter((call) => call === 'worker:conversation').length;
    await choose(page, 'a thought');
    const sheet = page.getByRole('dialog', { name: 'Share a thought' });
    await expect(sheet.getByRole('radio')).toHaveCount(2);
    await expect(sheet.getByRole('radio').first()).toBeChecked();
    await expect(sheet.locator('.showcase-card-preview')).toHaveAttribute('alt', /Newest retained pet line/);
    expect((await calls(page)).filter((call) => call === 'worker:conversation')).toHaveLength(before);
  });

  // spec: add-showcase › Pet card sharing flow › choose a thought
  test('moves keyboard focus from a selected thought to the surviving save action', async ({ page }) => {
    await openPet(page);
    await choose(page, 'a thought');
    const sheet = page.getByRole('dialog', { name: 'Share a thought' });
    await sheet.getByRole('radio').last().focus();
    await sheet.getByRole('radio').last().press('Space');
    await expect(sheet.getByRole('button', { name: 'Save image' })).toBeFocused();
  });

  // spec: add-showcase › Pet card sharing flow › choose a thought
  // spec: add-showcase › Pet card sharing flow › choose growth
  // spec: add-showcase › Pet card sharing flow › choose outfit
  test('offers retained words, reached growth and the worn outfit without spending food', async ({ page }) => {
    await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, stage: 'adult', worn: 'thinking-cap', owner: { ownedCount: 1 } }, '2': OWNER.pets['2']! } } });
    await choose(page, 'a thought');
    const sheet = page.getByRole('dialog', { name: 'Share a thought' });
    await expect(sheet.locator('.showcase-card-preview')).toHaveAttribute('alt', /Start with the chart, then.*127\.0\.0\.1.*\/pet\/9/);
    await sheet.getByRole('radio').nth(0).waitFor();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await choose(page, 'growth');
    await expect(page.getByRole('dialog', { name: 'Share growth' }).locator('.showcase-card-preview')).toHaveAttribute('alt', /Grown-up.*\/pet\/9/);
    await page.getByRole('dialog', { name: 'Share growth' }).getByRole('button', { name: 'Close' }).click();
    await choose(page, 'outfit');
    await expect(page.getByRole('dialog', { name: 'Share outfit' }).locator('.showcase-card-preview')).toHaveAttribute('alt', /Thinking cap.*\/pet\/9/);
    expect((await calls(page)).filter((call) => /worker:(say|think|feed|snack)/.test(call))).toEqual([]);
  });

  // spec: add-showcase › Pet card sharing flow › no thought to choose
  // spec: add-showcase › Pet card sharing flow › growth not reached
  // spec: add-showcase › Pet card sharing flow › no outfit worn
  test('names each unavailable card without opening an empty preview', async ({ page }) => {
    await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, conversation: { lines: [], more: false, before: null }, pets: { '9': { ...PIXEL, stage: 'baby', worn: null }, '2': OWNER.pets['2']! } } });
    await choose(page, 'a thought');
    await expect(page.getByText('No thoughts to share yet. Talk with Pixel to hear one.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await menu(page).click();
    await choose(page, 'growth');
    await expect(page.getByText("Pixel hasn't reached a new stage yet.")).toBeVisible();
    await menu(page).click();
    await choose(page, 'outfit');
    await expect(page.getByText("Pixel isn't wearing an outfit to share.")).toBeVisible();
  });

  // spec: add-showcase › Card eligibility rule › pet asleep
  test('keeps an eligible card available while asleep', async ({ page }) => {
    await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, worn: 'thinking-cap', fullness: { state: 'asleep', level: 0 }, owner: { ownedCount: 1 } }, '2': OWNER.pets['2']! } } });
    await choose(page, 'a thought');
    const sheet = page.getByRole('dialog', { name: 'Share a thought' });
    await expect(sheet.locator('.showcase-card-preview')).toBeVisible();
    await expect(sheet.getByText('Pixel is asleep.', { exact: false })).toHaveCount(0);
    await expect(shown(page, 'Pixel is asleep. A meal can wake Pixel.')).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(shown(page, 'Pixel is asleep. A meal will wake Pixel up.')).toBeVisible();
  });

  // spec: add-showcase › Pet card sharing flow › choose a thought × reload
  // spec: add-showcase › Card eligibility rule › memory cleared
  test('drops the tab draft on reload and removes a thought erased before preview', async ({ page }) => {
    await openPet(page);
    await choose(page, 'a thought');
    await expect(page.getByRole('dialog', { name: 'Share a thought' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Share a thought' })).toHaveCount(0);
    await setWorker(page, { cardSourceOnce: { fail: { status: 409, code: 'thought_erased' } } });
    await choose(page, 'a thought');
    await expect(shown(page, 'That thought is no longer here. Choose another one.')).toBeVisible();
    const sheet = page.getByRole('dialog', { name: 'Share a thought' });
    await expect(sheet.locator('.showcase-card-preview')).toHaveAttribute('alt', /Morning! I spent the night/);
    await expect(sheet.locator('.showcase-card-preview')).not.toHaveAttribute('alt', /Start with the chart/);
    await expect(sheet.getByRole('radio')).toHaveCount(1);
    await expect(sheet.getByRole('button', { name: 'Save image' })).toBeVisible();
  });

  // spec: add-showcase › Pet share card screen › error
  test('keeps the selection when the browser cannot draw', async ({ page }) => {
    await openPet(page);
    await page.evaluate(() => { const get = HTMLCanvasElement.prototype.getContext; (globalThis as { __cardContext?: typeof get }).__cardContext = get; HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement & { __showcaseCard?: boolean }, kind: string, ...args: unknown[]) { return kind === '2d' && this.__showcaseCard ? null : (get as (...values: unknown[]) => unknown).call(this, kind, ...args); } as typeof get; });
    await choose(page, 'a thought');
    const sheet = page.getByRole('dialog', { name: 'Share a thought' });
    await expect(shown(sheet, "We couldn't make this card. Try again.")).toBeVisible();
    await expect(sheet.getByRole('radio').first()).toBeChecked();
    await sheet.getByRole('button', { name: 'Try again' }).click();
    await expect(shown(sheet, "We couldn't make this card. Try again.")).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Try again' })).toBeFocused();
    await page.evaluate(() => { HTMLCanvasElement.prototype.getContext = (globalThis as { __cardContext?: typeof HTMLCanvasElement.prototype.getContext }).__cardContext!; });
    await sheet.getByRole('button', { name: 'Try again' }).click();
    await expect(sheet.getByRole('button', { name: 'Save image' })).toBeFocused();
  });

  // spec: add-showcase › Pet card sharing flow › choose a thought × gift
  test('closes an old owner preview when the pet is given away', async ({ page }) => {
    await openPet(page);
    await choose(page, 'a thought');
    await setWorker(page, { owned: [], pets: { '9': PIXEL, '2': OWNER.pets['2']! } });
    await lookAgain(page);
    await expect(page.getByRole('dialog', { name: 'Share a thought' })).toHaveCount(0);
  });

  // spec: add-showcase › Pet card sharing flow › save image
  // spec: add-showcase › Pet card sharing event data › image saved
  test('saves the preview once and records a completed save', async ({ page }) => {
    await openPet(page);
    await choose(page, 'a thought');
    const sheet = page.getByRole('dialog', { name: 'Share a thought' });
    const preview = await sheet.locator('.showcase-card-preview').evaluate(async (image: HTMLImageElement) => Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer())));
    const download = page.waitForEvent('download');
    await sheet.getByRole('button', { name: 'Save image' }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('Pixel-card.png');
    expect(Array.from(await readFile(await saved.path()))).toEqual(preview);
    await expect.poll(async () => (await calls(page)).filter((call) => call === 'worker:cardShared').length).toBe(1);
  });

  // spec: add-showcase › Pet card sharing flow › save image
  test('ignores a repeated save tap while the source check is pending', async ({ page }) => {
    await openPet(page);
    const sources = async () => (await calls(page)).filter((call) => call === 'worker:cardSource').length;
    const asked = await sources();
    await choose(page, 'a thought');
    // the card's own read and the ready image's source check come first; count the taps after them
    await expect.poll(sources).toBe(asked + 2);
    const before = asked + 2;
    await expect(page.getByRole('dialog', { name: 'Share a thought' }).getByRole('button', { name: 'Save image' })).toBeVisible();
    await setWorker(page, { delayMs: 1000 });
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent?.includes('Save image'));
      button?.click();
      button?.click();
    });
    await expect.poll(async () => (await calls(page)).filter((call) => call === 'worker:cardSource').length).toBe(before + 1);
  });

  // spec: add-showcase › Pet card sharing flow › share unavailable
  test('leaves Save available when the browser cannot share images', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
    });
    await openPet(page);
    await choose(page, 'a thought');
    const sheet = page.getByRole('dialog', { name: 'Share a thought' });
    await expect(sheet.getByRole('button', { name: 'Save image' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  });

  // spec: add-showcase › Card eligibility rule › memory cleared
  // spec: add-showcase › Pet card sharing flow › share image
  test('invalidates Share while the ready source is checked again', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
      Object.defineProperty(navigator, 'share', { value: async () => undefined, configurable: true });
    });
    await openPet(page);
    await choose(page, 'a thought');
    const sheet = page.getByRole('dialog', { name: 'Share a thought' });
    await expect(sheet.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
    await setWorker(page, { cardSourceOnce: { fail: { status: 409, code: 'thought_erased' } } });
    await lookAgain(page);
    await expect(sheet.locator('.showcase-card-preview')).toHaveAttribute('alt', /Morning! I spent the night/);
    await expect(sheet.getByText('Start with the chart, then.')).toHaveCount(0);
  });

  // spec: add-showcase › Pet card sharing flow › share image
  // spec: add-showcase › Pet card source data › card leaves the browser
  // spec: add-showcase › Pet card sharing flow › share failed
  // spec: add-showcase › Pet card sharing event data › image shared
  // spec: add-showcase › Pet card sharing event data › share not completed
  test('logs only a completed browser share and keeps Save after failure', async ({ page }) => {
    await page.addInitScript(() => {
      const state = globalThis as { __shareMode?: 'complete' | 'cancel' | 'fail'; __shared?: ShareData[]; __shareActivation?: boolean[] };
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
      Object.defineProperty(navigator, 'share', { value: async (data: ShareData) => {
        state.__shared ??= [];
        state.__shared.push(data);
        state.__shareActivation ??= [];
        state.__shareActivation.push(navigator.userActivation.isActive);
        if (state.__shareMode === 'cancel') throw new DOMException('cancelled', 'AbortError');
        if (state.__shareMode === 'fail') throw new Error('failed');
      }, configurable: true });
    });
    await openPet(page);
    await choose(page, 'a thought');
    const sheet = page.getByRole('dialog', { name: 'Share a thought' });
    const preview = await sheet.locator('.showcase-card-preview').evaluate(async (image: HTMLImageElement) => Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer())));
    await page.evaluate(() => { (globalThis as { __shareMode?: string }).__shareMode = 'cancel'; });
    await sheet.getByRole('button', { name: 'Share', exact: true }).click();
    expect((await calls(page)).filter((call) => call === 'worker:cardShared')).toHaveLength(0);
    await page.evaluate(() => { (globalThis as { __shareMode?: string }).__shareMode = 'complete'; });
    await sheet.getByRole('button', { name: 'Share', exact: true }).click();
    await expect.poll(async () => (await calls(page)).filter((call) => call === 'worker:cardShared').length).toBe(1);
    expect(await page.evaluate(() => (globalThis as { __shared?: ShareData[] }).__shared?.at(-1)?.url)).toContain('/pet/9');
    expect(await page.evaluate(() => (globalThis as { __shareActivation?: boolean[] }).__shareActivation)).toEqual([true, true]);
    expect(await page.evaluate(async () => Array.from(new Uint8Array(await (globalThis as { __shared?: ShareData[] }).__shared!.at(-1)!.files![0]!.arrayBuffer())))).toEqual(preview);
    await page.evaluate(() => { (globalThis as { __shareMode?: string }).__shareMode = 'fail'; });
    await sheet.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(shown(sheet, "Couldn't share the card. Save the image and try from your browser.")).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Save image' })).toBeVisible();
    expect((await calls(page)).filter((call) => call === 'worker:cardShared')).toHaveLength(1);
  });

  // spec: add-showcase › Pet card sharing flow › ownership changed
  // spec: add-showcase › Card eligibility rule › memory cleared
  test('checks the selected source again before delivery', async ({ page }) => {
    await openPet(page);
    await choose(page, 'a thought');
    const sheet = page.getByRole('dialog', { name: 'Share a thought' });
    await expect.poll(async () => (await calls(page)).filter((call) => call === 'worker:cardSource').length).toBeGreaterThanOrEqual(2);
    await setWorker(page, { cardSourceOnce: { fail: { status: 409, code: 'thought_erased' } } });
    await sheet.getByRole('button', { name: 'Save image' }).click();
    await expect(shown(sheet, 'That thought is no longer here. Choose another one.')).toBeVisible();
    await expect(sheet.getByRole('radio')).toHaveCount(1);
    await expect(sheet.locator('.showcase-card-preview')).toHaveAttribute('alt', /Morning! I spent the night/);
    await expect(sheet.getByText('Start with the chart, then.')).toHaveCount(0);
    expect((await calls(page)).filter((call) => call === 'worker:cardShared')).toHaveLength(0);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await setWorker(page, { cardSourceOnce: undefined });
    const sources = async () => (await calls(page)).filter((call) => call === 'worker:cardSource').length;
    const asked = await sources();
    await choose(page, 'a thought');
    // the card's own read and the ready image's source check both come first
    await expect.poll(sources).toBeGreaterThanOrEqual(asked + 2);
    await setWorker(page, { cardSource: { fail: { status: 403, code: 'not_owner' } } });
    await page.getByRole('dialog', { name: 'Share a thought' }).getByRole('button', { name: 'Save image' }).click();
    await expect(shown(page, "Pixel has a new owner. This card can't be shared from here.")).toBeVisible();
    expect((await calls(page)).filter((call) => call === 'worker:cardShared')).toHaveLength(0);
    await page.getByRole('dialog', { name: 'Share a thought' }).getByRole('button', { name: 'Close' }).click();
    await setWorker(page, { owned: [] });
    await lookAgain(page);
    await expect(page.getByRole('button', { name: 'Share Pixel' })).toHaveCount(0);
  });
});
