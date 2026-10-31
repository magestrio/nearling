import { expect, test, type Page } from '@playwright/test';
import { calls, drawn, lookAgain, openDiary, SAMPLE_DAY, setWorker } from './helpers';

const RIDDLE = "What has hands but can't clap?";
const NEXT_RIDDLE = 'What gets wetter as it dries?';
const DAY_MS = 86_400_000;
const riddleField = (page: Page) => page.getByLabel(RIDDLE);
const nextField = (page: Page) => page.getByLabel(NEXT_RIDDLE);
const sendRiddle = (page: Page) => page.getByRole('button', { name: 'Send answer' });
const streakLine = (page: Page) => page.getByText('Streak: 2 days · Freezes: 1');
const riddleCalls = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('worker:answerRiddle:'));
const draftOf = (page: Page) => page.evaluate(() => sessionStorage.getItem('nearling.riddleDraft.9'));
const CLOCK = /\d\d:\d\d/;

/** The diary of the day after the sample day, its riddle open or held, as the Worker answers once 00:00 UTC has passed */
const nextDay = (riddle: Record<string, unknown>, more: Record<string, unknown> = {}) => {
  const next = SAMPLE_DAY + 1;
  return {
    day: next,
    closedAt: new Date(next * DAY_MS).toISOString(),
    until: new Date((next + 1) * DAY_MS).toISOString(),
    riddle,
    yesterday: { kind: 'waiting' },
    ...more,
  };
};
const OPEN_NEXT = { kind: 'open', day: SAMPLE_DAY + 1, text: NEXT_RIDDLE };

// spec: add-daily-ritual › Riddle rule › ответ принят × the field's limits
test('the field\'s limits: 40 characters at most, «Send answer» off without a visible character', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await expect(riddleField(page)).toHaveAttribute('maxlength', '40');
  await expect(sendRiddle(page)).toHaveAttribute('aria-disabled', 'true');
  await riddleField(page).fill('   ');
  await expect(sendRiddle(page)).toHaveAttribute('aria-disabled', 'true');
  await riddleField(page).fill('y'.repeat(41));
  await expect(riddleField(page)).toHaveValue('y'.repeat(40));
  await expect(page.getByText('Up to 40 characters.')).toBeVisible();
});

// spec: add-daily-ritual › Riddle rule › ответ принят × control
test('«Send answer» sends the draft with its day and the answer stands in the field\'s place, with no second try', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await riddleField(page).press('Enter');
  await expect.poll(() => riddleCalls(page)).toEqual([`worker:answerRiddle:${SAMPLE_DAY}`]);
  await expect(drawn(page, 'Answer in! Find out if you got it after', { exact: false })).toBeVisible();
  await expect(page.getByText('"a clock"')).toBeVisible();
  await expect(riddleField(page)).toHaveCount(0);
  await expect(sendRiddle(page)).toHaveCount(0);
  await expect(drawn(page, "Today's streak still needs the question.")).toBeVisible();
  expect(await draftOf(page)).toBeNull();
});

// spec: add-daily-ritual › Riddle rule › ответ принят × focus in a field that went
test('ответ принят with Enter in the field: the focus moves to «Answer in!…» and the page says it', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await riddleField(page).press('Enter');
  const line = drawn(page, 'Answer in! Find out if you got it after', { exact: false }).first();
  await expect(line).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Answer in! Find out if you got it after' })).toHaveCount(1);
});

// spec: add-daily-ritual › Riddle rule › ответ принят × focus in a field that went
test('ответ принят with a tap on «Send answer» after the question was answered: the focus moves to «Answer in!…», not to the exchange', async ({ page }) => {
  await openDiary(page, { exchange: { answer: 'It did.', reply: 'A standing ovation.' }, parts: ['riddle'] });
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await sendRiddle(page).click();
  await expect(drawn(page, 'Answer in! Find out if you got it after', { exact: false }).first()).toBeFocused();
});

// spec: add-daily-ritual › Riddle rule › ответ принят × focus in a field that went
test('the riddle gone from under a field that held the focus: «Answered today» takes it', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).focus();
  await setWorker(page, { diary: { riddle: { kind: 'answered', day: SAMPLE_DAY, text: RIDDLE, answer: null }, parts: ['question'] } });
  await lookAgain(page);
  await expect(drawn(page, 'Answered today')).toBeFocused();
});

// spec: add-daily-ritual › Riddle rule › ответ принят × focus elsewhere
test('the field left before the answer was taken: the focus stays where the player put it', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await page.getByRole('link', { name: 'Back to Pixel' }).focus();
  await setWorker(page, { diary: { riddle: { kind: 'answered', day: SAMPLE_DAY, text: RIDDLE, answer: 'a clock' }, parts: ['question'] } });
  await lookAgain(page);
  await expect(drawn(page, 'Answer in! Find out if you got it after', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toBeFocused();
});

// spec: add-daily-ritual › Riddle rule › ответ принят × a stale tab on screen
test('a stale tab on screen: «already» changes nothing, the screen catches up and the draft is erased', async ({ page }) => {
  await openDiary(page, {}, { answerRiddle: { status: 'already' } });
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await setWorker(page, { diary: { riddle: { kind: 'answered', day: SAMPLE_DAY, text: RIDDLE, answer: 'a piano' }, parts: ['question'] } });
  await sendRiddle(page).click();
  await expect(page.getByText('"a piano"', { exact: true })).toBeVisible();
  await expect(riddleField(page)).toHaveCount(0);
  expect(await draftOf(page)).toBeNull();
});

// spec: add-daily-ritual › Riddle rule › ответ опоздал
// spec: add-daily-ritual › Riddle rule › ответ опоздал × the line and today's riddle
// spec: add-daily-ritual › Riddle rule › ответ опоздал × the field clears
test('ответ опоздал: the field clears, «That riddle closed at {time}. Here\'s today\'s!» and the new riddle', async ({ page }) => {
  await openDiary(page, {}, { answerRiddle: { status: 'late' } });
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await setWorker(page, { diary: nextDay(OPEN_NEXT) });
  await sendRiddle(page).click();
  await expect(page.getByText(new RegExp(`^That riddle closed at ${CLOCK.source}\\. Here's today's!$`)).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: NEXT_RIDDLE })).toBeVisible();
  await expect(nextField(page)).toHaveValue('');
  expect(await draftOf(page)).toBeNull();
});

// spec: add-daily-ritual › Riddle rule › ответ опоздал × today's riddle not there yet
test('a late answer with today\'s riddle not there yet: «That riddle closed at {time}.» and the held line, no field', async ({ page }) => {
  await openDiary(page, {}, { answerRiddle: { status: 'late' } });
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await setWorker(page, { diary: nextDay({ kind: 'held' }) });
  await sendRiddle(page).click();
  await expect(page.getByText(new RegExp(`^That riddle closed at ${CLOCK.source}\\.$`)).first()).toBeVisible();
  await expect(drawn(page, "Today's riddle is held up on our side. If it's ready today, it'll show up right here.")).toBeVisible();
  await expect(sendRiddle(page)).toHaveCount(0);
  // the focus was on «Send answer», which went: it moves to the first line of what replaced it
  await expect(page.locator('#diary-handoff')).toBeFocused();
});

// spec: add-daily-ritual › Riddle rule › ответ опоздал × today's riddle opens under the line
test('today\'s riddle opens under the line: it turns to «…Here\'s today\'s!»', async ({ page }) => {
  await openDiary(page, {}, { answerRiddle: { status: 'late' } });
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await setWorker(page, { diary: nextDay({ kind: 'held' }) });
  await sendRiddle(page).click();
  await expect(page.getByText(new RegExp(`^That riddle closed at ${CLOCK.source}\\.$`)).first()).toBeVisible();
  await setWorker(page, { diary: nextDay(OPEN_NEXT) });
  await page.clock.fastForward(5_100);
  await expect(page.getByText(new RegExp(`Here's today's!$`)).first()).toBeVisible();
  await expect(nextField(page)).toBeVisible();
});

// spec: add-daily-ritual › Riddle rule › ответ опоздал × today's answer accepted
test('today\'s answer accepted: «Answer in!…» replaces the late line; a reload drops it', async ({ page }) => {
  await openDiary(page, {}, { answerRiddle: { status: 'late' } });
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await setWorker(page, { diary: nextDay(OPEN_NEXT) });
  await sendRiddle(page).click();
  await expect(page.getByText("Here's today's!").first()).toBeVisible();
  await setWorker(page, { answerRiddle: { status: 'accepted' } });
  await nextField(page).fill('rain');
  await sendRiddle(page).click();
  await expect(drawn(page, 'Answer in! Find out if you got it after', { exact: false })).toBeVisible();
  await expect(page.getByText("Here's today's!")).toHaveCount(0);
  expect(await riddleCalls(page)).toEqual([`worker:answerRiddle:${SAMPLE_DAY}`, `worker:answerRiddle:${SAMPLE_DAY + 1}`]);
});

// spec: add-daily-ritual › Ritual day rule › новые сутки при открытом экране × typed text, today's riddle open
test('00:00 UTC, today\'s riddle open: the text typed for the old riddle stays in the field and its send is late', async ({ page }) => {
  await openDiary(page, {}, { answerRiddle: { status: 'late' } }, '23:59:50');
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await setWorker(page, { diary: nextDay(OPEN_NEXT) });
  await page.clock.fastForward(15_000);
  await expect(page.getByRole('heading', { level: 2, name: NEXT_RIDDLE })).toBeVisible();
  await expect(nextField(page)).toHaveValue('a clock');
  await sendRiddle(page).click();
  // the draft goes with the day it was typed for
  await expect.poll(() => riddleCalls(page)).toEqual([`worker:answerRiddle:${SAMPLE_DAY}`]);
  await expect(page.getByText(new RegExp(`^That riddle closed at ${CLOCK.source}\\. Here's today's!$`)).first()).toBeVisible();
  await expect(nextField(page)).toHaveValue('');
});

// spec: add-daily-ritual › Ritual day rule › новые сутки при открытом экране × typed text, today's riddle held
test('00:00 UTC, today\'s riddle held: no field, the text waits in the tab and is back when the riddle opens', async ({ page }) => {
  await openDiary(page, {}, {}, '23:59:50');
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await setWorker(page, { diary: nextDay({ kind: 'held' }) });
  await page.clock.fastForward(15_000);
  await expect(drawn(page, "Today's riddle is held up on our side. If it's ready today, it'll show up right here.")).toBeVisible();
  await expect(sendRiddle(page)).toHaveCount(0);
  expect(await draftOf(page)).toBe(JSON.stringify({ day: SAMPLE_DAY, text: 'a clock' }));
  await setWorker(page, { diary: nextDay(OPEN_NEXT) });
  await page.clock.fastForward(5_100);
  await expect(nextField(page)).toHaveValue('a clock');
});

// spec: add-daily-ritual › Riddle rule › загадка ещё не запечатана × the line
test('загадка ещё не запечатана: the held line in place of the riddle, no field, and the riddle appears with no reload', async ({ page }) => {
  await openDiary(page, { riddle: { kind: 'held' }, parts: ['question'] });
  await expect(drawn(page, "Today's riddle is held up on our side. If it's ready today, it'll show up right here.")).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(0);
  await expect(sendRiddle(page)).toHaveCount(0);
  await setWorker(page, { diary: {} });
  await page.clock.fastForward(5_100);
  await expect(riddleField(page)).toBeVisible();
});

// spec: add-daily-ritual › Riddle rule › угадал × the line
test('угадал: «You solved the riddle that closed at {time}! It was "{answer}".»', async ({ page }) => {
  await openDiary(page, { yesterday: { kind: 'solved', answer: 'a piano' } });
  await expect(page.getByText(new RegExp(`^You solved the riddle that closed at ${CLOCK.source}! It was "a piano"\\.$`))).toBeVisible();
});

// spec: add-daily-ritual › Riddle rule › не угадал × the line
test('не угадал: «Not this time — the answer to the riddle that closed at {time} was "{answer}".»', async ({ page }) => {
  await openDiary(page, { yesterday: { kind: 'wrong', answer: 'a piano' } });
  await expect(page.getByText(new RegExp(`^Not this time — the answer to the riddle that closed at ${CLOCK.source} was "a piano"\\.$`))).toBeVisible();
});

// spec: add-daily-ritual › Riddle rule › вчера не отвечал × the line
test('вчера не отвечал: «The riddle that closed at {time}: the answer was "{answer}".»', async ({ page }) => {
  await openDiary(page, { yesterday: { kind: 'none', answer: 'a piano' } });
  await expect(page.getByText(new RegExp(`^The riddle that closed at ${CLOCK.source}: the answer was "a piano"\\.$`))).toBeVisible();
});

// spec: add-daily-ritual › Riddle rule › ответ ещё не раскрыт × the line, then the verdict with no reload
test('ответ ещё не раскрыт: «…is on its way.» in place of yesterday\'s answer, then the verdict on the open screen', async ({ page }) => {
  await openDiary(page, { yesterday: { kind: 'waiting' } });
  await expect(page.getByText(new RegExp(`^The answer to the riddle that closed at ${CLOCK.source} is on its way\\.$`))).toBeVisible();
  await setWorker(page, { diary: { yesterday: { kind: 'solved', answer: 'a piano' } } });
  await page.clock.fastForward(5_100);
  await expect(drawn(page, 'It was "a piano".')).toBeVisible();
  await expect(page.getByText('is on its way.', { exact: false })).toHaveCount(0);
});

// spec: add-daily-ritual › Riddle rule › ответ ещё не раскрыт × no block on screen
test('a riddle that never opened gets no block: no line of yesterday\'s riddle at all', async ({ page }) => {
  await openDiary(page, { yesterday: null });
  await expect(riddleField(page)).toBeVisible();
  await expect(page.getByText('The riddle that closed at', { exact: false })).toHaveCount(0);
  await expect(page.getByText('You solved the riddle', { exact: false })).toHaveCount(0);
  await expect(page.getByText('is on its way.', { exact: false })).toHaveCount(0);
});

// spec: add-daily-ritual › Ritual data › удаление памяти × the riddle draft stays
test('a cleared memory leaves the typed riddle answer where it is', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await setWorker(page, { diary: { entry: { kind: 'cleared' }, yesterday: { kind: 'none', answer: 'a piano' } } });
  await page.clock.fastForward(5_100);
  await expect(drawn(page, "You cleared Pixel's memory", { exact: false })).toBeVisible();
  await expect(riddleField(page)).toHaveValue('a clock');
  expect(await draftOf(page)).toBe(JSON.stringify({ day: SAMPLE_DAY, text: 'a clock' }));
});

// spec: add-daily-ritual › Ritual data › typed riddle answer × it never leaves the browser
test('typed riddle answer × it never leaves the browser: no request carries it until it is sent', async ({ page }) => {
  const bodies: string[] = [];
  page.on('request', (r) => bodies.push(`${r.url()} ${r.postData() ?? ''}`));
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock secret');
  await page.clock.fastForward(11_000);
  await lookAgain(page);
  expect(bodies.filter((b) => b.includes('secret'))).toEqual([]);
  expect(await riddleCalls(page)).toEqual([]);
});

// spec: add-daily-ritual › Ritual data › typed riddle answer × a sign-out erases it
test('typed riddle answer × a sign-out erases it', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  expect(await draftOf(page)).not.toBeNull();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await draftOf(page)).toBeNull();
});

// spec: add-daily-ritual › Ritual data › typed riddle answer × a pet given away erases it
test('typed riddle answer × a pet given away erases it, on the Pet screen too, where only `/state` looks', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  expect(await draftOf(page)).not.toBeNull();
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveCount(0);
  await expect.poll(() => draftOf(page)).toBeNull();
});

// spec: add-daily-ritual › Ritual data › typed riddle answer × session expiry keeps it
test('typed riddle answer × session expiry keeps it: the draft stays through the ended session', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await riddleField(page).fill('a clock');
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await sendRiddle(page).click();
  await expect(page.getByText("You've been signed out. Sign in to get back to Pixel's diary.").first()).toBeVisible();
  expect(await draftOf(page)).toBe(JSON.stringify({ day: SAMPLE_DAY, text: 'a clock' }));
  await expect(riddleField(page)).toHaveValue('a clock');
});
