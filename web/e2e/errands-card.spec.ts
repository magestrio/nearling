import { expect, test, type Page } from '@playwright/test';
import type { ConversationLine } from '../src/seams/worker-types';
import { BISCUIT, drawn, HISTORY, openWith, OWNER, PIXEL, reloadHolding, SIGNED_IN } from './helpers';

// Verdict card (add-pet-errands › Verdict card screen): «Share card» under an «Is it true?» report opens a centred dialog with the card
// the browser draws — the claim, the verdict, the number of sources and the day, the limit line, the pet's page — and «Save image» and,
// where the browser can share files, «Share». Nothing of it is uploaded; the report stays as it was.
test.use({ timezoneId: 'Etc/GMT-2' });

const OCTOPUS = 'Octopuses have three hearts.';
const SAYS = 'Two hearts pump blood through the gills and one through the body.';
const LIMIT = "Pixel's owner can check that Pixel wrote this verdict and nobody changed it — not that it's right.";

const line = (id: string, text: string, kicker?: 'check'): ConversationLine => ({ id, who: 'player', ...(kicker ? { kicker } : {}), text, at: 1_700_000_000_100 });
const report = (sources: number, verdict: 'true' | 'false' | null = 'true'): ConversationLine => ({
  id: 'e1',
  who: 'pet',
  text: SAYS,
  at: 1_700_000_000_101,
  report: {
    form: 'check',
    sources: Array.from({ length: sources }, (_, i) => ({ label: `site${i + 1}.example`, url: `https://site${i + 1}.example/a` })),
    verdict,
    searches: 2,
    priceCents: 1.06,
    missed: [],
  },
});
const conversation = (...tail: ConversationLine[]) => ({ lines: [...HISTORY, ...tail], more: false, before: null });

const shareCard = (page: Page) => page.getByRole('button', { name: 'Share card' });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Share card' });
const open = (page: Page, tail: ConversationLine[] = [line('e1:you', OCTOPUS, 'check'), report(2)]) =>
  openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, owner: {} }, '2': BISCUIT }, conversation: conversation(...tail) } });

/** a browser that shares files: the menu records what it was handed */
const canShare = (page: Page) =>
  page.addInitScript(() => {
    const g = globalThis as { __SHARED__?: Array<{ files: Array<{ name: string; type: string; size: number }>; text?: string; url?: string }> };
    g.__SHARED__ = [];
    Object.defineProperty(navigator, 'canShare', { value: (d: { files?: File[] }) => Array.isArray(d.files), configurable: true });
    Object.defineProperty(navigator, 'share', {
      value: async (d: { files: File[]; text?: string; url?: string }) => {
        g.__SHARED__!.push({ files: d.files.map((f) => ({ name: f.name, type: f.type, size: f.size })), text: d.text, url: d.url });
      },
      configurable: true,
    });
  });
const shared = (page: Page) => page.evaluate(() => (globalThis as { __SHARED__?: unknown[] }).__SHARED__ ?? []);
/** the PNG signature of the bytes a download carries */
const pngSignature = async (path: string | null) => {
  const { readFileSync } = await import('node:fs');
  return path ? [...readFileSync(path).subarray(0, 8)] : [];
};
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// spec: add-pet-errands › Verdict card screen › success
test('success: the card with the claim, the verdict, «{n} sources · {date}», the limit line and the pet\'s page, «Save image» — and no «Share» where the browser cannot share files', async ({ page }) => {
  await open(page);
  await shareCard(page).click();
  const card = dialog(page);
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Share card' })).toBeVisible();
  await expect(card.getByText(`“${OCTOPUS}”`)).toBeVisible();
  await expect(card.getByText('Pixel', { exact: true })).toBeVisible();
  await expect(card.getByText('Is it true?', { exact: true })).toBeVisible();
  await expect(card.locator('.ds-share-card__stamp')).toHaveText('True');
  await expect(card.getByText(/^2 sources · [A-Z][a-z]{2} \d{1,2}, \d{4}$/)).toBeVisible();
  await expect(card.getByText(LIMIT)).toBeVisible();
  await expect(card.getByText(/\/pet\/9$/)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Save image' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  // the page under it is out of reach, the report is still there
  await expect(page.getByRole('log')).toContainText(SAYS);
});

// spec: add-pet-errands › Verdict card screen › success
test('success: «1 source · {date}» for one, and the «Unclear — …» line where the stamp stands for an unclear claim', async ({ page }) => {
  await open(page, [line('e1:you', OCTOPUS, 'check'), report(1, null)]);
  await shareCard(page).click();
  await expect(dialog(page).getByText(/^1 source · /)).toBeVisible();
  await expect(dialog(page).locator('.ds-share-card__stamp')).toHaveCount(0);
  await expect(dialog(page).locator('.ds-share-card__line')).toHaveText("Unclear — Pixel couldn't find enough to say either way.");
});

// spec: add-pet-errands › Verdict card screen › success
test('success: «Save image» downloads the PNG the browser drew, named for the pet', async ({ page }) => {
  await open(page);
  await shareCard(page).click();
  const save = dialog(page).getByRole('button', { name: 'Save image' });
  await expect(save).not.toHaveAttribute('aria-busy', 'true');
  const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
  expect(download.suggestedFilename()).toBe('Pixel-verdict.png');
  expect(await pngSignature(await download.path())).toEqual(PNG);
});

// spec: add-pet-errands › Verdict card screen › success
test('success: «Share» appears where the browser can share files and hands the menu the image and the pet\'s link', async ({ page }) => {
  await canShare(page);
  await open(page);
  await shareCard(page).click();
  const share = dialog(page).getByRole('button', { name: 'Share', exact: true });
  await expect(share).toBeVisible();
  await expect(share).not.toHaveAttribute('aria-busy', 'true');
  await share.click();
  await expect.poll(async () => (await shared(page)).length).toBe(1);
  const [handed] = (await shared(page)) as Array<{ files: Array<{ name: string; type: string; size: number }>; url: string }>;
  expect(handed!.files).toHaveLength(1);
  expect(handed!.files[0]).toMatchObject({ name: 'Pixel-verdict.png', type: 'image/png' });
  expect(handed!.files[0]!.size).toBeGreaterThan(1_000);
  expect(handed!.url).toMatch(/\/pet\/9$/);
});

// spec: add-pet-errands › Errand events data › card shared
test('card shared: each tap of «Save image» and of «Share» is one image going where the owner sends it, and nothing is uploaded', async ({ page }) => {
  await canShare(page);
  const requests: string[] = [];
  page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await open(page);
  await shareCard(page).click();
  const before = requests.length;
  const save = dialog(page).getByRole('button', { name: 'Save image' });
  await expect(save).not.toHaveAttribute('aria-busy', 'true');
  await Promise.all([page.waitForEvent('download'), save.click()]);
  await dialog(page).getByRole('button', { name: 'Share', exact: true }).click();
  await expect.poll(async () => (await shared(page)).length).toBe(1);
  // the fakes answer the Worker in the page; nothing else left it, and the card is no request of its own
  expect(requests.slice(before).filter((r) => r.startsWith('POST') || r.includes('/api/'))).toEqual([]);
});

// spec: add-pet-errands › Verdict card screen › success
test('success: Close, Esc and the scrim close it, and the focus goes back to «Share card»', async ({ page }) => {
  await open(page);
  for (const close of [
    () => dialog(page).getByRole('button', { name: 'Close' }).click(),
    () => page.keyboard.press('Escape'),
    () => page.locator('.ds-sheet__scrim').click({ position: { x: 4, y: 4 } }),
  ]) {
    await shareCard(page).click();
    await expect(dialog(page)).toBeVisible();
    await close();
    await expect(dialog(page)).toHaveCount(0);
    await expect(shareCard(page)).toBeFocused();
  }
});

// spec: add-pet-errands › Verdict card screen › success × reload
test('success × reload: the card is the tab\'s memory — a reload shows the report and no card', async ({ page }) => {
  await open(page);
  await shareCard(page).click();
  await expect(dialog(page)).toBeVisible();
  await reloadHolding(page);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText(SAYS);
});

// spec: add-pet-errands › Verdict card screen › error
test('error: a browser that cannot draw the card meets the line and «Try again» in the card\'s place; the report stays; «Try again» draws again', async ({ page }) => {
  // the canvas gives no image until the test lets it
  await page.addInitScript(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    (globalThis as { __NO_IMAGE__?: boolean }).__NO_IMAGE__ = true;
    HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
      if ((globalThis as { __NO_IMAGE__?: boolean }).__NO_IMAGE__) cb(null);
      else toBlob.call(this, cb, type, quality);
    };
  });
  await open(page);
  await shareCard(page).click();
  const card = dialog(page);
  await expect(drawn(page, "We couldn't make the card just now. Try again.")).toBeVisible();
  await expect(card.locator('.ds-share-card')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Save image' })).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText(SAYS);
  // «Try again» that fails again keeps the focus on «Try again» (DS › Sheet › Focus)
  await card.getByRole('button', { name: 'Try again' }).click();
  await expect(card.getByRole('button', { name: 'Try again' })).toBeFocused();
  await page.evaluate(() => ((globalThis as { __NO_IMAGE__?: boolean }).__NO_IMAGE__ = false));
  await card.getByRole('button', { name: 'Try again' }).click();
  await expect(card.locator('.ds-share-card')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Save image' })).toBeVisible();
  // the card stands: the focus on «Save image»
  await expect(card.getByRole('button', { name: 'Save image' })).toBeFocused();
  // Close leaves the report as it was
  await card.getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText(SAYS);
});
