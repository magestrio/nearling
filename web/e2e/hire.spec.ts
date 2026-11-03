import { expect, test, type Page } from '@playwright/test';
import type { ConversationLine, HireMeta } from '../src/seams/worker-types';
import { sampleDiary } from '../src/seams/diary.sample';
import { ASLEEP_PIXEL, BISCUIT, calls, HISTORY, lookAgain, openDiary, openWith, OWNER, reloadHolding, setWorker, SIGNED_IN } from './helpers';

// The owner's side of the hire (add-pet-work › Pet hire flow): the pet asks a pet it knows in the middle of an ordinary turn, in
// Auto by itself and in Manual after the owner's «Ask»; the lines are the server's conversation, the fake serves them.
const ASKED = 'And if they ask why the chart matters?';
const QUESTION = 'How do you make a room care about a chart in one sentence?';
const WORKER_SAYS = 'Tell them what the chart changed for you. One sentence, then stop.';
const PET_SAYS = 'Nori says: one sentence on what changed for you, then a pause.';
const PET_ALONE = 'Say what the chart changed for you — one sentence. Then let the room catch up.';
const NORI = { tokenId: '5', name: 'Nori' };
const PRICE = { yocto: '380000000000000000000', cents: 0.38 };

const you: ConversationLine = { id: 'h1:you', who: 'player', text: ASKED, at: 10 };
const question: ConversationLine = { id: 'h1', who: 'pet', text: QUESTION, at: 11, cut: null, hireTo: 'Nori' };
const workerSays = (hire?: HireMeta, skilled = false): ConversationLine => ({ id: 'h2', who: 'worker', text: WORKER_SAYS, at: 12, worker: NORI, skilled, ...(hire ? { hire } : {}) });
const paid: HireMeta = { worker: 'Nori', price: PRICE.yocto, priceCents: 0.38 };
const ownReply = (text = PET_SAYS, hire: HireMeta | null = paid): ConversationLine => ({ id: 'h3', who: 'pet', text, at: 13, cut: null, ...(hire ? { hire } : {}) });
const hireEvent = (code: 'hire_failed' | 'hire_empty'): ConversationLine => ({ id: 'h2', who: 'event', code, at: 12, worker: NORI });
const conversation = (...lines: ConversationLine[]) => ({ lines: [...(HISTORY as ConversationLine[]), ...lines], more: false, before: null });
type Lines = Parameters<typeof conversation>;

const field = (page: Page) => page.getByPlaceholder('Talk to Pixel…');
const log = (page: Page) => page.getByRole('log');
const send = async (page: Page, text: string) => {
  await field(page).fill(text);
  await field(page).press('Enter');
  await expect(log(page)).toContainText(text);
};
const worker = (conv: Lines, extra: Record<string, unknown> = {}, owner: Record<string, unknown> = {}) => ({
  ...OWNER,
  pets: { '9': { ...OWNER.pets['9'], owner }, '2': BISCUIT },
  conversation: conversation(...conv),
  ...extra,
});
/** Pixel's owner view with the Manual offer standing */
const OFFER = { worker: 'Nori', question: QUESTION, price: PRICE };
const MANUAL_OWNER = { hireMode: 'manual' as const, offer: OFFER };
const OFFER_WORDS = 'Pixel wants to ask Nori about this. It costs 0.38¢.';
const ROSE_WORDS = "Nori is busier now — it's 0.52¢. Nothing was spent.";
const status = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });
const sendButton = (page: Page) => page.getByRole('button', { name: 'Send' });

// spec: add-pet-work › Pet hire flow › спрашивает
test('спрашивает: «Pixel is thinking…» turns into «Pixel is asking Nori…», the question stands once, no new line until the answer, the long-answer line joins', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, waitLineMs: 600, petState: { pending: true } } });
  await send(page, ASKED);
  await expect(status(page, 'Pixel is thinking…')).toBeVisible();
  // the model decided to ask: the question is a thought of the server now, the line of this tab gives way to the conversation
  await setWorker(page, { conversation: conversation(you, question), petState: { pending: true, pendingProgress: { asking: 'Nori' } } });
  await expect(status(page, 'Pixel is asking Nori…')).toBeVisible();
  await expect(log(page).getByText(ASKED)).toHaveCount(1);
  await expect(log(page)).toContainText(`To Nori: ${QUESTION}`);
  await expect(sendButton(page)).toHaveAttribute('aria-disabled', 'true');
  await field(page).fill('One more');
  await field(page).press('Enter');
  expect((await calls(page)).filter((c) => c === 'worker:say')).toHaveLength(1);
  await expect(status(page, 'Pixel is asking Nori…')).toContainText('Still working on it — long answers can take a minute or two.');
});

// spec: add-pet-work › Pet hire flow › спросил
test('спросил: Nori\'s answer under its name with its receipt, then the pet\'s own with «Pixel asked Nori · 0.38¢»; the line leaves with the answer', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, ASKED);
  await setWorker(page, { conversation: conversation(you, question), petState: { pending: true, pendingProgress: { asking: 'Nori' } } });
  await expect(status(page, 'Pixel is asking Nori…')).toBeVisible();
  await setWorker(page, {
    conversation: conversation(you, question, workerSays(), ownReply()),
    petState: { pendingProgress: null, thought: { id: 'h3', text: PET_SAYS, cut: null } },
  });
  await expect(page.getByText(PET_SAYS)).toBeVisible();
  await expect(page.getByText('Pixel is asking Nori…')).toHaveCount(0);
  // the worker's answer in its own voice, with its receipt at the worker's token id
  const answer = log(page).locator('li', { hasText: WORKER_SAYS });
  await expect(answer).toContainText('Nori');
  await expect(answer.getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', '/pet/5/verify/h2');
  // the pet's question, its own thought: its receipt, no price
  const asked = log(page).locator('li', { hasText: `To Nori: ${QUESTION}` });
  await expect(asked.getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', '/pet/9/verify/h1');
  await expect(asked).not.toContainText('¢');
  await expect(log(page).locator('li', { hasText: PET_SAYS })).toContainText('Pixel asked Nori · 0.38¢');
  await expect(log(page).getByText(ASKED)).toHaveCount(1);
  await expect(sendButton(page)).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-work › Pet hire flow › вопрос найма в разговоре
test('вопрос найма в разговоре: «To Nori: …» under Pixel\'s name with its receipt and no price, whether the hire happened or not', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question, hireEvent('hire_failed'), ownReply(PET_ALONE, null)]) });
  const asked = log(page).locator('li', { hasText: `To Nori: ${QUESTION}` });
  await expect(asked).toBeVisible();
  await expect(asked.getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', '/pet/9/verify/h1');
  await expect(asked).not.toContainText('¢');
});

// spec: add-pet-work › Pet hire flow › найм не состоялся
test('найм не состоялся: the game\'s line before the pet\'s own answer, no fee; and the empty answer of the fourth try says what it used', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question, hireEvent('hire_failed'), ownReply(PET_ALONE, null)]) });
  await expect(log(page)).toContainText("Nori couldn't help just now, so Pixel answered on its own. No fee was paid.");
  await expect(log(page)).toContainText(PET_ALONE);
  await expect(log(page)).not.toContainText('Pixel asked Nori');
  await setWorker(page, { conversation: conversation(you, question, hireEvent('hire_empty'), ownReply(PET_ALONE, null)) });
  await reloadHolding(page);
  await expect(log(page)).toContainText("Nori came up empty, so Pixel answered on its own. No fee was paid — the try used a little of Pixel's food.");
});

// spec: add-pet-work › Pet hire flow › спрашивает × reload
test('спрашивает × reload: a reloaded page shows «Pixel is asking Nori…» and the question once, no second line from the pending text', async ({ page }) => {
  await openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: worker([you, question], { petState: { pending: true } }, { pendingJob: 'job-1', pendingKind: 'reply', pendingMode: 'chat', pendingText: ASKED, pendingProgress: { asking: 'Nori' } }),
  });
  await expect(status(page, 'Pixel is asking Nori…')).toBeVisible();
  await expect(log(page).getByText(ASKED)).toHaveCount(1);
  await expect(log(page)).toContainText(`To Nori: ${QUESTION}`);
  await expect(sendButton(page)).toHaveAttribute('aria-disabled', 'true');
  // the turn ends while the page is open
  await setWorker(page, { conversation: conversation(you, question, workerSays(), ownReply()), petState: { pendingProgress: null, thought: { id: 'h3', text: PET_SAYS, cut: null } } });
  await expect(page.getByText(PET_SAYS)).toBeVisible();
  await expect(log(page).getByText(WORKER_SAYS)).toBeVisible();
});

// spec: add-pet-work › Pet hire flow › предложение в Manual
test('предложение в Manual: the turn stops on a card with the price in its words, «Ask Nori» and «No thanks»; nothing is asked of the server', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, ASKED);
  await setWorker(page, {
    conversation: conversation(you, question),
    pets: { '9': { ...OWNER.pets['9'], owner: MANUAL_OWNER }, '2': BISCUIT },
    petState: { code: 'offer', pendingProgress: null },
  });
  await expect(log(page).getByText(OFFER_WORDS)).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'No thanks' })).toBeVisible();
  await expect(log(page).getByText(ASKED)).toHaveCount(1);
  await expect(page.getByText('Pixel is thinking…')).toHaveCount(0);
  expect((await calls(page)).filter((c) => c.startsWith('worker:askOffer') || c === 'worker:declineOffer')).toEqual([]);
});

// spec: add-pet-work › Pet hire flow › предложение в Manual × reload
test('предложение в Manual × reload: the card and its buttons come back with the page', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question], {}, MANUAL_OWNER) });
  await expect(log(page).getByText(OFFER_WORDS)).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'No thanks' })).toBeVisible();
  // the card follows the pet's question, not the end of the conversation
  const items = await log(page).locator('li').allTextContents();
  const at = (needle: string) => items.findIndex((t) => t.includes(needle));
  expect(at(OFFER_WORDS)).toBe(at(`To Nori: ${QUESTION}`) + 1);
});

// spec: add-pet-work › Pet hire flow › спрашивает
test('спрашивает: «Ask Nori» sends the price the card named, the buttons go and the focus goes to the input, and the pet is asking Nori', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question], { petState: { pending: true, pendingProgress: { asking: 'Nori' } } }, MANUAL_OWNER) });
  await log(page).getByRole('button', { name: 'Ask Nori' }).click();
  expect((await calls(page)).filter((c) => c.startsWith('worker:askOffer:'))).toEqual([`worker:askOffer:${PRICE.yocto}`]);
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toHaveCount(0);
  await expect(log(page).getByRole('button', { name: 'No thanks' })).toHaveCount(0);
  await expect(log(page).getByText(OFFER_WORDS)).toBeVisible();
  await expect(field(page)).toBeFocused();
  await expect(status(page, 'Pixel is asking Nori…')).toBeVisible();
  // the hire is done: the offer is gone from the owner view, its words stay, the answers follow
  await setWorker(page, {
    conversation: conversation(you, question, workerSays(), ownReply()),
    pets: { '9': { ...OWNER.pets['9'], owner: { hireMode: 'manual' as const, offer: null } }, '2': BISCUIT },
    petState: { pendingProgress: null, offer: null, thought: { id: 'h3', text: PET_SAYS, cut: null } },
  });
  await expect(page.getByText(PET_SAYS)).toBeVisible();
  await expect(log(page).getByText(OFFER_WORDS)).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toHaveCount(0);
});

// spec: add-pet-work › Pet hire flow › price rose on an offer
test('price rose on an offer: nothing is spent, the card says the new price and its buttons come back at it; a new tap sends the new price', async ({ page }) => {
  const rose = { worker: 'Nori', question: QUESTION, price: { yocto: '520000000000000000000', cents: 0.52 } };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question], { petState: { pending: true } }, MANUAL_OWNER) });
  await log(page).getByRole('button', { name: 'Ask Nori' }).click();
  await setWorker(page, {
    pets: { '9': { ...OWNER.pets['9'], owner: { hireMode: 'manual' as const, offer: rose } }, '2': BISCUIT },
    petState: { pending: false, code: 'price_rose', price: rose.price },
  });
  await expect(log(page).getByText(ROSE_WORDS)).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'No thanks' })).toBeVisible();
  await expect(page.getByText('Pixel is asking Nori…')).toHaveCount(0);
  await setWorker(page, { petState: { pending: true } });
  await log(page).getByRole('button', { name: 'Ask Nori' }).click();
  expect((await calls(page)).filter((c) => c.startsWith('worker:askOffer:'))).toEqual([`worker:askOffer:${PRICE.yocto}`, `worker:askOffer:${rose.price.yocto}`]);
});

// spec: add-pet-work › Pet hire flow › отказ в Manual
test('отказ в Manual: «No thanks» takes the buttons, keeps the words, puts the focus in the input, and the pet answers on its own', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question], { petState: { pending: true } }, MANUAL_OWNER) });
  await log(page).getByRole('button', { name: 'No thanks' }).click();
  expect((await calls(page)).filter((c) => c === 'worker:declineOffer')).toHaveLength(1);
  await expect(log(page).getByRole('button', { name: 'No thanks' })).toHaveCount(0);
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toHaveCount(0);
  await expect(log(page).getByText(OFFER_WORDS)).toBeVisible();
  await expect(field(page)).toBeFocused();
  await expect(status(page, 'Pixel is thinking…')).toBeVisible();
  await setWorker(page, {
    conversation: conversation(you, question, ownReply(PET_ALONE, null)),
    pets: { '9': { ...OWNER.pets['9'], owner: { hireMode: 'manual' as const, offer: null } }, '2': BISCUIT },
    petState: { offer: null, thought: { id: 'h3', text: PET_ALONE, cut: null } },
  });
  await expect(page.getByText(PET_ALONE)).toBeVisible();
  await expect(log(page).getByText(OFFER_WORDS)).toBeVisible();
  await expect(log(page)).not.toContainText('Pixel asked Nori');
});

// spec: add-pet-work › Pet hire flow › отказ в Manual
test('отказ в Manual: a new line instead of an answer takes the buttons too, and the line stays in the conversation', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question], { petState: { pending: true } }, MANUAL_OWNER) });
  await send(page, 'Never mind that, what time is it?');
  await expect(log(page).getByRole('button', { name: 'No thanks' })).toHaveCount(0);
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toHaveCount(0);
  await expect(log(page).getByText(OFFER_WORDS)).toBeVisible();
  expect((await calls(page)).filter((c) => c === 'worker:say')).toHaveLength(1);
});

// spec: add-pet-work › Pet hire flow › нажатая кнопка вернулась
test('нажатая кнопка вернулась: «Ask Nori» ends with the AI provider down — the line of that Scenario, and the buttons are back, no «Try again»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question], { petState: { pending: true } }, MANUAL_OWNER) });
  await log(page).getByRole('button', { name: 'Ask Nori' }).click();
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toHaveCount(0);
  // the server kept the offer: the owner view still has it, the job ended `ai_unavailable`
  await setWorker(page, { petState: { pending: false, code: 'ai_unavailable', jobKind: 'hire' } });
  await expect(page.getByText('Pixel lost that thought. Nothing was spent — try again.')).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'No thanks' })).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(log(page).getByText(OFFER_WORDS)).toBeVisible();
});

// spec: add-pet-work › Pet hire flow › нажатая кнопка вернулась
test('нажатая кнопка вернулась: «No thanks» ends with an empty reply the pet paid for — the buttons are back, and a new tap asks again', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question], { petState: { pending: true } }, MANUAL_OWNER) });
  await log(page).getByRole('button', { name: 'No thanks' }).click();
  await setWorker(page, { petState: { pending: false, code: 'empty_paid', jobKind: 'decline' } });
  await expect(page.getByText('Pixel lost that thought, but it still used a little food. Your message is kept — try again.')).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'No thanks' })).toBeVisible();
  await setWorker(page, { petState: { pending: true } });
  await log(page).getByRole('button', { name: 'Ask Nori' }).click();
  expect((await calls(page)).filter((c) => c.startsWith('worker:askOffer:'))).toHaveLength(1);
});

// spec: add-pet-work › Pet hire flow › нажатая кнопка вернулась
test('нажатая кнопка вернулась: «Try again» ends with the own reply lost again — the line of «свой ответ не пришёл» and «Try again» back, no new fee', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, ASKED);
  await setWorker(page, { conversation: conversation(you, question, workerSays(paid)), petState: { pendingProgress: null, code: 'own_lost', ownLost: { turn: 'turn-1' } } });
  await log(page).getByRole('button', { name: 'Try again' }).click();
  await expect(log(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
  // the job ended `own_lost` once more: the server answers a failed finish so
  await setWorker(page, { petState: { pending: false, code: 'own_lost', ownLost: { turn: 'turn-1' } } });
  await expect(log(page).getByText("Pixel lost its own reply. Nori's answer is kept and paid for — Try again finishes Pixel's reply, with no new fee.")).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(log(page).locator('li', { hasText: WORKER_SAYS })).toContainText('Pixel asked Nori · 0.38¢');
});

// spec: add-pet-work › Pet hire flow › offer goes stale
test('offer goes stale: the hirer fell asleep with the offer standing — the words stay, the buttons go, nothing is asked, the Composer says the pet is asleep', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question], {}, MANUAL_OWNER) });
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toBeVisible();
  // the next read has no offer (the server deleted it where it read the sleeping pet)
  await setWorker(page, { pets: { '9': { ...ASLEEP_PIXEL, owner: { hireMode: 'manual' as const, offer: null } }, '2': BISCUIT } });
  await lookAgain(page);
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toHaveCount(0);
  await expect(log(page).getByRole('button', { name: 'No thanks' })).toHaveCount(0);
  await expect(log(page).getByText(OFFER_WORDS)).toBeVisible();
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
  expect((await calls(page)).filter((c) => c.startsWith('worker:askOffer') || c === 'worker:declineOffer')).toEqual([]);
});

// spec: add-pet-work › Pet hire flow › offer goes stale
test('offer goes stale × the phone: the log keeps resting on its newest line when the browser moves its scroll while its list and box change', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question], {}, MANUAL_OWNER) });
  await expect(log(page).getByRole('button', { name: 'Ask Nori' })).toBeVisible();
  const gap = () => log(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(gap).toBeLessThan(2);
  // On a loaded machine the offer's buttons go, the Composer grows with the asleep line and the browser's scroll anchoring moves the
  // log up by the height that went (measured: 115 px up, 12 px short of the end), all laid out before the log's ResizeObserver runs:
  // the log hears the scroll first. Here the same, in one task: the log rests on its end, then its list changes, the scroll moves with
  // it and the log hears that scroll before its ResizeObserver can run.
  await log(page).evaluate((el) => {
    el.dispatchEvent(new Event('scroll'));
    const last = el.querySelector<HTMLElement>('.ds-convo__list > li:last-child')!;
    last.style.paddingBottom = '120px';
    el.scrollTop -= 100;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(gap).toBeLessThan(2);
  // the real transition after it
  await setWorker(page, { pets: { '9': { ...ASLEEP_PIXEL, owner: { hireMode: 'manual' as const, offer: null } }, '2': BISCUIT } });
  await lookAgain(page);
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
  await expect.poll(gap).toBeLessThan(2);
});

// spec: add-pet-work › Pet hire flow › свой ответ не пришёл
test('свой ответ не пришёл: the worker\'s answer with its price, in place of the pet\'s reply what happened and «Try again»; the fullness line stays', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, ASKED);
  await setWorker(page, {
    conversation: conversation(you, question, workerSays(paid)),
    petState: { pendingProgress: null, code: 'own_lost', ownLost: { turn: 'turn-1' } },
  });
  await expect(log(page).getByText("Pixel lost its own reply. Nori's answer is kept and paid for — Try again finishes Pixel's reply, with no new fee.")).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(log(page).locator('li', { hasText: WORKER_SAYS })).toContainText('Pixel asked Nori · 0.38¢');
  await expect(page.getByText('Pixel is asking Nori…')).toHaveCount(0);
});

// spec: add-pet-work › Pet hire flow › свой ответ заново
test('свой ответ заново: «Try again» asks for the own reply only — «Pixel is thinking…», then the answer; no new fee, the worker\'s line stays', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, ASKED);
  await setWorker(page, { conversation: conversation(you, question, workerSays(paid)), petState: { pendingProgress: null, code: 'own_lost', ownLost: { turn: 'turn-1' } } });
  await log(page).getByRole('button', { name: 'Try again' }).click();
  expect((await calls(page)).filter((c) => c === 'worker:finishHire')).toHaveLength(1);
  await expect(log(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(status(page, 'Pixel is thinking…')).toBeVisible();
  await setWorker(page, {
    conversation: conversation(you, question, workerSays(), ownReply()),
    petState: { code: undefined, ownLost: undefined, thought: { id: 'h3', text: PET_SAYS, cut: null } },
  });
  await expect(page.getByText(PET_SAYS)).toBeVisible();
  await expect(log(page).getByText(WORKER_SAYS)).toHaveCount(1);
  expect((await calls(page)).filter((c) => c === 'worker:say')).toHaveLength(1);
});

// spec: add-pet-work › Pet hire flow › свой ответ не пришёл × reload
test('свой ответ не пришёл × reload: after a reload the error line and «Try again» are gone, the worker\'s answer and its price stay', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, ASKED);
  await setWorker(page, { conversation: conversation(you, question, workerSays(paid)), petState: { pendingProgress: null, code: 'own_lost', ownLost: { turn: 'turn-1' } } });
  await expect(log(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await setWorker(page, { petState: {} });
  await reloadHolding(page);
  await expect(log(page).getByText(WORKER_SAYS)).toBeVisible();
  await expect(log(page).locator('li', { hasText: WORKER_SAYS })).toContainText('Pixel asked Nori · 0.38¢');
  await expect(log(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(page.getByText(/lost its own reply/)).toHaveCount(0);
});

// spec: add-pet-work › Pet hire flow › найм не записан в сети
test('найм не записан в сети: «· no fee» replaces the price under Nori\'s answer when the batch settles, without a reload', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question, workerSays(), ownReply()], {}) });
  await expect(log(page).locator('li', { hasText: PET_SAYS })).toContainText('Pixel asked Nori · 0.38¢');
  await setWorker(page, {
    conversation: conversation(you, question, workerSays(), ownReply(PET_SAYS, { worker: 'Nori', noFee: true })),
    pets: { '9': { ...OWNER.pets['9'], owner: { hiresSeen: 1 } }, '2': BISCUIT },
  });
  await lookAgain(page);
  await expect(log(page).locator('li', { hasText: PET_SAYS })).toContainText('Pixel asked Nori · no fee');
  await expect(log(page)).not.toContainText('0.38¢');
});

// spec: add-pet-work › Worker rule › answer with a skill
test('answer with a skill: under the worker\'s answer «A private skill shaped this answer…», beside the receipt', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker([you, question, workerSays(paid, true), ownReply()]) });
  const answer = log(page).locator('li', { hasText: WORKER_SAYS });
  await expect(answer).toContainText("A private skill shaped this answer. Checking the thought can't show that part.");
  await expect(answer).toContainText('Pixel asked Nori · 0.38¢');
});

// spec: add-pet-work › Work diary rule › нанимали вчера
test('нанимали вчера: the entry ends with the pet\'s work of the day before — who hired it, once each, and the food in cents', async ({ page }) => {
  const entry = sampleDiary().entry;
  if (entry.kind !== 'text') throw new Error('the sample diary has an entry');
  const closed = sampleDiary().closedAt;
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(closed));
  await openDiary(page, { entry: { ...entry, work: { hirers: ['Biscuit', 'Nori', 'Mochi'], cents: 0.6 } } });
  await expect(page.getByText(`In the 24 hours before ${time}, Pixel helped Biscuit, Nori and Mochi and got 0.60¢ of food for it.`).first()).toBeVisible();
});

// spec: add-pet-work › Work diary rule › не нанимали
test('не нанимали: no work line in the entry when nobody hired the pet', async ({ page }) => {
  await openDiary(page);
  await expect(page.getByText('I think the fridge is getting nervous about your presentation too.').first()).toBeVisible();
  await expect(page.getByText(/In the 24 hours before/)).toHaveCount(0);
});

// spec: add-pet-work › Pet hire flow › hire memory cleared on the way
test('hire memory cleared on the way: another tab cleared the memory while the pet was asking — the page empties and says the answer was not kept', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, ASKED);
  await setWorker(page, { conversation: conversation(you, question), petState: { pending: true, pendingProgress: { asking: 'Nori' } } });
  await expect(status(page, 'Pixel is asking Nori…')).toBeVisible();
  await setWorker(page, {
    conversation: { lines: [], more: false, before: null },
    pets: { '9': { ...OWNER.pets['9'], owner: { memoryEpoch: 1 } }, '2': BISCUIT },
    petState: { pending: false, pendingProgress: null },
  });
  await expect(log(page)).toContainText("Pixel's memory was cleared, so this answer wasn't kept. It used a little of Pixel's food.");
  await expect(log(page).getByText(ASKED)).toHaveCount(0);
  await expect(page.getByText('Pixel is asking Nori…')).toHaveCount(0);
});

// spec: add-pet-work › Pet hire flow › hire memory cleared on the way
test('hire memory cleared on the way: this tab\'s Clear memory while the pet is asking — the fresh start, then the line that the answer was not kept', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, ASKED);
  await setWorker(page, { conversation: conversation(you, question), petState: { pending: true, pendingProgress: { asking: 'Nori' } } });
  await expect(status(page, 'Pixel is asking Nori…')).toBeVisible();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await page.getByRole('button', { name: 'Clear memory' }).click();
  await expect(log(page)).toContainText("Pixel's memory is clear — same Pixel, fresh start.");
  await expect(log(page)).toContainText("Pixel's memory was cleared, so this answer wasn't kept. It used a little of Pixel's food.");
  await expect(log(page).getByText(ASKED)).toHaveCount(0);
  await expect(page.getByText('Pixel is asking Nori…')).toHaveCount(0);
});

// spec: add-pet-work › Pet hire flow › hire memory cleared on the way
test('hire memory cleared on the way: the turn ended with the memory cleared — the cleared conversation says the answer was not kept', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, ASKED);
  await setWorker(page, { conversation: conversation(you, question), petState: { pending: true, pendingProgress: { asking: 'Nori' } } });
  await expect(status(page, 'Pixel is asking Nori…')).toBeVisible();
  // the clear emptied the conversation; the job ends with the code
  await setWorker(page, { conversation: { lines: [], more: false, before: null }, petState: { pendingProgress: null, code: 'memory_cleared' } });
  await expect(log(page)).toContainText("Pixel's memory was cleared, so this answer wasn't kept. It used a little of Pixel's food.");
  await expect(log(page).getByText(ASKED)).toHaveCount(0);
  await expect(page.getByText('Pixel is asking Nori…')).toHaveCount(0);
  await expect(sendButton(page)).not.toHaveAttribute('aria-disabled', 'true');
});
