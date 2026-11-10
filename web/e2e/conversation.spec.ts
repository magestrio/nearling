import { expect, test, type Page } from '@playwright/test';
import { calls, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const field = (page: Page) => page.getByPlaceholder('Talk to Pixel…');
const STILL_WORKING = 'Still working on it — long answers can take a minute or two.';
const ASLEEP = { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 } };
const owned = { ...OWNER, petState: { pending: true } };

async function send(page: Page, text: string) {
  await field(page).fill(text);
  await field(page).press('Enter');
  await expect(page.getByRole('log')).toContainText(text);
}

// spec: add-pet › Conversation flow › долгий ответ
test('долгий ответ: after 10 s «Still working on it…» joins «Pixel is thinking…»; the reply comes whole and a new line cannot be sent before it', async ({ page }) => {
  await page.clock.install();
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: owned });
  await send(page, 'Tell me a short story about the chart nobody understands.');
  const thinking = page.getByRole('status').filter({ hasText: 'Pixel is thinking…' });
  await expect(thinking).toBeVisible();
  await expect(page.getByText(STILL_WORKING)).toHaveCount(0);
  // the clock runs on beside the fast-forward: 4 s and then 6.5 s cross the 10 s line once
  await page.clock.fastForward(4_000);
  await expect(page.getByText(STILL_WORKING)).toHaveCount(0);
  await page.clock.fastForward(6_500);
  await expect(thinking).toContainText(STILL_WORKING);
  // no new line until the reply: Enter and «Send» do nothing
  await field(page).fill('And another thing');
  await field(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute('aria-disabled', 'true');
  expect((await calls(page)).filter((c) => c === 'worker:say')).toHaveLength(1);
  await setWorker(page, { petState: { thought: { id: 't1', text: 'Once there was a chart nobody understood.', cut: null } } });
  await page.clock.fastForward(2_000);
  await expect(page.getByText('Once there was a chart nobody understood.').first()).toBeVisible();
  await expect(page.getByText(STILL_WORKING)).toHaveCount(0);
  await expect(page.getByText('Pixel is thinking…')).toHaveCount(0);
  await expect(field(page)).toHaveValue('And another thing');
});

// spec: add-pet › Conversation flow › долгий ответ × вкладка скрыта и снова видна
test('долгий ответ × вкладка скрыта и снова видна: a hidden tab asks nothing; coming back asks at once and the reply is in place', async ({ page }) => {
  await page.clock.install();
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: owned });
  await send(page, 'A long one, please');
  await expect(page.getByRole('status').filter({ hasText: 'Pixel is thinking…' })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const polls = async () => (await calls(page)).filter((c) => c === 'worker:petState').length;
  await page.clock.fastForward(1_500);
  const hiddenAt = await polls();
  await page.clock.fastForward(1_500);
  await page.clock.fastForward(1_500);
  expect(await polls()).toBe(hiddenAt);
  // the reply was ready meanwhile; the tab comes back
  await setWorker(page, { petState: { thought: { id: 't1', text: 'It was ready while you were away.', cut: null } } });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByText('It was ready while you were away.').first()).toBeVisible();
  await expect(page.getByText('Pixel is thinking…')).toHaveCount(0);
});

// spec: add-pet › Conversation flow › Ответ × перезагрузка теряет черновик
test('Ответ × перезагрузка теряет черновик: what was typed is the tab\'s memory, a reload brings an empty field', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await field(page).fill('half a thought');
  await expect(field(page)).toHaveValue('half a thought');
  await page.reload();
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await expect(field(page)).toHaveValue('');
  expect(await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.startsWith('nearling')))).toEqual([]);
});

// spec: add-pet › Thought queue data › параллельные запросы ждут очереди × перезагрузка посреди мысли
test('перезагрузка посреди мысли: the thought is still on its way — after the load the line of its mode, then the reply', async ({ page }) => {
  const worker = {
    ...OWNER,
    pets: { '9': { ...PIXEL, owner: { pendingJob: 'job-7', pendingMode: 'deep' as const } } },
    petState: { pending: true },
  };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker });
  await expect(page.getByRole('status').filter({ hasText: 'Pixel is thinking hard…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await setWorker(page, { petState: { thought: { id: 't7', text: 'A deeper answer.', cut: null, price: '1', priceCents: 0.13 } } });
  await expect(page.getByText('A deeper answer.').first()).toBeVisible();
  await expect(page.getByText('Thought hard · 0.13¢').first()).toBeVisible();
  await expect(page.getByText('Pixel is thinking hard…')).toHaveCount(0);
});

// spec: add-pet › Thought queue data › параллельные запросы ждут очереди × вторая вкладка шлёт реплику
test('вторая вкладка шлёт реплику: a tab that finds a thought on its way cannot send before its outcome', async ({ page }) => {
  const worker = { ...OWNER, pets: { '9': { ...PIXEL, owner: { pendingJob: 'job-from-tab-one', pendingMode: 'chat' as const } } }, petState: { pending: true } };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker });
  await expect(page.getByRole('status').filter({ hasText: 'Pixel is thinking…' })).toBeVisible();
  await field(page).fill('from tab two');
  await field(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute('aria-disabled', 'true');
  expect((await calls(page)).filter((c) => c === 'worker:say')).toHaveLength(0);
  await setWorker(page, { petState: { thought: { id: 't1', text: 'The first tab\'s answer.', cut: null } } });
  await expect(page.getByText("The first tab's answer.").first()).toBeVisible();
  // the typed line waited in the field and goes now
  await expect(field(page)).toHaveValue('from tab two');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await calls(page)).filter((c) => c === 'worker:say')).toHaveLength(1);
});

// spec: add-pet › Sleep and wake flow › разбудил друг при открытой странице
test('разбудил друг при открытой странице × the phone: the conversation keeps resting on its newest line through the sleep and the wake', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // a history long enough to scroll; the box and the list change under the log as the pet sleeps and wakes
  const lines = [
    'Morning! I spent the night counting the hum of your fridge. Forty-one. Did you sleep?',
    'Barely. Big presentation at ten.',
    "Then here's the plan: one deep breath, one sip of water, and you tell me what the first slide says.",
    "It's the chart nobody understands.",
    'Start with the chart, then. Say what surprised you about it — people follow a surprise better than a number.',
  ].map((text, i) => ({ id: `c${i}${i % 2 ? ':you' : ''}`, who: (i % 2 ? 'player' : 'pet') as 'player' | 'pet', text, at: i + 1 }));
  await openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: { owned: ['9'], pets: { '9': { ...PIXEL, owner: { ownedCount: 2 } } }, conversation: { lines, more: false, before: null } },
  });
  const log = page.getByRole('log');
  const gap = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  // on the phone the newest reply stands in the Bubble and its log row is hidden (DS 0.48)
  await expect(page.getByRole('complementary')).toContainText('Start with the chart, then.');
  await expect(log).toContainText('Barely. Big presentation at ten.');
  await setWorker(page, { pets: { '9': ASLEEP }, petState: { events: ['fell_asleep'] } });
  await lookAgain(page);
  await expect(page.getByText('Pixel fell asleep.')).toBeVisible();
  await setWorker(page, {
    pets: { '9': { ...PIXEL, owner: { pendingJob: 'wake-1', pendingMode: 'chat' as const } } },
    petState: { events: ['woke'], friend: 'Maya' },
  });
  await lookAgain(page);
  await expect(page.getByText('Maya fed Pixel.')).toBeVisible();
  await setWorker(page, { petState: { thought: { id: 'w1', text: 'Thanks, Maya! While I slept I dreamed I was a lighthouse for moths. They were very polite.', cut: null } } });
  await expect(page.getByText('Thanks, Maya! While I slept I dreamed').first()).toBeVisible();
  await expect.poll(gap).toBeLessThan(2);
});

// spec: add-pet › Conversation flow › ответ оборван
test('ответ оборван: the reply stops where one thought ends, keeps its «Check this thought», the note under it', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: owned });
  await send(page, 'Tell me a short story about the chart nobody understands.');
  await setWorker(page, { petState: { thought: { id: 'cut1', text: 'Once there was a chart nobody understood. One morning the smallest bar', cut: 'fuse' } } });
  await expect(page.getByText('One morning the smallest bar').first()).toBeVisible();
  await expect(page.getByText("That's as far as one thought goes. Ask Pixel to keep going.")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check this thought' }).last()).toHaveAttribute('href', '/pet/9/verify/cut1');
  // the next thought is a new line
  await expect(page.getByRole('button', { name: 'Send', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet › Deep thought flow › отправлено
test('отправлено: «Think hard» sends the line with reasoning, «Pixel is thinking hard…», then the reply with «Thought hard · {price}»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: owned });
  await expect(page.getByRole('button', { name: 'Think hard · ≈ 0.12¢' })).toBeVisible();
  await field(page).fill('And if they ask why the chart matters?');
  await page.getByRole('button', { name: /Think hard/ }).click();
  expect(await calls(page)).toContain('worker:say:deep');
  await expect(page.getByRole('status').filter({ hasText: 'Pixel is thinking hard…' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Think hard/ })).toHaveAttribute('aria-disabled', 'true');
  await setWorker(page, { petState: { thought: { id: 'd1', text: 'Then say why it matters to them.', cut: null, price: '270000000000000000000', priceCents: 0.13 } } });
  await expect(page.getByText('Then say why it matters to them.').first()).toBeVisible();
  await expect(page.getByText('Thought hard · 0.13¢').first()).toBeVisible();
  await expect(page.getByText('Pixel is thinking hard…')).toHaveCount(0);
});

// spec: add-pet › Deep thought flow › переспрос
test('переспрос: the same «is thinking hard…» without a change, then one reply and its price — no other lines', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: owned });
  await field(page).fill('Think about this');
  await page.getByRole('button', { name: /Think hard/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Pixel is thinking hard…' })).toBeVisible();
  await setWorker(page, { petState: { thought: { id: 'd2', text: 'Short and clear.', cut: null, price: '400000000000000000000', priceCents: 0.21, reasked: true } } });
  await expect(page.getByText('Short and clear.').first()).toBeVisible();
  await expect(page.getByText('Thought hard · 0.21¢').first()).toBeVisible();
  // one reply, no error and no cut note
  // the three replies of the log and the Bubble's copy of the newest (DS 0.48)
  await expect(page.getByRole('link', { name: 'Check this thought' })).toHaveCount(4);
  await expect(page.getByRole('log')).not.toContainText('lost that thought');
  await expect(page.getByRole('log')).not.toContainText("That's as far as one thought goes");
});

// spec: add-pet › Pet condition rule › Голоден
test('Голоден: «Think hard» is inactive with its note, chatting works', async ({ page }) => {
  const hungry = { ...PIXEL, fullness: { state: 'hungry' as const, level: 0.125 } };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...owned, pets: { '9': hungry } } });
  await expect(page.getByText('Hungry', { exact: true })).toBeVisible();
  const deep = page.getByRole('button', { name: /Think hard/ });
  await expect(deep).toHaveAttribute('aria-disabled', 'true');
  await expect(field(page)).toHaveAccessibleDescription('Pixel is too hungry to think hard right now.');
  await field(page).fill('still chatting');
  // an off button keeps its focus and a tap does nothing
  await deep.click({ force: true });
  expect(await calls(page)).not.toContain('worker:say:deep');
  await field(page).press('Enter');
  await expect(page.getByRole('log')).toContainText('still chatting');
  expect(await calls(page)).toContain('worker:say:chat');
});

// spec: add-pet › Sleep and wake flow › разбудил друг при открытой странице
test('разбудил друг при открытой странице: without a reload the pet wakes, «Maya fed Pixel.» and its first thought thanks her', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': ASLEEP } } });
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pixel, asleep' })).toBeVisible();
  const input = field(page);
  await expect(input).toHaveAttribute('aria-disabled', 'true');
  // Maya's meal: the next look sees the food, who fed, and the wake thought on its way
  await setWorker(page, {
    pets: { '9': { ...PIXEL, fullness: { state: 'hungry', level: 0.6 } } },
    petState: { events: ['woke'], friend: 'Maya' },
  });
  await setWorker(page, { pets: { '9': { ...PIXEL, fullness: { state: 'hungry', level: 0.6 }, owner: { pendingJob: 'wake-1', pendingMode: 'chat' } } } });
  await lookAgain(page);
  await expect(page.getByText('Maya fed Pixel.')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Pixel is thinking…' })).toBeVisible();
  await setWorker(page, { petState: { thought: { id: 'w1', text: 'Thanks, Maya! While I slept I dreamed I was a lighthouse for moths.', cut: null } } });
  await expect(page.getByText('Thanks, Maya! While I slept I dreamed').first()).toBeVisible();
  await expect(page.getByText('Maya fed Pixel.')).toHaveCount(1);
  await expect(page.getByRole('img', { name: 'Pixel, hungry' })).toBeVisible();
  await expect(input).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('Pixel is asleep.')).toHaveCount(0);
});
