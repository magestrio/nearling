import { expect, test, type Page } from '@playwright/test';
import { BISCUIT, calls, HISTORY, lookAgain, openWith, PIXEL, setWorker, SIGNED_IN } from './helpers';

const GROWTH = 'Pixel is a teen now — and turned out clever!';
const GROWTH_LINE = { id: 'g1', who: 'event' as const, text: GROWTH, at: 10 };
const REPLY_LINE = { id: 't1', who: 'pet' as const, text: 'Then we say it plainly, and we say it once.', at: 9 };

/** Pixel as a baby with its owner; `grown` — what the chain says after the write: a teen with its trait, and the line */
const worker = (grown: boolean, extra: Record<string, unknown> = {}) => ({
  owned: ['9'],
  pets: {
    '9': {
      ...PIXEL,
      stage: grown ? ('teen' as const) : ('baby' as const),
      owner: { ownedCount: 1, traits: grown ? ['clever'] : [], energy: 9, lastThought: grown ? 'g1' : null },
    },
    '2': BISCUIT,
  },
  conversation: { lines: grown ? [...HISTORY, GROWTH_LINE] : HISTORY, more: false, before: null },
  ...extra,
});

const field = (page: Page) => page.getByPlaceholder('Talk to Pixel…');
const stageWord = (page: Page, word: string) => page.getByText(word, { exact: true }).filter({ visible: true }).first();
const model = (page: Page) => page.locator('.ds-pet').first();
const growthLine = (page: Page) => page.getByRole('log').locator('.ds-message--event', { hasText: GROWTH });
const polls = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:petState').length;
const hide = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
/** A new load of the page: the Worker answers as `worker` says now */
async function reloadWith(page: Page, answers: Record<string, unknown>) {
  await page.addInitScript((s) => {
    (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__ = s;
  }, { pet: { hold: true }, auth: SIGNED_IN, worker: answers });
  await page.reload();
}

// spec: add-pet-life › Growth flow › стал подростком × the open page
test('стал подростком × the open page: the line rises in under the reply and the model turns teen, with no reload', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker(false) });
  await expect(stageWord(page, 'Baby')).toBeVisible();
  await expect(model(page)).toHaveAttribute('data-stage', 'baby');
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await expect(growthLine(page)).toHaveCount(0);
  await setWorker(page, worker(true));
  await lookAgain(page);
  await expect(growthLine(page)).toHaveCount(1);
  await expect(growthLine(page)).toHaveClass(/ds-message--fresh/);
  await expect(stageWord(page, 'Teen')).toBeVisible();
  // the model is the teen's (`Growth flow` › «стал подростком»: «модель — подросток»)
  await expect(model(page)).toHaveAttribute('data-stage', 'teen');
  await expect(stageWord(page, 'clever')).toBeVisible();
  // the pet's reply before the line is no longer the lead voice
  await expect(page.getByRole('log').locator('.ds-message--latest')).toHaveCount(0);
  // the next looks bring it no second time
  await lookAgain(page);
  await expect(growthLine(page)).toHaveCount(1);
});

// spec: add-pet-life › Growth flow › переход записан позже ответа × the open page, a job in flight
test('переход записан позже ответа × the open page, a job in flight: the line follows the reply, never ahead of it', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker(false) });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await field(page).fill('Hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Pixel is thinking…')).toBeVisible();
  // the transition is written while the reply is still on its way: the page holds the line back
  await setWorker(page, { ...worker(true), petState: { pending: true } });
  await lookAgain(page);
  await expect(page.getByText('Pixel is thinking…')).toBeVisible();
  await expect(growthLine(page)).toHaveCount(0);
  // the reply comes: it and the line stand in their order
  await setWorker(page, {
    ...worker(true),
    conversation: { lines: [...HISTORY, { id: 'hello', who: 'player' as const, text: 'Hello', at: 8 }, REPLY_LINE, GROWTH_LINE], more: false, before: null },
    petState: { thought: { id: 't1', text: REPLY_LINE.text, cut: null } },
  });
  await lookAgain(page);
  await expect(growthLine(page)).toHaveCount(1);
  const log = page.getByRole('log');
  await expect(log.locator('.ds-message--pet', { hasText: REPLY_LINE.text })).toHaveCount(1);
  const text = (await log.textContent()) ?? '';
  expect(text.indexOf(REPLY_LINE.text)).toBeGreaterThan(-1);
  expect(text.indexOf(GROWTH)).toBeGreaterThan(text.indexOf(REPLY_LINE.text));
  await expect(stageWord(page, 'Teen')).toBeVisible();
});

// spec: add-pet-life › Growth flow › переход записан позже ответа × session ended
test('переход записан позже ответа × session ended: the page stands as it was; the line waits for the next load', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker(false) });
  await expect(stageWord(page, 'Baby')).toBeVisible();
  await setWorker(page, { ...worker(true), sessionExpired: true });
  await lookAgain(page);
  await expect.poll(() => polls(page)).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(stageWord(page, 'Baby')).toBeVisible();
  await expect(growthLine(page)).toHaveCount(0);
  // signed in again, on a new load, the line is the first thing in the history
  await reloadWith(page, worker(true));
  await expect(growthLine(page)).toHaveCount(1);
  await expect(stageWord(page, 'Teen')).toBeVisible();
});

// spec: add-pet-life › Growth flow › переход записан позже ответа × tab hidden and back
test('переход записан позже ответа × tab hidden and back: a hidden tab asks nothing; coming back asks once — the line and the model', async ({ page }) => {
  await page.clock.install();
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker(false) });
  await expect(stageWord(page, 'Baby')).toBeVisible();
  await hide(page, true);
  const hiddenAt = await polls(page);
  for (let i = 0; i < 3; i += 1) await page.clock.fastForward(5_000);
  expect(await polls(page)).toBe(hiddenAt);
  await setWorker(page, worker(true));
  await hide(page, false);
  await expect(growthLine(page)).toHaveCount(1);
  await expect(stageWord(page, 'Teen')).toBeVisible();
  expect(await polls(page)).toBe(hiddenAt + 1);
});

// spec: add-pet-life › Growth flow › переход записан позже ответа × a reload
test('переход записан позже ответа × a reload: the line is in the history, not rising, and the stage is the answer\'s', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker(true) });
  await expect(growthLine(page)).toHaveCount(1);
  await expect(growthLine(page)).not.toHaveClass(/ds-message--fresh/);
  await expect(stageWord(page, 'Teen')).toBeVisible();
  await reloadWith(page, worker(true));
  await expect(growthLine(page)).toHaveCount(1);
  await expect(growthLine(page)).not.toHaveClass(/ds-message--fresh/);
  await expect(stageWord(page, 'Teen')).toBeVisible();
});
