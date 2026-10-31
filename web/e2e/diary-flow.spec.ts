import { expect, test, type Page } from '@playwright/test';
import { ASLEEP_PIXEL, calls, drawn, inSampleDay, lookAgain, openDiary, openPet, openWith, OWNER, PIXEL, SAMPLE_DAY, setPixel, setWorker, SIGNED_IN, BISCUIT } from './helpers';

const riddleField = (page: Page) => page.getByLabel("What has hands but can't clap?");
const answerField = (page: Page) => page.getByLabel('Did the chart surprise anyone?');
const answerButton = (page: Page) => page.getByRole('button', { name: 'Answer Pixel' });
const sendRiddle = (page: Page) => page.getByRole('button', { name: 'Send answer' });
const marks = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('worker:readDiary:'));
const sent = async (page: Page) => (await calls(page)).filter((c) => c.startsWith('worker:answerQuestion:'));
const streakLine = (page: Page) => page.getByText('Streak: 2 days · Freezes: 1');
/** What the page's live region says: a line drawn with no role of its own is in no other status region. */
const said = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });
const THOUGHT = { id: 't-q', text: 'A laugh from the CFO is a standing ovation.', cut: null };
const ANSWER = 'It did — the CFO laughed.';
const DONE_STREAK = { days: 2, freezes: 1, done: true, line: null, n: 2, k: 1, missed: 0, note: ['saving'] };
const ASLEEP_DIARY = { parts: [], complete: true, streak: DONE_STREAK };

/** Pixel's owner view with a question job on its way, as a reload or another tab finds it */
const ON_ITS_WAY = { pendingJob: 'job-question', pendingMode: 'chat', pendingKind: 'reply', pendingText: ANSWER, pendingQuestion: true };

/** The Pet screen waits behind a surface, then the way clears. */
async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

// spec: add-daily-ritual › Daily ritual flow › встречает дневником
// spec: add-daily-ritual › Daily ritual flow › встречает дневником × read at any opening, by itself, «Today» or the address
test('встречает дневником: an unread entry opens the Diary over the Pet screen, and the read mark goes', async ({ page }) => {
  await openPet(page, { diaryUnread: true });
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  await expect(streakLine(page)).toBeVisible();
  await expect(drawn(page, 'I think the fridge is getting nervous about your presentation too.')).toBeVisible();
  await expect.poll(() => marks(page)).toEqual([`worker:readDiary:${SAMPLE_DAY}`]);
});

// spec: add-daily-ritual › Daily ritual flow › встречает дневником × read at any opening, by itself, «Today» or the address
test('the read mark goes the same from «Today» as from the opening by itself', async ({ page }) => {
  await openPet(page);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  await expect(streakLine(page)).toBeVisible();
  await expect.poll(() => marks(page)).toEqual([`worker:readDiary:${SAMPLE_DAY}`]);
});

// spec: add-daily-ritual › Daily ritual flow › встречает дневником
test('встречает дневником: an entry that appears while the Pet screen is open opens the Diary then', async ({ page }) => {
  await openPet(page);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await setPixel(page, { diaryUnread: true });
  await lookAgain(page);
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  await expect(streakLine(page)).toBeVisible();
});

// spec: add-daily-ritual › Daily ritual flow › встречает дневником × back does not open it again
test('back does not open it again: «Back to Pixel» stays on the Pet screen while the poll still says unread', async ({ page }) => {
  await openPet(page, { diaryUnread: true });
  await expect(streakLine(page)).toBeVisible();
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await lookAgain(page);
  await page.clock.fastForward(11_000);
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(streakLine(page)).toHaveCount(0);
});

// spec: add-daily-ritual › Daily ritual flow › встречает дневником × 00:00 UTC, a new entry
test('00:00 UTC, a new entry: the Diary opens again for the new day, once', async ({ page }) => {
  await openPet(page, { diaryUnread: true }, {}, '23:59:50');
  await expect(streakLine(page)).toBeVisible();
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await page.clock.fastForward(15_000);
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await page.clock.fastForward(11_000);
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-daily-ritual › Daily ritual flow › встречает дневником × the read mark failed
test('the read mark failed: the tab does not open the Diary again by itself', async ({ page }) => {
  await openPet(page, { diaryUnread: true }, { readDiary: { fail: { status: 0, code: 'unreachable' } } });
  await expect(streakLine(page)).toBeVisible();
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await page.clock.fastForward(11_000);
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-daily-ritual › Daily ritual flow › встречает дневником × the line typed on Pet screen
test('the line typed on the Pet screen holds the Diary, with the focus in the field, until the field is empty', async ({ page }) => {
  await openPet(page);
  const field = page.getByPlaceholder('Talk to Pixel…');
  await field.fill('half a line');
  await setPixel(page, { diaryUnread: true });
  await lookAgain(page);
  await page.clock.fastForward(6_000);
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('half a line');
  await field.fill('');
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
});

// spec: add-daily-ritual › Daily ritual flow › встречает дневником × woke on the Pet screen
test('woke on the Pet screen: nothing opens by itself past two polls, «Today» still does', async ({ page }) => {
  await inSampleDay(page);
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': ASLEEP_PIXEL, '2': BISCUIT } } });
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
  // the meal: the entry written before the pet slept turns unread as `slept_at` clears
  await setPixel(page, { diaryUnread: true });
  await lookAgain(page);
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.')).toHaveCount(0);
  await page.clock.fastForward(11_000);
  await expect(page).toHaveURL(/\/pet\/9$/);
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
  await expect(streakLine(page)).toBeVisible();
});

// spec: add-daily-ritual › Daily ritual flow › сначала действие
// spec: add-daily-ritual › Daily ritual flow › сначала действие × a sheet opened by hand
test('сначала действие: a Feed sheet opened by hand holds the Diary, which opens when it is closed', async ({ page }) => {
  await openPet(page);
  await page.getByRole('button', { name: 'Feed Pixel' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await setPixel(page, { diaryUnread: true });
  await lookAgain(page);
  await page.clock.fastForward(6_000);
  await expect(page).toHaveURL(/\/pet\/9$/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
});

// spec: add-daily-ritual › Daily ritual flow › сначала действие × Feed sheet from a tap on the same open
test('Feed sheet from a tap on the same open comes first, the Diary after it', async ({ page }) => {
  await inSampleDay(page);
  await page.addInitScript(() => sessionStorage.setItem('nearling.returnPlace', JSON.stringify({ path: '/pet/9', action: 'feed' })));
  await openWith(page, '/', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, owner: { diaryUnread: true } }, '2': BISCUIT } } });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
});

// spec: add-daily-ritual › Daily ritual flow › сначала действие × a dialog or a menu open
test('a menu open holds the Diary, which opens when the menu is closed', async ({ page }) => {
  await openPet(page);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await openMenu(page);
  await setPixel(page, { diaryUnread: true });
  await lookAgain(page);
  await page.clock.fastForward(6_000);
  await expect(page).toHaveURL(/\/pet\/9$/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
});

// spec: add-daily-ritual › Daily ritual flow › сначала действие × a dialog or a menu open
test('the Clear memory dialog holds the Diary too', async ({ page }) => {
  await openPet(page);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await openMenu(page);
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await expect(page.getByRole('alertdialog').or(page.getByRole('dialog'))).toBeVisible();
  await setPixel(page, { diaryUnread: true });
  await lookAgain(page);
  await page.clock.fastForward(6_000);
  await expect(page).toHaveURL(/\/pet\/9$/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/pet\/9\/diary$/);
});

// spec: add-daily-ritual › Daily ritual flow › сначала действие × the entry erased while it waits
test('the entry erased while the Diary waits: nothing opens', async ({ page }) => {
  await openPet(page);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await openMenu(page);
  await setPixel(page, { diaryUnread: true });
  await lookAgain(page);
  await page.clock.fastForward(1_000);
  // the entry is erased (a clear, or the owner's other tab): the poll says nothing is unread
  await setPixel(page, { diaryUnread: false });
  await lookAgain(page);
  await page.keyboard.press('Escape');
  await page.clock.fastForward(6_000);
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-daily-ritual › Daily ritual flow › сначала действие × another pet's screen while it waits
test("another pet's screen while it waits: the Diary does not open there", async ({ page }) => {
  await openPet(page);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await openMenu(page);
  await setPixel(page, { diaryUnread: true });
  await lookAgain(page);
  await page.evaluate(() => {
    window.history.pushState(null, '', '/pet/2');
    window.dispatchEvent(new Event('nearling:navigate'));
  });
  await expect(page.getByRole('button', { name: 'Feed Biscuit' })).toBeVisible();
  await page.clock.fastForward(11_000);
  await expect(page).toHaveURL(/\/pet\/2$/);
});

// spec: add-daily-ritual › Daily ritual flow › дневник ещё пишется
test('дневник ещё пишется: «Pixel is writing its diary…» in place of the entry, the riddle as in success, and the entry arrives with no reload', async ({ page }) => {
  await openDiary(page, { entry: { kind: 'writing' }, parts: ['riddle'] });
  await expect(drawn(page, 'Pixel is writing its diary…')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: "What has hands but can't clap?" })).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
  await expect(drawn(page, 'All done for today!')).toHaveCount(0);
  await setWorker(page, { diary: {} });
  await page.clock.fastForward(5_100);
  await expect(drawn(page, 'I think the fridge is getting nervous about your presentation too.')).toBeVisible();
  await expect(answerField(page)).toBeVisible();
});

// spec: add-daily-ritual › Daily ritual flow › день без дневника × the line
test('день без дневника: the game\'s line in place of the entry, no question, the riddle ends the ritual', async ({ page }) => {
  await openDiary(page, { entry: { kind: 'asleep' }, parts: ['riddle'] });
  await expect(page.getByText("Pixel was asleep at diary time, so there's no diary today.")).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
  await expect(sendRiddle(page)).toBeVisible();
});

// spec: add-daily-ritual › Daily ritual flow › дневник не написан × the line
test('дневник не написан: the game\'s line in place of the entry, nothing to ask', async ({ page }) => {
  await openDiary(page, { entry: { kind: 'failed' }, parts: ['riddle'] });
  await expect(page.getByText("Pixel couldn't write its diary this time — the problem was on our side. There's no diary or question today.")).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
  await expect(sendRiddle(page)).toBeVisible();
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × control
test('the question: «Answer Pixel» sends nothing for an empty line and goes to the Worker with the diary\'s day for a typed one', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill('   ');
  await answerButton(page).click();
  expect(await sent(page)).toEqual([]);
  await answerField(page).fill(ANSWER);
  await answerButton(page).click();
  await expect.poll(() => sent(page)).toEqual([`worker:answerQuestion:${SAMPLE_DAY}`]);
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × control
test('«Answer Pixel» is off while any thought is on its way', async ({ page }) => {
  await openDiary(page, {}, { pets: { '9': { ...PIXEL, owner: { pendingJob: 'job-x', pendingMode: 'chat', pendingKind: 'reply', pendingText: 'hi there' } }, '2': BISCUIT } });
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill(ANSWER);
  await expect(answerButton(page)).toHaveAttribute('aria-disabled', 'true');
  await answerButton(page).click({ force: true });
  expect(await sent(page)).toEqual([]);
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × the field goes
test('the field goes once the answer is sent: the line and «Pixel is thinking…» under the question, then the reply', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill(ANSWER);
  await answerField(page).focus();
  await answerButton(page).click();
  await expect(answerField(page)).toHaveCount(0);
  await expect(page.getByText(ANSWER)).toBeVisible();
  await expect(page.getByText('Pixel is thinking…').first()).toBeVisible();
  // the focus was in the field: it moves to what replaced it
  await expect(page.locator('#diary-exchange')).toBeFocused();
  await setWorker(page, {
    petState: { thought: THOUGHT },
    diary: { exchange: { answer: ANSWER, reply: THOUGHT.text }, parts: ['riddle'] },
  });
  await expect(drawn(page, THOUGHT.text)).toBeVisible();
  await expect(drawn(page, "Today's streak still needs the riddle.")).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × the lines that arrive
test('the exchange\'s lines that arrive rise in and the reply is said with its speaker', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill(ANSWER);
  await answerButton(page).click();
  await expect(page.locator('.ds-message--player.ds-message--fresh').filter({ hasText: ANSWER })).toBeVisible();
  await setWorker(page, { petState: { thought: THOUGHT } });
  await expect(page.locator('.ds-message--pet.ds-message--fresh').filter({ hasText: THOUGHT.text })).toBeVisible();
  await expect(said(page, `Pixel: ${THOUGHT.text}`)).toHaveCount(1);
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × the lines that arrive
test('the exchange shown on opening stands still and is not said', async ({ page }) => {
  await openDiary(page, { exchange: { answer: ANSWER, reply: THOUGHT.text }, parts: ['riddle'] });
  await expect(drawn(page, THOUGHT.text)).toBeVisible();
  await expect(page.locator('.ds-message--pet').filter({ hasText: THOUGHT.text })).not.toHaveClass(/ds-message--fresh/);
  await expect(page.locator('.ds-message--player').filter({ hasText: ANSWER })).not.toHaveClass(/ds-message--fresh/);
  await expect(said(page, THOUGHT.text)).toHaveCount(0);
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × the answer put the pet to sleep
test('the answer that puts the pet to sleep: the exchange stands under the question, with the asleep lines and no field', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill(ANSWER);
  await answerButton(page).click();
  await expect(page.getByText(ANSWER)).toBeVisible();
  await setWorker(page, { pets: { '9': ASLEEP_PIXEL, '2': BISCUIT }, petState: { thought: THOUGHT }, diary: ASLEEP_DIARY });
  await expect(page.getByText('Pixel fell asleep. Today still counts for your streak.').first()).toBeVisible();
  await expect(page.getByText(ANSWER)).toBeVisible();
  await expect(drawn(page, THOUGHT.text)).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
  await expect(page.locator('[id="diary-handoff"]')).toHaveCount(1);
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × the answer put the pet to sleep
test('the diary holds the exchange of a pet that fell asleep: both lines stand, no field', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await setWorker(page, { pets: { '9': ASLEEP_PIXEL, '2': BISCUIT }, diary: { ...ASLEEP_DIARY, exchange: { answer: ANSWER, reply: THOUGHT.text } } });
  await lookAgain(page);
  await expect(page.getByText('Pixel fell asleep. Today still counts for your streak.').first()).toBeVisible();
  await expect(page.getByText(ANSWER)).toBeVisible();
  await expect(drawn(page, THOUGHT.text)).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
});

// spec: add-daily-ritual › Diary screen › success × what changes is said
test('what the polls bring is said by the page\'s one live region; what stood on opening is not', async ({ page }) => {
  await openDiary(page, { entry: { kind: 'writing' }, yesterday: { kind: 'waiting' }, streak: DONE_STREAK, parts: ['riddle'] });
  await expect(drawn(page, 'Pixel is writing its diary…')).toBeVisible();
  await expect(said(page, 'Pixel is writing its diary…')).toHaveCount(0);
  await setWorker(page, { diary: { yesterday: { kind: 'solved', answer: 'a piano' }, streak: { ...DONE_STREAK, days: 3, note: [] }, parts: [], complete: true } });
  await page.clock.fastForward(5_100);
  await expect(said(page, 'I think the fridge is getting nervous about your presentation too.')).toHaveCount(1);
  await expect(said(page, 'You solved the riddle that closed at')).toHaveCount(1);
  await expect(said(page, 'Streak: 3 days · Freezes: 1')).toHaveCount(1);
  await expect(said(page, 'All done for today!')).toHaveCount(1);
});

// spec: add-daily-ritual › Ritual day rule › питомец устал × it comes while the Diary is open
test('tired on the open Diary: the line beside the field is said too', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await setPixel(page, { tired: true, until: '2026-11-01T00:00:00.000Z' });
  await lookAgain(page);
  await expect(drawn(page, 'Pixel is tired for today. Back at', { exact: false }).first()).toBeVisible();
  await expect(said(page, 'Pixel is tired for today. Back at')).toHaveCount(1);
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × a stale tab on screen
test('a stale tab on screen: «already» takes nothing, the field goes and the screen catches up', async ({ page }) => {
  await openDiary(page, {}, { answerQuestion: { fail: { status: 409, code: 'already' } } });
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill(ANSWER);
  await setWorker(page, { diary: { exchange: { answer: 'from the other tab', reply: 'The other tab got a reply.' }, parts: ['riddle'] } });
  await answerButton(page).click();
  await expect(drawn(page, 'The other tab got a reply.')).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
  await expect(page.getByText(ANSWER)).toHaveCount(0);
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × thought refused
test('a thought refused (paused, tired, asleep): the text is back in the Diary\'s field, not the Pet screen\'s', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill(ANSWER);
  await setWorker(page, { petState: { code: 'tired', tired: true, until: '2026-11-01T00:00:00.000Z' } });
  await answerButton(page).click();
  await expect(drawn(page, 'Pixel is tired for today. Back at', { exact: false })).toBeVisible();
  await expect(answerField(page)).toHaveValue(ANSWER);
  await expect(answerButton(page)).toBeDisabled();
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveValue('');
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × thought lost, try again
test('a thought lost: the line stays under the question with «Try again», which sends it again', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill(ANSWER);
  await setWorker(page, { petState: { code: 'ai_unavailable' } });
  await answerButton(page).click();
  await expect(page.getByText('Pixel lost that thought. Nothing was spent — try again.')).toBeVisible();
  await expect(page.getByText(ANSWER)).toBeVisible();
  await setWorker(page, { petState: { thought: THOUGHT } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => sent(page)).toEqual([`worker:answerQuestion:${SAMPLE_DAY}`, `worker:answerQuestion:${SAMPLE_DAY}`]);
  await expect(drawn(page, THOUGHT.text)).toBeVisible();
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × a pause of the services
test('a pause of the services: the field is off with the pause line beside it, the text kept', async ({ page }) => {
  await openDiary(page, {}, { pets: { '9': { ...PIXEL, owner: { paused: true } }, '2': BISCUIT } });
  await expect(streakLine(page)).toBeVisible();
  await expect(page.getByText('Chatting is paused on our side while we top up. Your message is kept — Pixel will be back soon.').first()).toBeVisible();
  await expect(answerField(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(answerButton(page)).toBeDisabled();
  await expect(sendRiddle(page)).toBeVisible();
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × a pause of the services
test('a pause found by the send itself: the text comes back and the pause line stands', async ({ page }) => {
  await openDiary(page, {}, { answerQuestion: { fail: { status: 409, code: 'paused' } } });
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill(ANSWER);
  await answerButton(page).click();
  await expect(page.getByText('Chatting is paused on our side', { exact: false }).first()).toBeVisible();
  await expect(answerField(page)).toHaveValue(ANSWER);
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × a reload with the job on its way
test('a reload with the job on its way: the line and the thinking line are back under the question', async ({ page }) => {
  await openDiary(page, {}, { pets: { '9': { ...PIXEL, owner: ON_ITS_WAY }, '2': BISCUIT } });
  await expect(streakLine(page)).toBeVisible();
  await expect(page.getByText(ANSWER)).toBeVisible();
  await expect(page.getByText('Pixel is thinking…').first()).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
  expect(await sent(page)).toEqual([]);
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × fell asleep with the job on its way
test('fell asleep with the job on its way: the job is refused and the text waits in the field for the morning', async ({ page }) => {
  await openDiary(page, {}, { pets: { '9': { ...PIXEL, owner: ON_ITS_WAY }, '2': BISCUIT } });
  await expect(page.getByText('Pixel is thinking…').first()).toBeVisible();
  await setWorker(page, { pets: { '9': { ...ASLEEP_PIXEL, owner: ON_ITS_WAY }, '2': BISCUIT }, petState: { code: 'asleep' }, diary: ASLEEP_DIARY });
  await lookAgain(page);
  await expect(page.locator('#diary-handoff')).toHaveText('Pixel fell asleep. Today still counts for your streak.');
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT }, petState: {}, diary: {} });
  await lookAgain(page);
  await expect(answerField(page)).toHaveValue(ANSWER);
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × back to Pet screen
test('«Back to Pixel» with the job on its way: it goes on and the reply lands in the conversation', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill(ANSWER);
  await answerButton(page).click();
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByText(ANSWER)).toBeVisible();
  await setWorker(page, { petState: { thought: THOUGHT } });
  await expect(drawn(page, THOUGHT.text)).toBeVisible();
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × 00:00 UTC, the draft stays
test('00:00 UTC: the question\'s draft stays in the tab and its field is back with the new question', async ({ page }) => {
  await openDiary(page, {}, {}, '23:59:50');
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill('half an answer');
  const next = SAMPLE_DAY + 1;
  await setWorker(page, {
    diary: {
      day: next,
      entry: { kind: 'text', id: 'diary-2', lines: ['A new morning.'], question: 'Did the dip surprise anyone?', work: null },
      riddle: { kind: 'open', day: next, text: 'What gets wetter as it dries?' },
    },
  });
  await page.clock.fastForward(15_000);
  await expect(drawn(page, 'A new morning.')).toBeVisible();
  await expect(page.getByLabel('Did the dip surprise anyone?')).toHaveValue('half an answer');
});

// spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × memory cleared, the draft stays
test('memory cleared: the question\'s draft stays in the tab', async ({ page }) => {
  await openDiary(page);
  await expect(streakLine(page)).toBeVisible();
  await answerField(page).fill('half an answer');
  await setWorker(page, { diary: { entry: { kind: 'cleared' }, riddle: { kind: 'answered', day: SAMPLE_DAY, text: "What has hands but can't clap?", answer: null }, parts: [] } });
  await page.clock.fastForward(5_100);
  await expect(drawn(page, "You cleared Pixel's memory", { exact: false })).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
  await setWorker(page, { diary: {} });
  await page.clock.fastForward(5_100);
  await expect(answerField(page)).toHaveValue('half an answer');
});

// spec: add-daily-ritual › Daily ritual flow › part still to do
// spec: add-daily-ritual › Daily ritual flow › part still to do × the three wordings
test('part still to do: the line follows the parts, in all three wordings, and goes with the last one', async ({ page }) => {
  await openDiary(page);
  await expect(page.getByText("Today's streak still needs the question and the riddle.")).toBeVisible();
  await setWorker(page, { diary: { parts: ['riddle'] } });
  await page.clock.fastForward(5_100);
  await expect(drawn(page, "Today's streak still needs the riddle.")).toBeVisible();
  await setWorker(page, { diary: { parts: ['question'] } });
  await page.clock.fastForward(5_100);
  await expect(drawn(page, "Today's streak still needs the question.")).toBeVisible();
  await setWorker(page, { diary: { parts: [] } });
  await page.clock.fastForward(5_100);
  await expect(page.getByText("Today's streak still needs", { exact: false })).toHaveCount(0);
});

// spec: add-daily-ritual › Daily ritual flow › part still to do
test('part still to do: the question whose answer is on its way leaves the line at once; nothing else left, the line is gone', async ({ page }) => {
  await openDiary(page, { parts: ['question'] });
  await expect(drawn(page, "Today's streak still needs the question.")).toBeVisible();
  await answerField(page).fill(ANSWER);
  await answerButton(page).click();
  await expect(page.getByText("Today's streak still needs", { exact: false })).toHaveCount(0);
});

// spec: add-daily-ritual › Daily ritual flow › ритуал завершён
// spec: add-daily-ritual › Daily ritual flow › ритуал завершён × controls
test('ритуал завершён: «All done for today!», no field, «Back to Pixel» and Account work', async ({ page }) => {
  await openDiary(page, {
    exchange: { answer: ANSWER, reply: THOUGHT.text },
    riddle: { kind: 'answered', day: SAMPLE_DAY, text: "What has hands but can't clap?", answer: 'a clock' },
    parts: [],
    complete: true,
    streak: DONE_STREAK,
  });
  await expect(drawn(page, 'All done for today!')).toBeVisible();
  await expect(drawn(page, 'Saving your streak…')).toBeVisible();
  await expect(drawn(page, 'Answer in! Find out if you got it after', { exact: false })).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
  await expect(sendRiddle(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toHaveAttribute('href', '/pet/9');
  await openMenu(page);
});

// spec: add-daily-ritual › Ritual day rule › питомец устал
// spec: add-daily-ritual › Ritual day rule › питомец устал × controls
test('питомец устал: «Answer Pixel» is off with the line beside it, the riddle field works as in success', async ({ page }) => {
  await openDiary(page, {}, { pets: { '9': { ...PIXEL, owner: { tired: true, until: '2026-11-01T00:00:00.000Z' } }, '2': BISCUIT } });
  await expect(streakLine(page)).toBeVisible();
  await expect(drawn(page, /Pixel is tired for today\. Back at \d\d:\d\d\./)).toBeVisible();
  await expect(answerButton(page)).toBeDisabled();
  await expect(answerField(page)).toHaveAttribute('aria-disabled', 'true');
  await riddleField(page).fill('a clock');
  await expect(sendRiddle(page)).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-daily-ritual › Ritual day rule › новые сутки при открытом экране
test('новые сутки при открытом экране: with no reload yesterday\'s answer, the new riddle and «writing» in place of the entry', async ({ page }) => {
  await openDiary(page, {}, {}, '23:59:50');
  await expect(streakLine(page)).toBeVisible();
  const next = SAMPLE_DAY + 1;
  await setWorker(page, {
    diary: {
      day: next,
      closedAt: new Date(next * 86_400_000).toISOString(),
      until: new Date((next + 1) * 86_400_000).toISOString(),
      entry: { kind: 'writing' },
      riddle: { kind: 'open', day: next, text: 'What gets wetter as it dries?' },
      yesterday: { kind: 'solved', answer: 'a clock' },
      parts: ['riddle'],
    },
  });
  await page.clock.fastForward(15_000);
  await expect(drawn(page, 'Pixel is writing its diary…')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'What gets wetter as it dries?' })).toBeVisible();
  await expect(drawn(page, 'It was "a clock".')).toBeVisible();
  await expect(answerField(page)).toHaveCount(0);
});

/** The Diary on which the pet falls asleep, with a riddle answer typed or not */
async function fallAsleep(page: Page, typed: string | null, at?: string) {
  await openDiary(page, {}, {}, at);
  await expect(streakLine(page)).toBeVisible();
  if (typed !== null) await riddleField(page).fill(typed);
  await riddleField(page).focus();
  await setWorker(page, { pets: { '9': { ...ASLEEP_PIXEL }, '2': BISCUIT }, diary: ASLEEP_DIARY });
  await lookAgain(page);
  await expect(page.locator('#diary-handoff')).toHaveText('Pixel fell asleep. Today still counts for your streak.');
}

// spec: add-daily-ritual › Diary screen › asleep × controls
test('asleep × controls: «Feed Pixel» opens the Feed sheet, «Back to Pixel» and Account work, no fields', async ({ page }) => {
  await fallAsleep(page, null);
  await expect(riddleField(page)).toHaveCount(0);
  await expect(answerField(page)).toHaveCount(0);
  await expect(drawn(page, 'All done for today!')).toBeVisible();
  await expect(drawn(page, 'Saving your streak…')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toHaveAttribute('href', '/pet/9');
  await openMenu(page);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

// spec: add-daily-ritual › Diary screen › asleep × focus in a field that went
test('asleep × focus in a field that went: the focus moves to the first line, Tab goes on to «Feed Pixel»', async ({ page }) => {
  await fallAsleep(page, null);
  await expect(page.locator('#diary-handoff')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Pixel fell asleep. Today still counts for your streak.' })).toBeAttached();
});

// spec: add-daily-ritual › Diary screen › asleep × woke
test('asleep × woke: the Diary is «success» again', async ({ page }) => {
  await fallAsleep(page, null);
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT }, diary: {} });
  await lookAgain(page);
  await expect(riddleField(page)).toBeVisible();
  await expect(answerField(page)).toBeVisible();
  await expect(page.getByText('Pixel fell asleep.', { exact: false })).toHaveCount(0);
});

// spec: add-daily-ritual › Diary screen › asleep × a reload
// spec: add-daily-ritual › Daily ritual flow › уснул в нетронутый день × the address sends no mark
test('asleep × a reload: the Pet screen at its own address, no diary asked for and no mark sent', async ({ page }) => {
  await inSampleDay(page);
  await openWith(page, '/pet/9/diary', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': ASLEEP_PIXEL, '2': BISCUIT } } });
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
  expect(await marks(page)).toEqual([]);
  expect((await calls(page)).filter((c) => c === 'worker:diary')).toEqual([]);
});

// spec: add-daily-ritual › Diary screen › уснул с набранным ответом
test('уснул с набранным ответом: the kept line is added to the asleep line', async ({ page }) => {
  await fallAsleep(page, 'a clock');
  await expect(page.getByText('Your riddle answer is saved for when Pixel wakes up.').first()).toBeVisible();
  await expect(riddleField(page)).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Your riddle answer is saved for when Pixel wakes up.' })).toBeAttached();
});

// spec: add-daily-ritual › Diary screen › уснул с набранным ответом × woke the same day
test('woke the same day: «success» with the typed answer in the field', async ({ page }) => {
  await fallAsleep(page, 'a clock');
  await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT }, diary: {} });
  await lookAgain(page);
  await expect(riddleField(page)).toHaveValue('a clock');
});

// spec: add-daily-ritual › Ritual day rule › новые сутки у спящего
test('новые сутки у спящего: with no reload the Pet screen at its address', async ({ page }) => {
  await fallAsleep(page, null, '23:59:50');
  const next = SAMPLE_DAY + 1;
  await setWorker(page, { diary: { ...ASLEEP_DIARY, day: next } });
  await page.clock.fastForward(15_000);
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
});

// spec: add-daily-ritual › Ritual day rule › новые сутки у спящего × the typed answer doesn't come back
test('the typed answer does not come back after a night asleep', async ({ page }) => {
  await fallAsleep(page, 'a clock', '23:59:50');
  expect(await page.evaluate(() => sessionStorage.getItem('nearling.riddleDraft.9'))).not.toBeNull();
  await setWorker(page, { diary: { ...ASLEEP_DIARY, day: SAMPLE_DAY + 1 } });
  await page.clock.fastForward(15_000);
  await expect(page).toHaveURL(/\/pet\/9$/);
  expect(await page.evaluate(() => sessionStorage.getItem('nearling.riddleDraft.9'))).toBeNull();
});
