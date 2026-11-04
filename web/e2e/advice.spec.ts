import { expect, test, type Page } from '@playwright/test';
import type { AdviceRead, ConversationLine, Thought } from '../src/seams/worker-types';
import { BISCUIT, calls, lookAgain, openWith, PIXEL, reloadHolding, setWorker, SIGNED_IN } from './helpers';

// The guest's side of the advice (add-pet-work › Advice flow): a player with a pet of their own, Pixel, asks a friend's pet, Biscuit,
// and Pixel pays from its food. The column is the frame `guestAdvice`; the fakes answer the three reads of the Worker.
test.use({ timezoneId: 'Etc/GMT-2' });

const PIXEL_REF = { tokenId: '9', name: 'Pixel' };
const ME = { accountId: 'a'.repeat(64), hatched: PIXEL_REF, currentPet: PIXEL_REF, ownedCount: 1 };
const QUESTION = 'My cat ignores me after I travel. How do I make up for it?';
const ANSWER = "Don't chase. Sit on the floor near the cat's spot with a book and wait.";
const PRICE = { yocto: '380000000000000000000', cents: 0.38 };
const PAYS = "Your Pixel pays from its food. Biscuit's owner won't see your question or the answer.";
const SKILL_NOTE = "Biscuit has a private skill that shapes its answers. Checking the thought can't show that part.";
const SAVED = "Saved in your Pixel's chat — only its owner can see it.";
const SKILLED_UNDER = "A private skill shaped this answer. Checking the thought can't show that part.";
const SESSION_LINE = "You've been signed out. Sign in to pick up where you left off.";
const ASLEEP_BISCUIT = { ...BISCUIT, fullness: { state: 'asleep' as const, level: 0 } };
const RESETS = '02:00';

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

/** Biscuit's page for Pixel's player. `advice` lays over the column's read, `extra` over the Worker fake. */
const open = async (page: Page, advice: Partial<AdviceRead> = {}, extra: Record<string, unknown> = {}) =>
  openWith(page, '/pet/2', {
    auth: SIGNED_IN,
    worker: { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT }, me: ME, advice: { price: PRICE, ...advice }, ...extra },
  });

const field = (page: Page) => page.getByPlaceholder('Ask Biscuit for advice…');
const ask = (page: Page, price = '0.38¢') => page.getByRole('button', { name: `Ask Biscuit · ${price}` });
const log = (page: Page) => page.getByRole('log', { name: 'Advice from Biscuit' });
const status = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });
const visible = (page: Page, text: string) => page.getByText(text).filter({ visible: true });
const asks = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('worker:askAdvice:'));
const reads = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:advice').length;
const endSession = async (page: Page) => {
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
};

/** The question typed and sent; the job stands (the fake poll says it is on its way until a test says more). */
const send = async (page: Page, text = QUESTION) => {
  await setWorker(page, { petState: { pending: true } });
  await field(page).fill(text);
  await ask(page).click();
  await expect(log(page)).toContainText(text);
};

// spec: add-pet-work › Advice flow › совет открыт
test('совет открыт: the field, «Ask Biscuit · 0.38¢» and the line who pays under it, «Go to your Pixel»; no skill line', async ({ page }) => {
  await open(page);
  await expect(field(page)).toBeVisible();
  await expect(field(page)).toHaveValue('');
  await expect(ask(page)).toBeVisible();
  // an empty field keeps the button inactive (`Advice flow` › blank question); a question makes it live
  await expect(ask(page)).toHaveAttribute('aria-disabled', 'true');
  await field(page).fill(QUESTION);
  await expect(ask(page)).not.toHaveAttribute('aria-disabled', 'true');
  await field(page).fill('');
  await expect(visible(page, PAYS)).toHaveCount(1);
  await expect(page.getByText(SKILL_NOTE)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Go to your Pixel' })).toHaveAttribute('href', '/pet/9');
  await expect(page.getByRole('button', { name: 'Feed Biscuit' }).filter({ visible: true })).toHaveCount(1);
  expect(await reads(page)).toBeGreaterThan(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // spec: add-pet-work › Advice flow › совет открыт
  test('совет открыт: the visitor\'s pet takes the hero height, rises over the header\'s room and leaves «Go to your Pixel» tappable', async ({ page }) => {
    await open(page);
    const pet = page.locator('.ds-stage--compact:not(.ds-stage--owner) .pet-figure--hero');
    const proportion = await pet.evaluate((el) => el.getBoundingClientRect().height / innerHeight);
    expect(proportion).toBeGreaterThan(0.3);
    const reached = await page.getByRole('link', { name: 'Go to your Pixel' }).evaluate((link) => {
      const r = link.getBoundingClientRect();
      return link.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
    expect(reached).toBe(true);
  });
});

// spec: add-pet-work › Advice flow › advice from a pet with a skill
test('advice from a pet with a skill: the private-skill line joins the line who pays', async ({ page }) => {
  await open(page, { skilled: true });
  await expect(visible(page, PAYS)).toHaveCount(1);
  await expect(visible(page, SKILL_NOTE)).toHaveCount(1);
});

// spec: add-pet-work › Advice flow › вопрос отправлен
test('вопрос отправлен: the question under «You», «Biscuit is thinking…», the field empty and no second question until the answer', async ({ page }) => {
  await open(page);
  await send(page);
  await expect(status(page, 'Biscuit is thinking…')).toBeVisible();
  // the friend's pet thinks too, its face as well; the answer gives its face back
  await expect(page.getByRole('img', { name: 'Biscuit, thinking' })).toBeVisible();
  await expect(field(page)).toHaveValue('');
  expect(await asks(page)).toEqual([`worker:askAdvice:${PRICE.yocto}`]);
  await expect(ask(page)).toHaveAttribute('aria-disabled', 'true');
  await field(page).fill('One more');
  await field(page).press('Enter');
  await ask(page).click({ force: true });
  expect(await asks(page)).toHaveLength(1);
});

// spec: add-pet-work › Advice flow › вопрос отправлен × 10 s
test('вопрос отправлен × 10 s: the long-answer line joins the thinking line', async ({ page }) => {
  await open(page, {}, { waitLineMs: 500 });
  await send(page);
  await expect(status(page, 'Biscuit is thinking…')).toContainText('Still working on it — long answers can take a minute or two.');
});

// spec: add-pet-work › Advice flow › вопрос отправлен × reload
test('вопрос отправлен × reload: the question and «Biscuit is thinking…» come back and a second question is not taken', async ({ page }) => {
  await open(page);
  await send(page);
  await setWorker(page, { advice: { pending: { job: 'job-advice', question: QUESTION } } });
  await reloadHolding(page);
  await expect(log(page)).toContainText(QUESTION);
  await expect(status(page, 'Biscuit is thinking…')).toBeVisible();
  await expect(field(page)).toHaveValue('');
  await expect(ask(page)).toHaveAttribute('aria-disabled', 'true');
  await field(page).fill('One more');
  await field(page).press('Enter');
  // this load's fakes were asked nothing: the page after the reload sent no question
  expect(await asks(page)).toEqual([]);
});

// spec: add-pet-work › Advice flow › вопрос отправлен
test('вопрос отправлен: a second ask the server refuses as pending (another tab) shows the question on its way', async ({ page }) => {
  await open(page, {}, { askAdvice: { fail: { status: 409, code: 'pending' } }, petState: { pending: true } });
  await setWorker(page, { advice: { pending: null } });
  await field(page).fill('Another one');
  await setWorker(page, { advice: { pending: { job: 'job-advice', question: QUESTION } } });
  await ask(page).click();
  await expect(log(page)).toContainText(QUESTION);
  await expect(status(page, 'Biscuit is thinking…')).toBeVisible();
});

// spec: add-pet-work › Advice flow › ответ
test('ответ: Biscuit\'s answer under its name with «Check this thought» and where it is kept; Pixel\'s price read again', async ({ page }) => {
  await open(page);
  await send(page);
  const before = await reads(page);
  await setWorker(page, { petState: { thought: thought() } });
  const answer = log(page).locator('li', { hasText: ANSWER });
  await expect(answer).toBeVisible();
  await expect(answer).toContainText('Biscuit');
  await expect(answer.getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', '/pet/2/verify/a1');
  await expect(answer).toContainText(SAVED);
  await expect(answer).not.toContainText(SKILLED_UNDER);
  await expect(log(page).getByText(QUESTION)).toHaveCount(1);
  await expect(status(page, 'Biscuit is thinking…')).toHaveCount(0);
  await expect.poll(() => reads(page)).toBeGreaterThan(before);
  await field(page).fill('And if it hides?');
  await expect(ask(page)).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-work › Worker rule › answer with a skill
test('answer with a skill: under the answer the line that a private skill shaped it, after where it is kept', async ({ page }) => {
  await open(page, { skilled: true });
  await send(page);
  await setWorker(page, { petState: { thought: thought({ skilled: true }) } });
  const answer = log(page).locator('li', { hasText: ANSWER });
  await expect(answer).toContainText(SAVED);
  await expect(answer).toContainText(SKILLED_UNDER);
});

// spec: add-pet-work › Advice flow › price rose
test('price rose: the question stays in the field, nothing is spent, the line and the new price on the button; a new tap pays it', async ({ page }) => {
  await open(page);
  await send(page);
  const rose = { yocto: '520000000000000000000', cents: 0.52 };
  await setWorker(page, { advice: { price: rose }, petState: { code: 'price_rose', price: rose } });
  await expect(page.locator('.ds-composer__note')).toHaveText("Biscuit is busier now — it's 0.52¢. Your question is still here, and nothing was spent.");
  await expect(field(page)).toHaveValue(QUESTION);
  await expect(log(page).getByText(QUESTION)).toHaveCount(0);
  await expect(ask(page, '0.52¢')).toBeVisible();
  await setWorker(page, { petState: { pending: true } });
  await ask(page, '0.52¢').click();
  await expect.poll(async () => await asks(page)).toEqual([`worker:askAdvice:${PRICE.yocto}`, `worker:askAdvice:${rose.yocto}`]);
  await expect(page.getByText("Biscuit is busier now")).toHaveCount(0);
});

// spec: add-pet-work › Advice flow › совет потом
test('совет потом: on Pixel\'s own page the advice it paid for stays in its conversation, with «Check this thought»', async ({ page }) => {
  const lines: ConversationLine[] = [
    { id: 'adv:you', who: 'player', text: QUESTION, at: 1 },
    { id: 'adv', who: 'worker', text: ANSWER, at: 2, worker: { tokenId: '2', name: 'Biscuit' }, skilled: false },
  ];
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT }, conversation: { lines, more: false, before: null } } });
  const convo = page.getByRole('log').first();
  await expect(convo).toContainText(QUESTION);
  const answer = convo.locator('li', { hasText: ANSWER });
  await expect(answer).toContainText('Biscuit');
  await expect(answer.getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', '/pet/2/verify/adv');
});

// spec: add-pet-work › Advice flow › page opened again
test('page opened again: the last question to Biscuit with its answer, «Check this thought» and the saved line; the field empty, the button at the price now', async ({ page }) => {
  await open(page, { last: { id: 'a1', question: QUESTION, text: ANSWER, skilled: false }, price: { yocto: '520000000000000000000', cents: 0.52 } });
  await expect(log(page)).toContainText(QUESTION);
  const answer = log(page).locator('li', { hasText: ANSWER });
  await expect(answer.getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', '/pet/2/verify/a1');
  await expect(answer).toContainText(SAVED);
  await expect(field(page)).toHaveValue('');
  await expect(ask(page, '0.52¢')).toBeVisible();
});

// spec: add-pet-work › Advice flow › page opened again
test('page opened again: a question still on its way comes before the last answer, with «Biscuit is thinking…»', async ({ page }) => {
  await open(page, { pending: { job: 'job-advice', question: 'Second question' }, last: { id: 'a1', question: QUESTION, text: ANSWER, skilled: false } }, { petState: { pending: true } });
  await expect(log(page)).toContainText('Second question');
  await expect(status(page, 'Biscuit is thinking…')).toBeVisible();
  await expect(log(page).getByText(ANSWER)).toHaveCount(0);
  await expect(field(page)).toHaveValue('');
});

// spec: add-pet-work › Advice flow › page opened again × memory cleared
test('page opened again × memory cleared: after the asker\'s memory was cleared there is no last question to show', async ({ page }) => {
  await open(page, { last: { id: 'a1', question: QUESTION, text: ANSWER, skilled: false } });
  await expect(log(page)).toContainText(ANSWER);
  await setWorker(page, { advice: { last: null } });
  await reloadHolding(page);
  await expect(field(page)).toBeVisible();
  await expect(log(page).getByText(QUESTION)).toHaveCount(0);
  await expect(log(page).getByText(ANSWER)).toHaveCount(0);
  await expect(ask(page)).toBeVisible();
});

// spec: add-pet-work › Advice flow › пустой ответ работника
test('пустой ответ работника: the line where the answer would be, the question back in the field, «Ask» live again', async ({ page }) => {
  await open(page);
  await send(page);
  await setWorker(page, { petState: { code: 'empty_paid' } });
  await expect(page.getByText("Biscuit lost that answer. No fee was paid, but the try used a little of your Pixel's food. Your question is kept — try again.").filter({ visible: true })).toBeVisible();
  await expect(field(page)).toHaveValue(QUESTION);
  await expect(log(page).getByText(QUESTION)).toHaveCount(0);
  await expect(ask(page)).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-work › Advice flow › memory cleared on the way
test('memory cleared on the way: in place of the answer the line that it was not kept, the question back in the field', async ({ page }) => {
  await open(page);
  await send(page);
  await setWorker(page, { petState: { code: 'memory_cleared' } });
  await expect(page.getByText("Pixel's memory was cleared, so this answer wasn't kept. It used a little of your Pixel's food.").filter({ visible: true })).toBeVisible();
  // the game's own event line, centred and quiet, not an error alert (the hire side says it the same way)
  await expect(log(page).getByRole('alert')).toHaveCount(0);
  await expect(log(page).locator('.ds-message--event', { hasText: "Pixel's memory was cleared" })).toHaveCount(1);
  await expect(field(page)).toHaveValue(QUESTION);
  await expect(log(page).locator('li', { hasText: ANSWER })).toHaveCount(0);
  await expect(ask(page)).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-work › Advice flow › работник уснул
test('работник уснул: asleep under an open page — the question in the field, the line and «Feed Biscuit», «Ask» off; awake again, «Ask» is live', async ({ page }) => {
  await open(page);
  await field(page).fill(QUESTION);
  await setWorker(page, { pets: { '9': PIXEL, '2': ASLEEP_BISCUIT }, advice: { workerAsleep: true } });
  await lookAgain(page);
  await expect(visible(page, 'Biscuit is asleep — food from you would wake Biscuit up.').first()).toBeVisible();
  await expect(field(page)).toHaveValue(QUESTION);
  await expect(ask(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Feed Biscuit' }).filter({ visible: true })).toHaveCount(1);
  await field(page).press('Enter');
  expect(await asks(page)).toEqual([]);
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT }, advice: { workerAsleep: false } });
  await lookAgain(page);
  await expect(ask(page)).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-work › Advice flow › работник уснул
test('работник уснул: asleep under a question on its way — «Biscuit couldn\'t help just now. Nothing was spent — your question is kept.», the question back', async ({ page }) => {
  await open(page);
  await send(page);
  await setWorker(page, { pets: { '9': PIXEL, '2': ASLEEP_BISCUIT }, advice: { workerAsleep: true }, petState: { code: 'worker_asleep' } });
  await expect(page.getByText("Biscuit couldn't help just now. Nothing was spent — your question is kept.").filter({ visible: true })).toBeVisible();
  await expect(visible(page, 'Biscuit is asleep — food from you would wake Biscuit up.').first()).toBeVisible();
  await expect(field(page)).toHaveValue(QUESTION);
  await expect(ask(page)).toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-work › Advice flow › свой питомец устал
test('свой питомец устал: «Your Pixel is tired for today. You can ask again at 02:00.» in the button\'s place, the question kept', async ({ page }) => {
  await open(page, { payer: { tokenId: '9', name: 'Pixel', state: 'tired', until: '2026-11-04T00:00:00.000Z' } });
  await field(page).fill(QUESTION);
  await expect(visible(page, `Your Pixel is tired for today. You can ask again at ${RESETS}.`).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Ask Biscuit/ })).toHaveCount(0);
  await expect(field(page)).toHaveValue(QUESTION);
});

// spec: add-pet-work › Advice flow › свой питомец не может заплатить
test('свой питомец не может заплатить: the line and «Feed your Pixel» in the button\'s place, the question kept; a skilled worker adds when its price drops', async ({ page }) => {
  await open(page, { payer: { tokenId: '9', name: 'Pixel', state: 'short', until: null }, skilled: true, dropsAt: '2026-11-04T00:00:00.000Z' });
  await field(page).fill(QUESTION);
  await expect(visible(page, 'Asking Biscuit costs 0.38¢. Your Pixel needs a meal before it can pay.').first()).toBeVisible();
  await expect(visible(page, `Biscuit's price drops back at ${RESETS}.`).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Ask Biscuit/ })).toHaveCount(0);
  await expect(field(page)).toHaveValue(QUESTION);
  // the state's one filled action is «Feed your Pixel»; «Feed Biscuit» steps down
  await expect(page.getByRole('button', { name: 'Feed your Pixel' })).toHaveClass(/ds-button--primary/);
  await expect(page.getByRole('button', { name: 'Feed Biscuit' }).filter({ visible: true })).toHaveClass(/ds-button--secondary/);
  await page.getByRole('button', { name: 'Feed your Pixel' }).click();
  await expect(page.getByRole('dialog', { name: 'Feed your Pixel' })).toBeVisible();
  expect(await asks(page)).toEqual([]);
});

// spec: add-pet-work › Advice flow › свой питомец накормлен
test('свой питомец накормлен: the meal confirmed with the sheet closed — the same page, «Ask Biscuit · 0.38¢» back with the question in the field', async ({ page }) => {
  await open(page, { payer: { tokenId: '9', name: 'Pixel', state: 'short', until: null } }, { pets: { '9': { ...PIXEL, fullness: { state: 'hungry', level: 0.25 } }, '2': BISCUIT } });
  await field(page).fill(QUESTION);
  await page.getByRole('button', { name: 'Feed your Pixel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Feed your Pixel' });
  await setWorker(page, { advice: { payer: { tokenId: '9', name: 'Pixel', state: 'ok', until: null } } });
  await dialog.getByRole('button', { name: /^Feed · 5¢/ }).click();
  await expect(dialog.getByText(/Yum!/).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(ask(page)).toBeVisible();
  await expect(ask(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(field(page)).toHaveValue(QUESTION);
});

// spec: add-pet-work › Advice flow › свой питомец накормлен
test('свой питомец накормлен: the meal confirmed with the sheet still open reads the column behind it', async ({ page }) => {
  await open(page, { payer: { tokenId: '9', name: 'Pixel', state: 'short', until: null } }, { pets: { '9': { ...PIXEL, fullness: { state: 'hungry', level: 0.25 } }, '2': BISCUIT } });
  await field(page).fill(QUESTION);
  await page.getByRole('button', { name: 'Feed your Pixel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Feed your Pixel' });
  await setWorker(page, { advice: { payer: { tokenId: '9', name: 'Pixel', state: 'ok', until: null } } });
  await dialog.getByRole('button', { name: /^Feed · 5¢/ }).click();
  await expect(dialog.getByText(/Yum!/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Ask Biscuit/ })).toHaveCount(1);
});

// spec: add-pet-work › Advice flow › several at once
test('several at once: of the five blockers only the first shows, in the order of the Scenario; «Feed Biscuit» keeps its place', async ({ page }) => {
  const PAUSED = 'Chatting is paused on our side while we top up. Your message is kept — Biscuit will be back soon.';
  const ASLEEP = 'Biscuit is asleep — food from you would wake Biscuit up.';
  const RESTING = `Biscuit is resting until ${RESETS}. Nothing was spent — ask again after that.`;
  const CANT_PAY = 'Asking Biscuit costs 0.38¢. Your Pixel needs a meal before it can pay.';
  const TIRED = `Your Pixel is tired for today. You can ask again at ${RESETS}.`;
  const all = [PAUSED, ASLEEP, RESTING, CANT_PAY, TIRED];
  const only = async (index: number) => {
    for (const [i, line] of all.entries()) {
      if (i === index) await expect(visible(page, line).first()).toBeVisible();
      else await expect(visible(page, line)).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: 'Feed Biscuit' }).filter({ visible: true })).toHaveCount(1);
  };
  // the pause is the page's read (`paused` of `GET …/advice`), over the other four, which are the page's and the read's too
  await open(page, { paused: true });
  await field(page).fill(QUESTION);
  await expect(visible(page, PAUSED).first()).toBeVisible();
  await setWorker(page, {
    pets: { '9': PIXEL, '2': ASLEEP_BISCUIT },
    advice: { paused: true, workerAsleep: true, resting: { until: '2026-11-04T00:00:00.000Z' }, payer: { tokenId: '9', name: 'Pixel', state: 'short', until: null } },
  });
  await lookAgain(page);
  await only(0);
  // the pause lifts: the next in line
  await setWorker(page, { advice: { paused: false, workerAsleep: true, resting: { until: '2026-11-04T00:00:00.000Z' }, payer: { tokenId: '9', name: 'Pixel', state: 'short', until: null } } });
  await lookAgain(page);
  await only(1);
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT }, advice: { workerAsleep: false, resting: { until: '2026-11-04T00:00:00.000Z' }, payer: { tokenId: '9', name: 'Pixel', state: 'short', until: null } } });
  await lookAgain(page);
  await only(2);
  await setWorker(page, { advice: { resting: null, payer: { tokenId: '9', name: 'Pixel', state: 'short', until: null } } });
  await lookAgain(page);
  await only(3);
  await setWorker(page, { advice: { payer: { tokenId: '9', name: 'Pixel', state: 'tired', until: '2026-11-04T00:00:00.000Z' } } });
  await lookAgain(page);
  await only(4);
});

// spec: add-pet-work › Advice flow › several at once
test('several at once: the pause line names the friend\'s pet, and «Ask» comes back by itself when the pause lifts, with no reload and no edit', async ({ page }) => {
  await open(page, { paused: true });
  await field(page).fill(QUESTION);
  await expect(visible(page, 'Chatting is paused on our side while we top up. Your message is kept — Biscuit will be back soon.').first()).toBeVisible();
  await expect(ask(page)).toBeDisabled();
  await setWorker(page, { advice: { paused: false } });
  // the column reads again at the guest page's own pace: no reload, no edit
  await expect(visible(page, 'Chatting is paused on our side while we top up.')).toHaveCount(0, { timeout: 15_000 });
  await expect(ask(page)).toBeEnabled();
  await expect(field(page)).toHaveValue(QUESTION);
  expect(await asks(page)).toEqual([]);
});

// spec: add-pet-work › Advice flow › вопрос отправлен
test('a tap refused with 409 paused leaves the question in the field and reads the pause: the line shows, nothing was spent', async ({ page }) => {
  await open(page, {}, { askAdvice: { fail: { status: 409, code: 'paused' } } });
  await field(page).fill(QUESTION);
  await setWorker(page, { advice: { paused: true } });
  await ask(page).click();
  await expect(visible(page, 'Chatting is paused on our side while we top up.').first()).toBeVisible();
  await expect(field(page)).toHaveValue(QUESTION);
});

// spec: add-pet-work › Advice flow › совет открыт × session expiry
test('совет открыт × session expiry: a tap after the session ended shows the line and «Sign in», sends nothing; after the sign-in the question is back, unsent', async ({ page }) => {
  await open(page);
  await field(page).fill(QUESTION);
  await endSession(page);
  await ask(page).click();
  await expect(page.getByText(SESSION_LINE).first()).toBeVisible();
  expect(await asks(page)).toEqual([]);
  await expect(field(page)).toHaveValue(QUESTION);
  await setWorker(page, { sessionExpired: false });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/2$/);
  await expect(field(page)).toHaveValue(QUESTION);
  await expect(page.getByText(SESSION_LINE)).toHaveCount(0);
  expect(await asks(page)).toEqual([]);
});

// spec: add-pet-work › Advice flow › совет открыт × reload
test('совет открыт × reload: the typed question is gone, the tab\'s memory', async ({ page }) => {
  await open(page);
  await field(page).fill(QUESTION);
  await reloadHolding(page);
  await expect(field(page)).toBeVisible();
  await expect(field(page)).toHaveValue('');
});

// spec: add-pet-work › Hire access data › платит не свой питомец
test('платит не свой питомец: a refused tap sends nothing, reads who the player\'s pet is now', async ({ page }) => {
  await open(page, {}, { askAdvice: { fail: { status: 403, code: 'not_payer' } } });
  await field(page).fill(QUESTION);
  const before = (await calls(page)).filter((c) => c === 'worker:me').length;
  await ask(page).click();
  await expect.poll(async () => (await calls(page)).filter((c) => c === 'worker:me').length).toBeGreaterThan(before);
  await expect(field(page)).toHaveValue(QUESTION);
});

// spec: add-pet-work › Advice flow › совет открыт
test('совет открыт: a visitor and a player with no pet of their own get no advice field', async ({ page }) => {
  await openWith(page, '/pet/2', { worker: { pets: { '9': PIXEL, '2': BISCUIT } } });
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await expect(page.getByPlaceholder('Ask Biscuit for advice…')).toHaveCount(0);
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { pets: { '9': PIXEL, '2': BISCUIT } } });
  await expect(page.getByRole('link', { name: 'Get your own pet' })).toBeVisible();
  await expect(page.getByPlaceholder('Ask Biscuit for advice…')).toHaveCount(0);
});

// spec: add-pet-work › Advice flow › свой питомец не может заплатить × fed elsewhere
test('свой питомец не может заплатить × fed elsewhere: the paying pet fed in another tab or by a friend — «Ask» comes back by itself, «Feed Biscuit» is primary again', async ({ page }) => {
  await open(page, { payer: { tokenId: '9', name: 'Pixel', state: 'short', until: null } });
  await field(page).fill(QUESTION);
  await expect(page.getByRole('button', { name: 'Feed your Pixel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Biscuit' }).filter({ visible: true })).toHaveClass(/ds-button--secondary/);
  await setWorker(page, { advice: { payer: { tokenId: '9', name: 'Pixel', state: 'ok', until: null } } });
  await expect(ask(page)).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Feed your Pixel' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Feed Biscuit' }).filter({ visible: true })).toHaveClass(/ds-button--primary/);
  await expect(field(page)).toHaveValue(QUESTION);
});

// Every read of the column takes 2 s, and the test turns the Worker to «ok» while the read after the named time is in flight: the
// answer is taken when the read ends, so a slow machine can not make the flip come after the read it is meant for.
const SLOW_READ = { adviceDelayMs: 2000 };

// spec: add-pet-work › Advice flow › свой питомец устал × time passes
test('свой питомец устал × time passes: the column reads again at the time the line names, with no reload and no tab switch', async ({ page }) => {
  const until = new Date(Date.now() + 4500).toISOString();
  await open(page, { payer: { tokenId: '9', name: 'Pixel', state: 'tired', until } }, SLOW_READ);
  await field(page).fill(QUESTION);
  await expect(page.getByRole('button', { name: /^Ask Biscuit/ })).toHaveCount(0);
  await setWorker(page, { advice: { payer: { tokenId: '9', name: 'Pixel', state: 'ok', until: null } } });
  // the read comes 1.5 s after the time, well before the 10 s poll
  await expect(ask(page)).toBeEnabled({ timeout: 12_000 });
  await expect(field(page)).toHaveValue(QUESTION);
});

// spec: add-pet-work › Advice flow › свой питомец устал × time passes
test('свой питомец устал × time passes: the read that arrives after the named time is followed by one more, well before the poll', async ({ page }) => {
  // a slow page (a loaded machine) or a clock ahead of the Worker's: the time the read names is already behind when it lands
  const until = new Date(Date.now() - 1000).toISOString();
  await open(page, { payer: { tokenId: '9', name: 'Pixel', state: 'tired', until } }, SLOW_READ);
  await field(page).fill(QUESTION);
  await expect(page.getByRole('button', { name: /^Ask Biscuit/ })).toHaveCount(0);
  await setWorker(page, { advice: { payer: { tokenId: '9', name: 'Pixel', state: 'ok', until: null } } });
  await expect(ask(page)).toBeEnabled({ timeout: 8000 });
  await expect(field(page)).toHaveValue(QUESTION);
});

// spec: add-pet-work › Advice flow › свой питомец устал × the tapped button
test('свой питомец устал × the tapped button: the job ends tired and the button is gone — the focus it held goes to the field', async ({ page }) => {
  await open(page);
  await send(page);
  await ask(page).focus();
  await expect(ask(page)).toBeFocused();
  await setWorker(page, { petState: { code: 'tired' }, advice: { payer: { tokenId: '9', name: 'Pixel', state: 'tired', until: '2026-11-04T00:00:00.000Z' } } });
  await expect(visible(page, `Your Pixel is tired for today. You can ask again at ${RESETS}.`).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Ask Biscuit/ })).toHaveCount(0);
  await expect(field(page)).toBeFocused();
});

// spec: add-pet-work › Advice flow › blank question
test('blank question: spaces only keep «Ask» inactive and Enter does nothing; no worker call, no spend, the text stays', async ({ page }) => {
  await open(page);
  await field(page).fill('   ');
  await expect(ask(page)).toBeDisabled();
  await field(page).press('Enter');
  await ask(page).click({ force: true });
  expect(await asks(page)).toEqual([]);
  await expect(field(page)).toHaveValue('   ');
  await field(page).fill('  Why?  ');
  await expect(ask(page)).toBeEnabled();
  await field(page).fill('   ');
  await expect(ask(page)).toBeDisabled();
  expect(await asks(page)).toEqual([]);
  await expect(field(page)).toHaveValue('   ');
});
