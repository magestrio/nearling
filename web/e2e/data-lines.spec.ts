import { expect, test, type Page } from '@playwright/test';
import type { AdviceRead, ConversationLine, Thought } from '../src/seams/worker-types';
import { BISCUIT, calls, HISTORY, openWith, OWNER, PIXEL, reloadHolding, setWorker, SIGNED_IN } from './helpers';

// The lines add-pet-errands › Adapter call rule puts on advice and hires: the data sources a pet looks up through, and the way a
// skill whose data did not answer ends a job. The advice column is Biscuit's page for Pixel's player; the hire lines are Pixel's
// own conversation. The fakes answer what the server gives (`labels`, `dataLabels`, the job's `data_failed`).
test.use({ timezoneId: 'Etc/GMT-2' });

const PIXEL_REF = { tokenId: '9', name: 'Pixel' };
const ME = { accountId: 'a'.repeat(64), hatched: PIXEL_REF, currentPet: PIXEL_REF, ownedCount: 1 };
const PRICE = { yocto: '380000000000000000000', cents: 0.38 };
const QUESTION = 'Will it rain in Porto on Saturday? I want to bike to the coast.';
const ANSWER = 'Dry until about two, then light rain from the west.';
const NORI = { tokenId: '5', name: 'Nori' };

const thought = (extra: Partial<Thought> = {}): Thought => ({
  id: 'a1',
  kind: 'advice',
  text: ANSWER,
  cut: null,
  worker: { tokenId: '2', name: 'Biscuit' },
  skilled: false,
  price: PRICE.yocto,
  priceCents: PRICE.cents,
  ...extra,
});

/** Biscuit's page for Pixel's player. `advice` lays over the column's read. */
const open = async (page: Page, advice: Partial<AdviceRead> = {}) =>
  openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT }, me: ME, advice: { price: PRICE, ...advice } } });

const field = (page: Page) => page.getByPlaceholder('Ask Biscuit for advice…');
const ask = (page: Page) => page.getByRole('button', { name: 'Ask Biscuit · 0.38¢' });
const log = (page: Page) => page.getByRole('log', { name: 'Advice from Biscuit' });
const visible = (page: Page, text: string) => page.getByText(text).filter({ visible: true });
const asks = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('worker:askAdvice:'));

const send = async (page: Page) => {
  await setWorker(page, { petState: { pending: true } });
  await field(page).fill(QUESTION);
  await ask(page).click();
  await expect(log(page)).toContainText(QUESTION);
};

const SOURCES_LINE = 'Whoever runs Open-Meteo and Daybook sees what Biscuit looks up there — never your question or the answer.';
const LOOKED_UP = 'Biscuit looked this up through Open-Meteo. Whoever runs them saw what was looked up — never the question or the answer.';

// spec: add-pet-errands › Adapter call rule › advice line
test('advice line: under the line who pays, the sources the pet looks up through; no line for a pet with none', async ({ page }) => {
  await open(page, { labels: ['Open-Meteo', 'Daybook'] });
  await expect(visible(page, SOURCES_LINE)).toHaveCount(1);
  await setWorker(page, { advice: { price: PRICE, labels: [] } });
  await reloadHolding(page);
  await expect(field(page)).toBeVisible();
  await expect(page.getByText(/Whoever runs .* sees what Biscuit looks up/)).toHaveCount(0);
});

// spec: add-pet-errands › Adapter call rule › hired answer line
test('hired answer line: under the answer of advice that used a data source, who looked it up and who saw it; none when no source was used', async ({ page }) => {
  await open(page, { labels: ['Open-Meteo'] });
  await send(page);
  await setWorker(page, { petState: { thought: thought({ dataLabels: ['Open-Meteo'] }) } });
  await expect(visible(page, LOOKED_UP)).toHaveCount(1);
  await expect(log(page).getByText(ANSWER)).toBeVisible();
});

// spec: add-pet-errands › Adapter call rule › hired answer line
test('hired answer line: an answer that read no source carries no such line', async ({ page }) => {
  await open(page, { labels: ['Open-Meteo'] });
  await send(page);
  await setWorker(page, { petState: { thought: thought() } });
  await expect(log(page).getByText(ANSWER)).toBeVisible();
  await expect(page.getByText(/looked this up through/)).toHaveCount(0);
});

// spec: add-pet-errands › Adapter call rule › hired answer line
test('hired answer line: the page opened again shows it under the last answer, and a worker line of a hire shows it under the worker\'s words', async ({ page }) => {
  await open(page, { labels: ['Open-Meteo'], last: { id: 'a1', question: QUESTION, text: ANSWER, skilled: false, dataLabels: ['Open-Meteo'] } });
  await expect(visible(page, LOOKED_UP)).toHaveCount(1);

  const lines: ConversationLine[] = [
    ...(HISTORY as ConversationLine[]),
    { id: 'h1:you', who: 'player', text: 'Should I bike to the office tomorrow?', at: 10 },
    { id: 'h1', who: 'pet', text: 'Will it rain in Lisbon tomorrow?', at: 11, cut: null, hireTo: 'Nori' },
    { id: 'h2', who: 'worker', text: 'Dry until noon.', at: 12, worker: NORI, skilled: true, dataLabels: ['Open-Meteo', 'Daybook'], hire: { worker: 'Nori', price: PRICE.yocto, priceCents: 0.38 } },
  ];
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, conversation: { lines, more: false, before: null } } });
  await expect(page.getByText('Nori looked this up through Open-Meteo and Daybook. Whoever runs them saw what was looked up — never the question or the answer.')).toBeVisible();
  await expect(page.getByText("A private skill shaped this answer. Checking the thought can't show that part.")).toBeVisible();
});

// spec: add-pet-errands › Adapter call rule › data failed in a hire
test('data failed in a hire: the game\'s line before the pet\'s own answer, and the past-three line says what the try used', async ({ page }) => {
  const turn = (code: 'hire_data_failed' | 'hire_data_failed_paid'): ConversationLine[] => [
    ...(HISTORY as ConversationLine[]),
    { id: 'h1:you', who: 'player', text: 'Should I bike to the office tomorrow?', at: 10 },
    { id: 'h1', who: 'pet', text: 'Will it rain in Lisbon tomorrow?', at: 11, cut: null, hireTo: 'Nori' },
    { id: 'h2', who: 'event', code, at: 12, worker: NORI },
    { id: 'h3', who: 'pet', text: 'Check the sky at seven.', at: 13, cut: null },
  ];
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, conversation: { lines: turn('hire_data_failed'), more: false, before: null } } });
  await expect(page.getByText("Nori's skill couldn't get its data just now, so Pixel answered on its own. No fee was paid.")).toBeVisible();
  await expect(page.getByRole('log').getByText('Check the sky at seven.')).toBeVisible();
  await setWorker(page, { conversation: { lines: turn('hire_data_failed_paid'), more: false, before: null } });
  await reloadHolding(page);
  await expect(page.getByText("Nori's skill couldn't get its data just now, so Pixel answered on its own. No fee was paid — the try used a little of Pixel's food.")).toBeVisible();
});

// spec: add-pet-errands › Adapter call rule › data failed in advice
// spec: add-pet-errands › Adapter call rule › data failed in advice × the question kept
test('data failed in advice × the question kept: the line, nothing spent, the question back in the field and «Ask» live again', async ({ page }) => {
  await open(page, { labels: ['Open-Meteo'] });
  await send(page);
  await setWorker(page, { petState: { code: 'data_failed' } });
  await expect(visible(page, "Biscuit's skill couldn't get its data just now. Nothing was spent — your question is kept.")).toHaveCount(1);
  await expect(field(page)).toHaveValue(QUESTION);
  await expect(log(page).getByText(QUESTION)).toHaveCount(0);
  await expect(ask(page)).not.toHaveAttribute('aria-disabled', 'true');
  expect(await asks(page)).toHaveLength(1);
});

// spec: add-pet-errands › Adapter call rule › data failed in advice, past three
// spec: add-pet-errands › Adapter call rule › data failed in advice × the question kept
test('data failed in advice, past three: the line says the paying pet\'s food paid for the try; the question is still kept', async ({ page }) => {
  await open(page, { labels: ['Open-Meteo'] });
  await send(page);
  await setWorker(page, { petState: { code: 'data_failed', paid: true } });
  await expect(visible(page, "Biscuit's skill couldn't get its data just now. No fee was paid, but the try used a little of your Pixel's food. Your question is kept — try again.")).toHaveCount(1);
  await expect(field(page)).toHaveValue(QUESTION);
  await expect(ask(page)).not.toHaveAttribute('aria-disabled', 'true');
});
