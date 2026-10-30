import { expect, test, type Page } from '@playwright/test';
import { calls, HISTORY, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

// The holes the first review found in the flows between the screens: each test is a Scenario's case the first build
// lost. They run on the fakes, whose shapes `server/test/shapes.test.ts` holds to the real routes.
const field = (page: Page) => page.getByPlaceholder('Talk to Pixel…');
const log = (page: Page) => page.getByRole('log');
const ASLEEP = { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 } };
const OFFLINE = "Can't reach Pixel right now. Nothing's lost — try again in a moment.";
const LOST = 'Pixel lost that thought. Nothing was spent — try again.';
const NOT_FOUND = "We couldn't find this pet. The link may be broken.";
const THINKING = 'Pixel is thinking…';
const onItsWay = { pendingJob: 'job-7', pendingMode: 'chat' as const, pendingKind: 'reply' as const, pendingText: 'Are you still there?' };

async function send(page: Page, text: string) {
  await field(page).fill(text);
  await field(page).press('Enter');
  await expect(log(page)).toContainText(text);
}

// spec: add-pet › Sleep and wake flow › Засыпает
test('Засыпает: the night\'s diary took the last food on an open page: «{name} fell asleep.» appears, once', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(log(page)).toContainText('Start with the chart, then.');
  await setWorker(page, { pets: { '9': ASLEEP }, petState: {} });
  await lookAgain(page);
  await expect(page.getByText('Pixel fell asleep.')).toHaveCount(1);
  await lookAgain(page);
  await page.waitForTimeout(300);
  await expect(page.getByText('Pixel fell asleep.')).toHaveCount(1);
});

// spec: add-pet › Sleep and wake flow › Засыпает
test('Засыпает: the line of the job and the line of the poll are one line', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, 'One more thing');
  await setWorker(page, { pets: { '9': ASLEEP }, petState: { pending: true } });
  await lookAgain(page);
  await expect(page.getByText('Pixel fell asleep.')).toHaveCount(1);
  await setWorker(page, { petState: { pending: false, thought: { id: 't1', text: 'Good night.', cut: null }, events: ['fell_asleep'] } });
  await lookAgain(page);
  await expect(log(page)).toContainText('Good night.');
  await expect(page.getByText('Pixel fell asleep.')).toHaveCount(1);
});

// spec: add-pet › Connection rule › сервер недоступен
test('сервер недоступен: a job whose row is gone after a long hidden tab is no dead link: the pet stays, the conversation is read again', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, 'See you tomorrow');
  await expect(page.getByText(THINKING)).toBeVisible();
  const answered = { id: 't9', who: 'pet', text: 'See you!', at: 9 };
  const mine = { id: 't9:you', who: 'player', text: 'See you tomorrow', at: 9 };
  await setWorker(page, { petState: { fail: { status: 404, code: 'no_job' } }, conversation: { lines: [...HISTORY, mine, answered], more: false, before: null } });
  await lookAgain(page);
  await expect(log(page)).toContainText('See you!');
  await expect(page.getByText(THINKING)).toHaveCount(0);
  await expect(page.getByText(NOT_FOUND)).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  // the line is the server's now, shown once
  await expect(log(page).getByText('See you tomorrow')).toHaveCount(1);
});

// spec: add-pet › Connection rule › AI-провайдер недоступен
test('AI-провайдер недоступен: «Try again» sends the failed line and leaves what was typed since in the field', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, 'The first line');
  await setWorker(page, { petState: { pending: false, code: 'ai_unavailable' } });
  await lookAgain(page);
  await expect(page.getByText(LOST)).toBeVisible();
  await setWorker(page, { petState: { pending: true } });
  await field(page).fill('Something newer');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(log(page)).toContainText('The first line');
  await expect(page.getByText(THINKING)).toBeVisible();
  await expect(field(page)).toHaveValue('Something newer');
});

// spec: add-pet › Connection rule › AI-провайдер недоступен
test('AI-провайдер недоступен: a retry that fails keeps both lines: the new one in the field, the old one with its «Try again»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await send(page, 'The first line');
  await setWorker(page, { petState: { pending: false, code: 'ai_unavailable' } });
  await lookAgain(page);
  await expect(page.getByText(LOST)).toBeVisible();
  await setWorker(page, { say: { fail: { status: 503, code: 'chain_unreachable' } } });
  await field(page).fill('Something newer');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  await expect(field(page)).toHaveValue('Something newer');
  await expect(log(page)).toContainText('The first line');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

// spec: add-pet › Connection rule › AI-провайдер недоступен
test('AI-провайдер недоступен: a reply found again after a reload that fails is sent again, not taken for a greeting', async ({ page }) => {
  await openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: { ...OWNER, pets: { '9': { ...PIXEL, owner: onItsWay } }, petState: { pending: true } },
  });
  await expect(log(page)).toContainText('Are you still there?');
  await expect(page.getByText(THINKING)).toBeVisible();
  await setWorker(page, { petState: { pendingJob: null, pending: false, code: 'ai_unavailable', jobKind: 'reply' } });
  await lookAgain(page);
  await expect(page.getByText(LOST)).toBeVisible();
  await expect(log(page)).toContainText('Are you still there?');
  await setWorker(page, { petState: { pendingJob: null, pending: true } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(THINKING)).toBeVisible();
  const asked = await calls(page);
  expect(asked).toContain('worker:say');
  expect(asked).not.toContain('worker:greeting');
});

// spec: add-pet › Conversation flow › Ответ
test('Ответ: a reload in the middle of a thought keeps the player\'s line in the conversation when the reply comes', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, owner: onItsWay } }, petState: { pending: true } } });
  await expect(log(page)).toContainText('Are you still there?');
  await setWorker(page, { petState: { pendingJob: null, pending: false, thought: { id: 't2', text: 'Always.', cut: null } } });
  await lookAgain(page);
  await expect(log(page)).toContainText('Always.');
  await expect(log(page).getByText('Are you still there?')).toHaveCount(1);
});

// spec: add-pet › Connection rule › AI-провайдер недоступен
test('AI-провайдер недоступен: a wake thought that failed is asked for again', async ({ page }) => {
  await openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: { ...OWNER, pets: { '9': { ...PIXEL, owner: { pendingJob: 'job-w', pendingMode: 'chat' as const, pendingKind: 'wake' as const } } }, petState: { pending: true } },
  });
  await expect(page.getByText(THINKING)).toBeVisible();
  await setWorker(page, { petState: { pendingJob: null, pending: false, code: 'ai_unavailable', jobKind: 'wake' } });
  await lookAgain(page);
  await expect(page.getByText(LOST)).toBeVisible();
  await setWorker(page, { petState: { pendingJob: null, pending: true } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(THINKING)).toBeVisible();
  const asked = await calls(page);
  expect(asked).toContain('worker:retryWake');
  expect(asked).not.toContain('worker:greeting');
  expect(asked).not.toContain('worker:say');
});

// spec: add-pet › Thought queue data › параллельные запросы ждут очереди × вторая вкладка шлёт реплику
test('× вторая вкладка шлёт реплику: an open tab shows the other tab\'s line, the thinking line and the reply', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(log(page)).toContainText('Start with the chart, then.');
  await setWorker(page, { petState: { ...onItsWay, pending: true } });
  await lookAgain(page);
  await expect(log(page)).toContainText('Are you still there?');
  await expect(page.getByText(THINKING)).toBeVisible();
  await setWorker(page, { petState: { pendingJob: null, pending: false, thought: { id: 't3', text: 'Right here.', cut: null } } });
  await lookAgain(page);
  await expect(log(page)).toContainText('Right here.');
  await expect(page.getByText(THINKING)).toHaveCount(0);
});

// spec: add-pet › Thought queue data › параллельные запросы ждут очереди × вторая вкладка шлёт реплику
test('× вторая вкладка шлёт реплику: a thought that came and went between two looks is read from the conversation', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(log(page)).toContainText('Start with the chart, then.');
  const later = [{ id: 't4:you', who: 'player', text: 'From my phone', at: 4 }, { id: 't4', who: 'pet', text: 'Hello, phone.', at: 4 }];
  await setWorker(page, { petState: { lastThought: 't4' }, conversation: { lines: [...HISTORY, ...later], more: false, before: null } });
  await lookAgain(page);
  await expect(log(page)).toContainText('Hello, phone.');
  await expect(log(page)).toContainText('From my phone');
});

// spec: add-pet › Connection rule › сервер недоступен
test('сервер недоступен: a line whose answer was lost but which reached the server leaves the field and is not sent twice', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, say: { fail: { status: 0, code: 'unreachable' } } } });
  await field(page).fill('Are you still there?');
  await field(page).press('Enter');
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  await expect(field(page)).toHaveValue('Are you still there?');
  // the next look finds the job: the line went after all
  await setWorker(page, { petState: { ...onItsWay, pending: true } });
  await lookAgain(page);
  await expect(page.getByText(THINKING)).toBeVisible();
  await expect(log(page)).toContainText('Are you still there?');
  await expect(field(page)).toHaveValue('');
  await expect(page.getByText(OFFLINE)).toHaveCount(0);
});

// spec: add-pet › Pet screen › error
for (const route of ['/pet/abc', '/pet', '/pet/123456789012345678901']) {
  test(`error: the cut link ${route} is the dead-link page, with no request`, async ({ page }) => {
    await openWith(page, route, { auth: SIGNED_IN, worker: OWNER });
    await expect(page.getByRole('heading', { level: 1, name: NOT_FOUND })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
    expect(await calls(page)).not.toContain('worker:pet');
  });
}

// spec: add-pet › Pet screen › error
test('error: the outcome of «Finding this pet…» is heard', async ({ page }) => {
  await openWith(page, '/pet/77', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('status').filter({ hasText: NOT_FOUND })).toHaveCount(1);
});

// spec: add-pet › Connection rule › сервер недоступен
test('сервер недоступен: «We can\'t reach the game…» is heard, by the region that said «Finding this pet…»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, delayMs: 300, petResult: { fail: { status: 503, code: 'chain_unreachable' } } } });
  const region = page.getByRole('status').filter({ hasText: 'Finding this pet…' });
  await expect(region).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: "We can't reach the game right now. Try again in a moment." })).toHaveCount(1);
});

// spec: add-pet › Sleep and wake flow › разбудил друг при открытой странице
test('разбудил друг при открытой странице: the field keeps the focus while it is off, and still has it when the pet wakes', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(log(page)).toContainText('Start with the chart, then.');
  await setWorker(page, { pets: { '9': ASLEEP }, petState: {} });
  await lookAgain(page);
  await expect(field(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(field(page)).toBeFocused();
  await setWorker(page, { pets: { '9': PIXEL }, petState: { events: ['woke'], friend: 'Maya' } });
  await lookAgain(page);
  await expect(page.getByText('Maya fed Pixel.')).toBeVisible();
  await expect(field(page)).toBeFocused();
});

// spec: add-pet › Hatch screen › signed-out
test('signed-out: a session that ended is «Sign in with Google…» at once, not a form that fails at the tap', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { sessionExpired: true } });
  await expect(page.getByRole('button', { name: 'Sign in with Google to hatch your pet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hatch my pet' })).toHaveCount(0);
});

// spec: add-pet › Service pause data › пауза снялась
test('пауза снялась: the page\'s repeat marks itself a look (`?look=1`); the load is the one call that does not', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'service' } } });
  await expect(page.getByText('New pets are paused for now. You can still feed and visit pets you know.').first()).toBeVisible();
  expect(await calls(page)).not.toContain('worker:hatchStatus:look');
  const looks = async () => (await calls(page)).filter((c) => c === 'worker:hatchStatus:look').length;
  await expect.poll(looks, { timeout: 9000 }).toBeGreaterThan(0);
  expect((await calls(page)).filter((c) => c === 'worker:hatchStatus').length).toBeGreaterThan(await looks());
});

// spec: add-pet › Service pause data › пауза снялась
test('пауза снялась: the closed Hatch screen opens by itself, with the name still there', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'service' } } });
  await expect(page.getByText('New pets are paused for now. You can still feed and visit pets you know.').first()).toBeVisible();
  await page.getByLabel('Name your pet').fill('Pixel');
  await setWorker(page, { hatchStatus: { open: true } });
  await expect(page.getByRole('button', { name: 'Hatch my pet' })).toBeEnabled();
  await expect(page.getByLabel('Name your pet')).toHaveValue('Pixel');
  await expect(page.getByText('New pets are paused for now. You can still feed and visit pets you know.')).toHaveCount(0);
});

// spec: add-pet › Hatch screen › рождения на сегодня закрыты
test('рождения на сегодня закрыты: the day\'s 50 say their own hour: the page does not keep asking', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily', until: '2026-11-02T00:00:00.000Z' } } });
  await expect(page.getByText(/That's all the new pets for today/).first()).toBeVisible();
  const asked = async () => (await calls(page)).filter((c) => c === 'worker:hatchStatus').length;
  const atLoad = await asked();
  await page.waitForTimeout(5600);
  expect(await asked()).toBe(atLoad);
});

// spec: add-pet › Birth flow › вылупился
test('вылупился: the tap is heard: «Hatching…» is said by the page\'s region, wherever the focus is', async ({ page }) => {
  await openWith(page, '/hatch', { auth: SIGNED_IN, worker: { hatchDelayMs: 2000 } });
  await page.getByLabel('Name your pet').fill('Pixel');
  await page.getByLabel('Name your pet').press('Enter');
  await expect(page.getByLabel('Name your pet')).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Hatching…' })).toHaveCount(1);
});
