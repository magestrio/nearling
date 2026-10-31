import { expect, test, type Page } from '@playwright/test';
import { BISCUIT, calls, drawn, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

const OFFLINE = "Can't reach Pixel right now. Nothing's lost — try again in a moment.";
const ERROR = "We couldn't open Pixel's diary right now. Try again in a moment.";
const SIGNED_OUT = "You've been signed out. Sign in to get back to Pixel's diary.";
const DOWN = { fail: { status: 0, code: 'unreachable' } };
const SAMPLE_DAY = 20_757;
const ASLEEP = { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 } };

const riddleField = (page: Page) => page.getByLabel("What has hands but can't clap?");
const answerField = (page: Page) => page.getByLabel('Did the chart surprise anyone?');
const sendRiddle = (page: Page) => page.getByRole('button', { name: 'Send answer' });
const answerButton = (page: Page) => page.getByRole('button', { name: 'Answer Pixel' });
const diaryCalls = async (page: Page) => (await calls(page)).filter((c) => c === 'worker:diary').length;
const marks = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('worker:readDiary:'));
const PHONE = { width: 390, height: 844 };
const scrolled = (page: Page) => page.evaluate(() => window.scrollY);

/** The page's clock stands in the sample diary's day (2026-10-31), so the Worker's diary is of today for it. */
const inSampleDay = (page: Page, at = '12:00:00') => page.clock.install({ time: new Date(`2026-10-31T${at}Z`) });

/** The owner's Diary on the sample day. */
async function openDiary(page: Page, diary: Record<string, unknown> = {}, worker: Record<string, unknown> = {}, at?: string) {
  await inSampleDay(page, at);
  await openWith(page, '/pet/9/diary', { auth: SIGNED_IN, worker: { ...OWNER, ...worker, diary } });
}

// spec: add-daily-ritual › Diary screen › success
test('success: the streak, the entry with its question, the riddle with its field, and «Back to Pixel» in the header', async ({ page }) => {
  await openDiary(page);
  await expect(page.getByRole('heading', { level: 1, name: "Pixel's diary" })).toBeAttached();
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await expect(page.getByText('I think the fridge is getting nervous about your presentation too.')).toBeVisible();
  await expect(page.getByText('Did the chart surprise anyone?').first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: "What has hands but can't clap?" })).toBeVisible();
  await expect(page.getByText('Up to 40 characters.')).toBeVisible();
  await expect(page.getByText('You solved the riddle that closed at', { exact: false })).toContainText('It was "a piano".');
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toHaveAttribute('href', '/pet/9');
});

const FIRST_LINE = /Pixel writes its first diary entry at \d\d:\d\d\. Come back after that to read it!/;
const CLEARED_LINE = /You cleared Pixel's memory, so its latest diary entry is gone\. Pixel writes a fresh one at \d\d:\d\d\./;
const BORN_TODAY = {
  entry: { kind: 'first' as const },
  yesterday: { kind: 'none' as const, answer: 'a piano' },
  streak: { days: 0, freezes: 1, done: false, line: null, n: 0, k: 1, missed: 0, note: [] },
  parts: ['riddle'],
};

/** «Back to Pixel» and «Account» work in this state of the screen */
async function headerWorks(page: Page) {
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toHaveAttribute('href', '/pet/9');
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

// spec: add-daily-ritual › Diary screen › empty
test('empty: the pet\'s first entry comes at {time}, no question, Streak: 0 days, the riddle as in success', async ({ page }) => {
  await openDiary(page, BORN_TODAY);
  await expect(page.getByText(FIRST_LINE)).toBeVisible();
  await expect(page.getByText('Streak: 0 days · Freezes: 1')).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: "What has hands but can't clap?" })).toBeVisible();
  // yesterday's riddle had no answer from this owner
  await expect(page.getByText('The riddle that closed at', { exact: false })).toContainText('the answer was "a piano".');
});

// spec: add-daily-ritual › Diary screen › empty × controls
test('empty × controls: «Back to Pixel» and Account work; the riddle field and «Send answer» are as in success', async ({ page }) => {
  await openDiary(page, BORN_TODAY);
  await expect(page.getByText(FIRST_LINE)).toBeVisible();
  await headerWorks(page);
  await expect(riddleField(page)).toHaveAttribute('maxlength', '40');
  await expect(sendRiddle(page)).toHaveAttribute('aria-disabled', 'true');
  await riddleField(page).fill('a clock');
  await expect(sendRiddle(page)).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-daily-ritual › Diary screen › память стёрта сегодня
test('память стёрта сегодня: the entry is gone with the words of the spec, no question, the riddle answered before is «Answered today» with no field', async ({ page }) => {
  await openDiary(page, {
    entry: { kind: 'cleared' },
    riddle: { kind: 'answered', day: SAMPLE_DAY, text: "What has hands but can't clap?", answer: null },
    yesterday: { kind: 'none', answer: 'a piano' },
    streak: { days: 2, freezes: 1, done: true, line: null, n: 2, k: 1, missed: 0, note: ['saving'] },
    parts: [],
    complete: true,
  });
  await expect(page.getByText(CLEARED_LINE)).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
  await expect(page.getByText('Answered today')).toBeVisible();
  await expect(riddleField(page)).toHaveCount(0);
  await expect(sendRiddle(page)).toHaveCount(0);
  await expect(page.getByText('Saving your streak…')).toBeVisible();
  await expect(page.getByText('All done for today!')).toBeVisible();
});

// spec: add-daily-ritual › Diary screen › память стёрта сегодня × controls
test('память стёрта сегодня × controls: «Back to Pixel» and Account work, and the answered riddle has no control of its own', async ({ page }) => {
  await openDiary(page, {
    entry: { kind: 'cleared' },
    riddle: { kind: 'answered', day: SAMPLE_DAY, text: "What has hands but can't clap?", answer: null },
    parts: [],
    complete: true,
  });
  await expect(page.getByText(CLEARED_LINE)).toBeVisible();
  await headerWorks(page);
  await expect(page.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
});

// spec: add-daily-ritual › Diary screen › loading
test('loading: «Opening Pixel\'s diary…» and the answer fields inactive, until the diary comes', async ({ page }) => {
  await openDiary(page, {}, { diaryDelayMs: 1500 });
  await expect(page.getByRole('status').filter({ hasText: "Opening Pixel's diary…" }).first()).toBeVisible();
  await expect(page.getByLabel("Opening Pixel's diary…").first()).toHaveAttribute('aria-disabled', 'true');
  await expect(answerButton(page)).toBeDisabled();
  await expect(sendRiddle(page)).toBeDisabled();
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await expect(page.getByText("Opening Pixel's diary…")).toHaveCount(0);
});

// spec: add-daily-ritual › Diary screen › loading × controls
test('loading × controls: «Back to Pixel» and Account work while the answer fields are inactive', async ({ page }) => {
  await openDiary(page, {}, { diaryDelayMs: 4000 });
  await expect(page.getByRole('status').filter({ hasText: "Opening Pixel's diary…" }).first()).toBeVisible();
  await expect(answerButton(page)).toBeDisabled();
  await expect(sendRiddle(page)).toBeDisabled();
  await headerWorks(page);
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
});

// spec: add-daily-ritual › Diary screen › error
test('error: the line and «Try again» when the first load fails, with no fields for a diary nobody has seen', async ({ page }) => {
  await openDiary(page, DOWN);
  await expect(page.getByText(ERROR)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
  await expect(riddleField(page)).toHaveCount(0);
});

// spec: add-daily-ritual › Diary screen › error × controls
test('error × controls: «Back to Pixel» and Account work beside «Try again»', async ({ page }) => {
  await openDiary(page, DOWN);
  await expect(page.getByText(ERROR)).toBeVisible();
  await headerWorks(page);
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
});

// spec: add-daily-ritual › Diary screen › error × try again
test('error × try again: it loads again, and the diary replaces the line', async ({ page }) => {
  await openDiary(page, DOWN);
  await expect(page.getByText(ERROR)).toBeVisible();
  const before = await diaryCalls(page);
  await setWorker(page, { diary: {} });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('I think the fridge is getting nervous about your presentation too.')).toBeVisible();
  await expect(page.getByText(ERROR)).toHaveCount(0);
  expect(await diaryCalls(page)).toBeGreaterThan(before);
  // and a second failure brings the line back
  await setWorker(page, { diary: DOWN });
  await page.clock.fastForward(5_100);
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
});

// spec: add-daily-ritual › Diary screen › error × a poll failed over the shown diary
test('error × a poll failed over the shown diary: the connection line over it, the same day on screen, the typed text where it was', async ({ page }) => {
  await openDiary(page);
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await answerField(page).fill('It did — the CFO laughed.');
  await riddleField(page).fill('a clock');
  await setWorker(page, { diary: DOWN });
  await lookAgain(page);
  await expect(page.getByText(OFFLINE).first()).toBeVisible();
  await expect(page.getByText(ERROR)).toHaveCount(0);
  await expect(page.getByText('I think the fridge is getting nervous about your presentation too.')).toBeVisible();
  await expect(answerField(page)).toHaveValue('It did — the CFO laughed.');
  await expect(riddleField(page)).toHaveValue('a clock');
  // the connection is back: the line goes with the next look
  await setWorker(page, { diary: {} });
  await lookAgain(page);
  await expect(page.getByText(OFFLINE)).toHaveCount(0);
});

// spec: add-daily-ritual › Diary screen › error × 00:00 UTC, the load failed
test('error × 00:00 UTC, the load failed: «error» over the last known diary, the typed text stays', async ({ page }) => {
  await openDiary(page, {}, {}, '23:59:50');
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await answerField(page).fill('It did — the CFO laughed.');
  await riddleField(page).fill('a clock');
  await setWorker(page, { diary: DOWN });
  await page.clock.fastForward(15_000);
  await expect(page.getByText(ERROR)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  // the last known diary stands under it with what was typed
  await expect(page.getByText('I think the fridge is getting nervous about your presentation too.')).toBeVisible();
  await expect(answerField(page)).toHaveValue('It did — the CFO laughed.');
  await expect(riddleField(page)).toHaveValue('a clock');
  await expect(page.getByText(OFFLINE)).toHaveCount(0);
});

// spec: add-daily-ritual › Diary screen › error × the page scrolled down, no field in focus
test('error × the page scrolled down, no field in focus: the line and «Try again» come into view, and no control takes the focus', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openDiary(page, {}, {}, '23:59:50');
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await riddleField(page).fill('a clock');
  await riddleField(page).blur();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await scrolled(page)).toBeGreaterThan(0);
  await setWorker(page, { diary: DOWN });
  await page.clock.fastForward(15_000);
  await expect(page.getByText(ERROR)).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Try again' })).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

// spec: add-daily-ritual › Diary screen › error × a field holds the focus
test('error × a field holds the focus: the page stays where it is, so typing is not interrupted', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openDiary(page, {}, {}, '23:59:50');
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await riddleField(page).fill('a clock');
  const at = await scrolled(page);
  expect(at).toBeGreaterThan(0);
  await setWorker(page, { diary: DOWN });
  await page.clock.fastForward(15_000);
  await expect(page.getByText(ERROR)).toBeVisible();
  await expect(riddleField(page)).toBeFocused();
  expect(await scrolled(page)).toBe(at);
});

// spec: add-daily-ritual › Diary screen › signed-out × the page scrolled down to the riddle
test('signed-out × the page scrolled down to the riddle: the line and «Sign in» come into view and the focus moves to «Sign in»', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openDiary(page);
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await riddleField(page).fill('a clock');
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await sendRiddle(page).scrollIntoViewIfNeeded();
  expect(await scrolled(page)).toBeGreaterThan(0);
  await sendRiddle(page).click();
  const signIn = page.getByRole('button', { name: 'Sign in' });
  await expect(signIn).toBeFocused();
  await expect(signIn).toBeInViewport();
  await expect(page.getByText(SIGNED_OUT).first()).toBeInViewport();
  await expect(riddleField(page)).toHaveValue('a clock');
});

// spec: add-daily-ritual › Diary screen › success × controls
test('success × controls: «Back to Pixel» leads to the Pet screen, Account opens its menu, the riddle field takes 40 characters and no more', async ({ page }) => {
  await openDiary(page);
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await headerWorks(page);
  await expect(riddleField(page)).toHaveAttribute('maxlength', '40');
  await expect(sendRiddle(page)).toHaveAttribute('aria-disabled', 'true');
  await riddleField(page).fill('   ');
  await expect(sendRiddle(page)).toHaveAttribute('aria-disabled', 'true');
  await riddleField(page).fill('x'.repeat(60));
  await expect(riddleField(page)).toHaveValue('x'.repeat(40));
  await expect(sendRiddle(page)).not.toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
});

// spec: add-daily-ritual › Diary screen › success × the address without a session and as a guest
test('success × the address without a session and as a guest: the Pet screen\'s page for them, the address kept, no diary asked for', async ({ page }) => {
  await inSampleDay(page);
  await openWith(page, '/pet/9/diary', { worker: { ...OWNER, owned: [] } });
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  await expect(page.getByText('Streak:', { exact: false })).toHaveCount(0);
  expect(await diaryCalls(page)).toBe(0);
});

// spec: add-daily-ritual › Diary screen › success × the address without a session and as a guest
test('success × the address as a guest: a signed-in player who is not the owner gets the guest\'s page at the same address', async ({ page }) => {
  await inSampleDay(page);
  await openWith(page, '/pet/2/diary', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': PIXEL, '2': BISCUIT } } });
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/2\/diary$/);
  expect(await diaryCalls(page)).toBe(0);
});

// spec: add-daily-ritual › Diary screen › success × the pet given away (403)
// spec: add-daily-ritual › Ritual data › typed riddle answer × a pet given away erases it
test('success × the pet given away (403): the page reads the pet again and is a guest\'s now', async ({ page }) => {
  await openDiary(page);
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await riddleField(page).fill('a clock');
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page.getByText('Streak:', { exact: false })).toHaveCount(0);
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  // the riddle answer typed for the pet goes with the owner's page
  expect(await page.evaluate(() => sessionStorage.getItem('nearling.riddleDraft.9'))).toBeNull();
});

// spec: add-daily-ritual › Diary screen › success × tab hidden and back
test('success × tab hidden and back: no read while the tab is hidden, one at once on the way back', async ({ page }) => {
  await openDiary(page);
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  const hiddenAt = await diaryCalls(page);
  await page.clock.fastForward(12_000);
  expect(await diaryCalls(page)).toBe(hiddenAt);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => diaryCalls(page)).toBe(hiddenAt + 1);
});

// spec: add-daily-ritual › Diary screen › success × the address with a pet asleep
test('success × the address with a pet asleep: the Pet screen at its own address, no diary asked for and no mark sent', async ({ page }) => {
  await inSampleDay(page);
  await openWith(page, '/pet/9/diary', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': ASLEEP, '2': BISCUIT } } });
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
  expect(await diaryCalls(page)).toBe(0);
  expect(await marks(page)).toEqual([]);
});

// spec: add-daily-ritual › Daily ritual flow › встречает дневником × read at any opening, by itself, «Today» or the address
test('the read mark goes with each opening and once for a day while it stands, and once more when the entry appears', async ({ page }) => {
  await openDiary(page, { entry: { kind: 'writing' }, parts: ['riddle'] });
  await expect(drawn(page, 'Pixel is writing its diary…')).toBeVisible();
  await expect.poll(() => marks(page)).toEqual([`worker:readDiary:${SAMPLE_DAY}`]);
  // the polls go on and send nothing more for the same day with no entry
  await page.clock.fastForward(11_000);
  expect(await marks(page)).toHaveLength(1);
  // the entry appears on the open screen: the mark is sent again
  await setWorker(page, { diary: {} });
  await page.clock.fastForward(5_100);
  await expect(drawn(page, 'I think the fridge is getting nervous about your presentation too.')).toBeVisible();
  await expect.poll(() => marks(page)).toHaveLength(2);
  await page.clock.fastForward(11_000);
  expect(await marks(page)).toHaveLength(2);
});

// spec: add-daily-ritual › Daily ritual flow › встречает дневником × the read mark failed
test('the read mark that failed is sent again by the next poll, and the screen stays as it is', async ({ page }) => {
  await openDiary(page, {}, { readDiary: DOWN });
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await expect.poll(() => marks(page)).toHaveLength(1);
  await setWorker(page, { readDiary: { ok: true } });
  await page.clock.fastForward(5_100);
  await expect.poll(() => marks(page)).toHaveLength(2);
  await page.clock.fastForward(11_000);
  expect(await marks(page)).toHaveLength(2);
  await expect(page.getByText(OFFLINE)).toHaveCount(0);
});

// spec: add-daily-ritual › Diary screen › signed-out
test('signed-out: the session ended, a tap on «Send answer» shows the line and «Sign in», sends nothing and keeps the typed answers', async ({ page }) => {
  await openDiary(page);
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await answerField(page).fill('It did — the CFO laughed.');
  await riddleField(page).fill('a clock');
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  // the session ended: nothing on the page changes until a tap needs it
  await expect(page.getByText(SIGNED_OUT)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await sendRiddle(page).click();
  await expect(page.getByText(SIGNED_OUT).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
  await expect(riddleField(page)).toHaveValue('a clock');
  await expect(answerField(page)).toHaveValue('It did — the CFO laughed.');
  // the one primary is «Sign in»: «Answer Pixel» is secondary
  await expect(answerButton(page)).toHaveClass(/ds-button--secondary/);
  await expect(page.getByRole('alert').filter({ hasText: SIGNED_OUT })).toBeAttached();
  const sent = (await calls(page)).filter((c) => c.startsWith('worker:answer'));
  expect(sent).toEqual([]);
});

// spec: add-daily-ritual › Diary screen › signed-out × send tapped
test('signed-out × send tapped: «Answer Pixel» finds the ended session as «Send answer» does, and sends nothing', async ({ page }) => {
  await openDiary(page);
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await answerField(page).fill('It did — the CFO laughed.');
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await answerButton(page).click();
  await expect(page.getByText(SIGNED_OUT).first()).toBeVisible();
  await expect(answerField(page)).toHaveValue('It did — the CFO laughed.');
  expect((await calls(page)).filter((c) => c.startsWith('worker:answer'))).toEqual([]);
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toBeVisible();
});

// spec: add-daily-ritual › Diary screen › signed-out × sign-in brings both fields back
test('signed-out × sign-in brings both fields back: after «Sign in» the Diary is at its address with the question\'s and the riddle\'s text in their fields', async ({ page }) => {
  await openDiary(page);
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await answerField(page).fill('It did — the CFO laughed.');
  await riddleField(page).fill('a clock');
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await sendRiddle(page).click();
  await expect(page.getByText(SIGNED_OUT).first()).toBeVisible();
  await setWorker(page, { sessionExpired: false });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  await expect(page.getByText('Streak: 2 days · Freezes: 1')).toBeVisible();
  await expect(answerField(page)).toHaveValue('It did — the CFO laughed.');
  await expect(riddleField(page)).toHaveValue('a clock');
  await expect(page.getByText(SIGNED_OUT)).toHaveCount(0);
  expect((await calls(page)).filter((c) => c.startsWith('worker:answer'))).toEqual([]);
});

/** The tab loads again with what the fakes hold now (a reload keeps the tab's session storage and nothing else). */
async function reloadWithFakes(page: Page) {
  const state = await page.evaluate(() => (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__);
  await page.addInitScript((s) => {
    (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__ = s;
  }, state);
  await page.reload();
}

// spec: add-daily-ritual › Ritual data › typed riddle answer × a reload in that day, a reload after it
test('typed riddle answer: a reload in its day brings it back, a reload after the day does not and removes it', async ({ page }) => {
  await openDiary(page);
  await riddleField(page).fill('a clock');
  expect(await page.evaluate(() => sessionStorage.getItem('nearling.riddleDraft.9'))).toBe(JSON.stringify({ day: SAMPLE_DAY, text: 'a clock' }));
  await reloadWithFakes(page);
  await expect(riddleField(page)).toHaveValue('a clock');
  // the next day's diary: the draft of the old one is gone
  await setWorker(page, { diary: { day: SAMPLE_DAY + 1, riddle: { kind: 'open', day: SAMPLE_DAY + 1, text: "What has hands but can't clap?" } } });
  await reloadWithFakes(page);
  await expect(page.getByRole('heading', { level: 2, name: "What has hands but can't clap?" })).toBeVisible();
  await expect(riddleField(page)).toHaveValue('');
  expect(await page.evaluate(() => sessionStorage.getItem('nearling.riddleDraft.9'))).toBeNull();
});
