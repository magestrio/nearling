import { expect, test } from '@playwright/test';
import { calls, HISTORY, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const field = (page: import('@playwright/test').Page, name = /Talk to Pixel…|Say hi to Pixel…/) => page.getByPlaceholder(name);
const ASLEEP = { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 } };
const NEWBORN = { ...PIXEL, stage: 'baby' as const, owner: { hello: true } };

// spec: add-pet › Pet screen › empty
test('empty: «Say hi to Pixel…», the greeting asked for once, «Send» busy and «Pixel is thinking…» until it comes', async ({ page }) => {
  await openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: { owned: ['9'], pets: { '9': NEWBORN }, conversation: { lines: [], more: false, before: null }, petState: { pending: true } },
  });
  await expect(field(page)).toHaveAttribute('placeholder', 'Say hi to Pixel…');
  await expect(page.getByRole('status').filter({ hasText: 'Pixel is thinking…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: /Think hard/ })).toHaveAttribute('aria-disabled', 'true');
  expect((await calls(page)).filter((c) => c === 'worker:greeting')).toHaveLength(1);
  // the greeting arrives with the next look at the job
  await setWorker(page, { petState: { thought: { id: 'g1', text: "Hi! I'm Pixel. I hatched a minute ago.", cut: null } } });
  await expect(page.getByText("Hi! I'm Pixel. I hatched a minute ago.")).toBeVisible();
  await expect(page.getByText('Pixel is thinking…')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send' })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', '/pet/9/verify/g1');
  // the idle looks that follow do not bring it a second time
  await setWorker(page, { petState: {} });
  await lookAgain(page);
  await expect(page.getByText("Hi! I'm Pixel. I hatched a minute ago.")).toHaveCount(1);
});

// spec: add-pet › Pet screen › empty × the owner's first line
test('empty × the owner\'s first line: «Say hi to Pixel…» becomes «Talk to Pixel…», after a reload too (by `hello`)', async ({ page }) => {
  const worker = { owned: ['9'], pets: { '9': NEWBORN }, conversation: { lines: [], more: false, before: null }, greeting: { job: null } };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker });
  await expect(field(page)).toHaveAttribute('placeholder', 'Say hi to Pixel…');
  await field(page).fill('Hello Pixel');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Hello Pixel')).toBeVisible();
  await expect(field(page)).toHaveAttribute('placeholder', 'Talk to Pixel…');
  // the server still says `hello` until the line is stored: the hint stays
  await setWorker(page, { petState: { pending: true } });
  await lookAgain(page);
  await expect(field(page)).toHaveAttribute('placeholder', 'Talk to Pixel…');
  // a reload: the server says `hello: false`
  await setWorker(page, { pets: { '9': { ...PIXEL, owner: { hello: false } } } });
  const state = await page.evaluate(() => (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__);
  await page.addInitScript((s) => {
    (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__ = s;
  }, state);
  await page.reload();
  await expect(field(page)).toHaveAttribute('placeholder', 'Talk to Pixel…');
});

// spec: add-pet › Pet screen › loading
test('loading: «Finding this pet…» in a status region instead of the pet, the field inactive; then the pet', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, delayMs: 1200 } });
  await expect(page.getByRole('status').filter({ hasText: 'Finding this pet…' })).toBeVisible();
  const input = page.getByLabel('Finding this pet…');
  await expect(input).toHaveAttribute('aria-disabled', 'true');
  await expect(input).toHaveAttribute('readonly', '');
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(page.getByText('Finding this pet…')).toHaveCount(0);
});

// spec: add-pet › Pet screen › success (владелец)
test('success (владелец): the pet, the name, the fullness, the conversation, the input and the controls', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
  await expect(page.getByText('Full', { exact: true })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Barely. Big presentation at ten.');
  await expect(field(page)).toHaveAttribute('placeholder', 'Talk to Pixel…');
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Think hard · ≈ 0.12¢' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feed Pixel' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute('href', '/pet/9/diary');
  await expect(page.getByRole('link', { name: 'Wardrobe' })).toHaveAttribute('href', '/pet/9/wardrobe');
  await expect(page.getByRole('button', { name: 'Give Pixel away' })).toBeVisible();
  // only a pet of theirs that has replies has «Check this thought»; the player's line has none
  await expect(page.getByRole('link', { name: 'Check this thought' })).toHaveCount(2);
  await expect(page.getByRole('link', { name: "Check it's really Pixel" }).first()).toHaveAttribute('href', '/pet/9/verify');
  await expect(page.getByRole('button', { name: 'Pause motion' })).toBeVisible();
  // one pet: no «My pets»
  await expect(page.getByRole('button', { name: 'My pets' })).toHaveCount(0);
});

// spec: add-pet › Pet screen › success (владелец)
test('success (владелец): with two pets or more «My pets» stands in the header', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, owner: { ownedCount: 2 } } } } });
  await expect(page.getByRole('button', { name: 'My pets' })).toBeVisible();
});

// spec: add-pet › Pet screen › success (владелец)
test('success (владелец): a line goes into the conversation at once and the reply comes by the job', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  await field(page).fill('And if they ask why?');
  await field(page).press('Enter');
  await expect(page.getByRole('log')).toContainText('And if they ask why?');
  await expect(field(page)).toHaveValue('');
  expect(await calls(page)).toContain('worker:say');
  await expect(page.getByRole('status').filter({ hasText: 'Pixel is thinking…' })).toBeVisible();
  await setWorker(page, { petState: { thought: { id: 't2', text: 'Then say why it matters to them.', cut: null } } });
  await expect(page.getByText('Then say why it matters to them.')).toBeVisible();
  await expect(page.getByText('Pixel is thinking…')).toHaveCount(0);
});

// spec: add-pet › Pet screen › asleep (владелец)
test('asleep (владелец): the field inactive with the typed text, the sleep line, «Feed Pixel» in «Send»\'s place, no rail', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...ASLEEP, owner: { ownedCount: 2 } } } } });
  await expect(page.getByRole('img', { name: 'Pixel, asleep' })).toBeVisible();
  await expect(page.getByText('Asleep', { exact: true })).toBeVisible();
  const input = page.getByPlaceholder('Talk to Pixel…');
  await expect(input).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Think hard/ })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('link', { name: 'Today' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'My pets' })).toBeVisible();
  // the line is the field's note and Tab reaches «Feed Pixel»
  await expect(input).toHaveAccessibleDescription('Pixel is asleep. A meal will wake Pixel up.');
});

// spec: add-pet › Pet screen › asleep (владелец) × a draft in the field, then feeding
test('asleep (владелец) × a draft in the field, then feeding: the text stays, the field comes back active with it', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await field(page).fill('And if they ask why the chart matters?');
  // the food ran out: the next look shows the pet asleep, the line after the thought
  await setWorker(page, { pets: { '9': ASLEEP }, petState: { events: ['fell_asleep'] } });
  await lookAgain(page);
  await expect(page.getByText('Pixel fell asleep.')).toBeVisible();
  await setWorker(page, { petState: {} });
  const input = page.getByPlaceholder('Talk to Pixel…');
  await expect(input).toHaveAttribute('aria-disabled', 'true');
  await expect(input).toHaveValue('And if they ask why the chart matters?');
  await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
  // the focus went to the sleep line
  await expect(page.locator('#pet-sleep-line')).toBeFocused();
  // a meal came: the field is active again with the same text, and it sends
  await setWorker(page, { pets: { '9': PIXEL } });
  await lookAgain(page);
  await expect(input).not.toHaveAttribute('aria-disabled', 'true');
  await expect(input).toHaveValue('And if they ask why the chart matters?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('log')).toContainText('And if they ask why the chart matters?');
  expect(await calls(page)).toContain('worker:say');
});

// spec: add-pet › Pet screen › success (владелец) × питомца подарили при открытой вкладке
test('success (владелец) × питомца подарили при открытой вкладке: the page becomes the guest\'s, no conversation, no field', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('log')).toContainText(HISTORY[1]!.text);
  await field(page).fill('half a line');
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page.getByRole('log')).toHaveCount(0);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveCount(0);
  await expect(page.getByText('Barely. Big presentation at ten.')).toHaveCount(0);
});
