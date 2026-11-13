import { expect, test } from '@playwright/test';
import { calls, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const OFFLINE = "Can't reach Pixel right now. Nothing's lost — try again in a moment.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';
const NOT_REACHABLE = "We can't reach the game right now. Try again in a moment.";
const down = { fail: { status: 503, code: 'chain_unreachable' } };
const tooMany = { fail: { status: 429, code: 'rate_limited' } };

// spec: add-pet › Connection rule › сервер недоступен
test('сервер недоступен: nothing to show — «We can\'t reach the game right now…» and «Try again», not the dead-link page', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petResult: down } });
  await expect(page.getByRole('heading', { level: 1, name: NOT_REACHABLE })).toBeVisible();
  await expect(page.getByText("We couldn't find this pet.")).toHaveCount(0);
  await setWorker(page, { petResult: undefined });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
});

// spec: add-pet › Connection rule › сервер недоступен × связь пропала посреди игры
test('сервер недоступен × связь пропала посреди игры: the last known pet and the line over it; it goes with the next answer', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await setWorker(page, { petState: down });
  await lookAgain(page);
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await setWorker(page, { petState: {} });
  await lookAgain(page);
  await expect(page.getByText(OFFLINE)).toHaveCount(0);
});

// spec: add-pet › Connection rule › сервер недоступен × черновик в поле
test('сервер недоступен × черновик в поле: a line the server did not take stays in the field and leaves the conversation', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, say: down } });
  const field = page.getByPlaceholder('Talk to Pixel…');
  await field.fill('are you there?');
  // the server stays down for the polls after the tap: the line stays up while the assertions look (a successful poll
  // would clear it, and a slow machine can look late)
  await setWorker(page, { petState: down });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  await expect(field).toHaveValue('are you there?');
  await expect(page.getByRole('log')).not.toContainText('are you there?');
  // and it can be sent once the server answers
  await setWorker(page, { say: undefined, petState: {} });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('are you there?');
  await expect(field).toHaveValue('');
});

// spec: add-pet › Connection rule › слишком много запросов
test('слишком много запросов: «Lots of visitors right now. Try again in a minute.» and «Try again» with nothing to show', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petResult: tooMany } });
  await expect(page.getByRole('heading', { level: 1, name: BUSY })).toBeVisible();
  await setWorker(page, { petResult: undefined });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
});

// spec: add-pet › Connection rule › слишком много запросов × черновик в поле
test('слишком много запросов × черновик в поле: the pet stays as shown, the line over it, the typed text kept; «Try again» asks again', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  const field = page.getByPlaceholder('Talk to Pixel…');
  await field.fill('And if they ask why?');
  await setWorker(page, { petState: tooMany });
  await lookAgain(page);
  await expect(page.getByText(BUSY).first()).toBeVisible();
  await expect(field).toHaveValue('And if they ask why?');
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await setWorker(page, { petState: {} });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(BUSY)).toHaveCount(0);
  await expect(field).toHaveValue('And if they ask why?');
});

const field = (page: import('@playwright/test').Page) => page.getByPlaceholder('Talk to Pixel…');
const PAUSED_LINE = 'Chatting is paused on our side while we top up. Your message is kept — Pixel will be back soon.';
const withOwner = (owner: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
  ...OWNER,
  pets: { '9': { ...PIXEL, owner } },
  ...rest,
});

// spec: add-pet › Connection rule › AI-провайдер недоступен
test('AI-провайдер недоступен: «Pixel lost that thought. Nothing was spent — try again.», the line stays, «Try again» asks again', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await field(page).fill('Tell me a story');
  await field(page).press('Enter');
  await setWorker(page, { petState: { code: 'ai_unavailable' } });
  await expect(page.getByText('Pixel lost that thought. Nothing was spent — try again.')).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Tell me a story');
  // «Try again» sends the same line again, once; the failed attempt leaves no second copy
  await setWorker(page, { petState: { thought: { id: 't1', text: 'Once upon a time.', cut: null } } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('log').getByText('Once upon a time.')).toBeVisible();
  await expect(page.getByText('Pixel lost that thought.')).toHaveCount(0);
  await expect(page.getByRole('log').getByText('Tell me a story')).toHaveCount(1);
  expect((await calls(page)).filter((c) => c === 'worker:say:chat')).toHaveLength(2);
});

// spec: add-pet › Connection rule › пустой ответ за счёт питомца
test('пустой ответ за счёт питомца: «…it still used a little food. Your message is kept — try again.» and «Try again»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await field(page).fill('Say something');
  await field(page).press('Enter');
  await setWorker(page, { petState: { code: 'empty_paid' } });
  await expect(page.getByText('Pixel lost that thought, but it still used a little food. Your message is kept — try again.')).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Say something');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

// spec: add-pet › Connection rule › разговор на паузе
test('разговор на паузе: the line over the page, the field and the buttons inactive, nothing sent', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withOwner({ paused: true }) });
  await expect(page.getByText(PAUSED_LINE).first()).toBeVisible();
  await expect(field(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: /Think hard/ })).toHaveAttribute('aria-disabled', 'true');
  await field(page).press('Enter');
  expect(await calls(page)).not.toContain('worker:say');
});

// spec: add-pet › Connection rule › разговор на паузе × черновик в поле
test('разговор на паузе × черновик в поле: a pause that comes while a line is typed leaves it in the inactive field; a refused send puts it back', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await field(page).fill('And if they ask why?');
  await setWorker(page, { pets: { '9': { ...PIXEL, owner: { paused: true } } } });
  await lookAgain(page);
  await expect(page.getByText(PAUSED_LINE).first()).toBeVisible();
  await expect(field(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(field(page)).toHaveValue('And if they ask why?');
});

// spec: add-pet › Connection rule › разговор на паузе × черновик в поле
test('разговор на паузе × черновик в поле: a send the server refuses for the pause leaves the line in the field and says why', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, say: { fail: { status: 409, code: 'paused' } } } });
  await field(page).fill('Are you there?');
  await field(page).press('Enter');
  await expect(page.getByText(PAUSED_LINE).first()).toBeVisible();
  await expect(field(page)).toHaveValue('Are you there?');
  await expect(page.getByRole('log')).not.toContainText('Are you there?');
  await expect(field(page)).toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet › Service pause data › пауза снялась × открытый экран, реплика не отправлена
test('пауза снялась × открытый экран, реплика не отправлена: the line goes, the field is active, the saved line stays and is not sent', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withOwner({ paused: true }) });
  await expect(page.getByText(PAUSED_LINE).first()).toBeVisible();
  await setWorker(page, { pets: { '9': { ...PIXEL, owner: { paused: false } } } });
  await lookAgain(page);
  await expect(page.getByText(PAUSED_LINE)).toHaveCount(0);
  await expect(field(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
  expect(await calls(page)).not.toContain('worker:say');
});

// spec: add-pet › Daily cap rule › Устал
test('Устал: «Pixel is tired for today. Back at {time}.», the field and the buttons inactive, feeding works', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withOwner({ tired: true, until: '2026-11-02T00:00:00.000Z' }) });
  await expect(page.getByText(/^Pixel is tired for today\. Back at \d\d:\d\d\.$/).first()).toBeVisible();
  await expect(field(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: /Think hard/ })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Feed Pixel' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Pixel' }).first()).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet › Daily cap rule › Устал × 00:00 UTC без перезагрузки
test('Устал × 00:00 UTC без перезагрузки: the line goes with the next look, the field is active again with the typed text', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: withOwner({ tired: true, until: '2026-11-02T00:00:00.000Z' }) });
  await expect(page.getByText(/is tired for today/).first()).toBeVisible();
  await setWorker(page, { pets: { '9': { ...PIXEL, owner: { tired: false } } } });
  await lookAgain(page);
  await expect(page.getByText(/is tired for today/)).toHaveCount(0);
  await expect(field(page)).not.toHaveAttribute('aria-disabled', 'true');
  await field(page).fill('Good morning');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Good morning');
});
