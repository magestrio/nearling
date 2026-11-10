import { expect, test, type Page } from '@playwright/test';
import type { PetBase } from '../src/seams/worker-types';
import { ASLEEP_PIXEL, BISCUIT, calls, drawn, lookAgain, openWith, OWNER, PIXEL, reloadHolding, setWardrobePet, setWorker, SIGNED_IN, WARDROBE_OWNS } from './helpers';

// Errand sheet (add-pet-errands › Errand sheet screen, Errand flow): the rail's «Send {name} on an errand» opens it over the conversation
// column; the three forms, the field of the picked one, «Send · …» pinned to its foot — or the first block in its place. The fakes
// answer the quote (`GET …/errand`) and the send.
test.use({ timezoneId: 'Etc/GMT-2' });

const SESSION_LINE = "You've been signed out. Sign in to pick up where you left off.";
const LEONIDS = 'When does the Leonid meteor shower peak this year, and when should I look?';
const DREAMS = 'https://example.com/dreams';
const NEXT_MIDNIGHT = '2026-11-04T00:00:00.000Z';
const FOOD = { reason: 'food', need: { yocto: '2000000000000000000000', cents: 0.93 } };

const rail = (page: Page) => page.getByRole('button', { name: 'Send Pixel on an errand' });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Send Pixel on an errand' });
const field = (page: Page, label: string) => sheet(page).getByLabel(label);
// its name carries the price: «Send · ≈ 0.15¢»
const send = (page: Page) => sheet(page).getByRole('button', { name: /^Send\b/ });
const HUNGRY_PIXEL: PetBase = { ...PIXEL, fullness: { state: 'hungry', level: 0.1 } };
const open = async (page: Page, worker: Record<string, unknown> = {}, pixel: PetBase = PIXEL) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...pixel, owner: {} }, '2': BISCUIT }, ...worker } });
  await rail(page).click();
  await expect(sheet(page)).toBeVisible();
};

// spec: add-pet-errands › Errand sheet screen › shared job funding amount
// spec: add-pet-errands › Friend-funded errand flow › owner shares a job
test('a filled search shows the full shared ceiling and prepares one link without sending an errand', async ({ page }) => {
  await open(page);
  await sheet(page).getByRole('radio', { name: 'Find out' }).check();
  await field(page, 'What should Pixel find out?').fill(LEONIDS);
  await expect(drawn(page, 'Friends need 2¢ of food for this job')).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Share a job for friends to fund' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/errand\/[0-9a-f]{64}$/);
  await expect(page.getByText('Anyone with this link can read your job. Only you and friends who feed it can read the report.')).toBeVisible();
  expect(await calls(page)).toContain('worker:prepareSharedErrand');
  expect((await calls(page)).some((name) => name.startsWith('worker:sendErrand'))).toBe(false);
});

// spec: add-pet-errands › Friend-funded errand flow › another shared job is waiting
test('another active shared job keeps the typed draft and links to that job', async ({ page }) => {
  const code = 'c'.repeat(64);
  await open(page, { prepareSharedErrand: { fail: { status: 409, code: 'shared_job_active', body: { url: `/pet/9/errand/${code}` } } } });
  await sheet(page).getByRole('radio', { name: 'Find out' }).check();
  await field(page, 'What should Pixel find out?').fill(LEONIDS);
  await sheet(page).getByRole('button', { name: 'Share a job for friends to fund' }).click();
  await expect(field(page, 'What should Pixel find out?')).toHaveValue(LEONIDS);
  await expect(sheet(page).getByRole('link', { name: 'Open shared errand' })).toHaveAttribute('href', `/pet/9/errand/${code}`);
});

// spec: add-pet-errands › Errand sheet screen › success
test('success: the three forms with «Read this» picked, the field «Paste a link or some text», «Send» off while it is empty, the price by the text', async ({ page }) => {
  await open(page);
  const dialog = sheet(page);
  await expect(dialog.getByRole('heading', { name: 'Send Pixel on an errand' })).toBeVisible();
  await expect(dialog.getByRole('radiogroup', { name: 'Errand' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Read this' })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'Find out' })).not.toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'Is it true?' })).not.toBeChecked();
  await expect(field(page, 'Paste a link or some text')).toHaveValue('');
  await expect(send(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(send(page)).toContainText('≈ 0.15¢');
  // a link stays at the typical read; pasted text moves it by its length
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await expect(send(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(send(page)).toContainText('≈ 0.15¢');
  await field(page, 'Paste a link or some text').fill('A lease clause about notice. '.repeat(900));
  await expect(send(page)).not.toContainText('≈ 0.15¢');
  await expect(send(page)).toContainText('≈ ');
  expect(await calls(page)).toContain('worker:errand:read');
  // the rail's item shows the sheet is open
  await expect(page.getByRole('button', { name: 'Send Pixel on an errand', expanded: true })).toHaveCount(1);
});

// spec: add-pet-errands › Errand sheet screen › a search form
test('a search form: «Find out» and «Is it true?» take their own field, «Send · up to ≈ 2¢» and the line that only these words go to web search', async ({ page }) => {
  await open(page);
  await sheet(page).getByRole('radio', { name: 'Find out' }).check();
  await expect(field(page, 'What should Pixel find out?')).toBeVisible();
  await expect(drawn(page,"Only these words go to web search — never Pixel's memory.")).toBeVisible();
  await expect(send(page)).toContainText('up to ≈ 2¢');
  await field(page, 'What should Pixel find out?').fill(LEONIDS);
  await expect(send(page)).not.toHaveAttribute('aria-disabled', 'true');
  await sheet(page).getByRole('radio', { name: 'Is it true?' }).check();
  await expect(field(page, 'What claim should Pixel check?')).toBeVisible();
  await expect(send(page)).toContainText('up to ≈ 2¢');
  expect(await calls(page)).toEqual(expect.arrayContaining(['worker:errand:find', 'worker:errand:check']));
});

// spec: add-pet-errands › Errand sheet screen › a search form × switch the form
test('a search form × switch the form: each form keeps its own text while the sheet is open, and switching back brings it', async ({ page }) => {
  await open(page);
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await sheet(page).getByRole('radio', { name: 'Find out' }).check();
  await expect(field(page, 'What should Pixel find out?')).toHaveValue('');
  await field(page, 'What should Pixel find out?').fill(LEONIDS);
  await sheet(page).getByRole('radio', { name: 'Read this' }).check();
  await expect(field(page, 'Paste a link or some text')).toHaveValue(DREAMS);
  await sheet(page).getByRole('radio', { name: 'Find out' }).check();
  await expect(field(page, 'What should Pixel find out?')).toHaveValue(LEONIDS);
  // closed and opened again: the draft is the tab's, it stays until the page closes
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await rail(page).click();
  await expect(field(page, 'What should Pixel find out?')).toHaveValue(LEONIDS);
});

// spec: add-pet-errands › Errand sheet screen › food covers fewer searches
test('food covers fewer searches: «Send · up to ≈ {price}» at what the food covers and the line that this is as far as it goes', async ({ page }) => {
  await open(page, { errand: { search: { upTo: { yocto: '2690000000000000000000', cents: 1.2 }, full: false, short: true, searches: 1, allowance: 3 } } });
  await sheet(page).getByRole('radio', { name: 'Find out' }).check();
  await field(page, 'What should Pixel find out?').fill(LEONIDS);
  await expect(send(page)).toContainText('up to ≈ 1.2¢');
  await expect(drawn(page,"That's as far as Pixel's food goes right now.")).toBeVisible();
  await expect(send(page)).toHaveAccessibleDescription("That's as far as Pixel's food goes right now.");
});

// spec: add-pet-errands › Errand sheet screen › a skill with outside data
test('a skill with outside data: also the line that Pixel may look things up through its data sources', async ({ page }) => {
  await open(page, { errand: { labels: ['Daybook', 'Open-Meteo'], search: { upTo: { yocto: '3790000000000000000000', cents: 1.75 }, full: true, short: false, searches: 2, allowance: 2 } } });
  await expect(drawn(page,/may look things up/)).toHaveCount(0);
  await sheet(page).getByRole('radio', { name: 'Find out' }).check();
  await expect(drawn(page,'Pixel may look things up through Daybook and Open-Meteo. Whoever runs them sees what Pixel looks up.')).toBeVisible();
  await expect(send(page)).toContainText('up to ≈ 1.75¢');
});

// spec: add-pet-errands › Errand sheet screen › error
test('error: the quote did not come — the line and «Try again», the text stays, «Send» has no price; «Try again» reads it again', async ({ page }) => {
  await open(page, { errand: { fail: { status: 0, code: 'unreachable' } } });
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await expect(drawn(page,"We couldn't get Pixel ready for an errand right now. Try again in a moment.")).toBeVisible();
  await expect(send(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(send(page)).not.toContainText('≈');
  await expect(field(page, 'Paste a link or some text')).toHaveValue(DREAMS);
  // the page stands as it was
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
  await setWorker(page, { errand: {} });
  await sheet(page).getByRole('button', { name: 'Try again' }).click();
  await expect(drawn(page,"We couldn't get Pixel ready")).toHaveCount(0);
  await expect(send(page)).toContainText('≈ 0.15¢');
  await expect(send(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(field(page, 'Paste a link or some text')).toHaveValue(DREAMS);
});

// spec: add-pet-errands › Errand flow › can't pay
test("can't pay: in «Send»'s place the line and «Feed Pixel»; the text stays", async ({ page }) => {
  await open(page, { errand: { block: FOOD } }, HUNGRY_PIXEL);
  await sheet(page).getByRole('radio', { name: 'Find out' }).check();
  await field(page, 'What should Pixel find out?').fill(LEONIDS);
  const line = 'This errand needs up to 0.93¢ of food — more than Pixel has. Feed Pixel and your errand will wait here.';
  await expect(drawn(page,line)).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(send(page)).toHaveCount(0);
  await expect(field(page, 'What should Pixel find out?')).toHaveValue(LEONIDS);
});

// spec: add-pet-errands › Errand flow › can't pay
test("can't pay: an asleep pet is no exception — the sheet reached from the rail of an awake page says the same when the food runs out", async ({ page }) => {
  await open(page, { errand: { block: { reason: 'asleep', need: FOOD.need } } });
  await expect(drawn(page,/This errand needs up to 0.93¢ of food/)).toBeVisible();
});

// spec: add-pet-errands › Errand flow › can't pay × Feed sheet and back
test("can't pay × Feed sheet and back: «Feed Pixel» opens Feed sheet over this one; fed — «Send» is back and the text stays", async ({ page }) => {
  await open(page, { errand: { block: FOOD } }, HUNGRY_PIXEL);
  await sheet(page).getByRole('radio', { name: 'Find out' }).check();
  await field(page, 'What should Pixel find out?').fill(LEONIDS);
  await sheet(page).getByRole('button', { name: 'Feed Pixel' }).click();
  const feed = page.getByRole('dialog', { name: 'Feed Pixel' });
  await expect(feed).toBeVisible();
  // the errand's sheet is out of reach while Feed sheet stands over it
  await expect(page.locator('[inert]').filter({ has: page.locator('[role=dialog]', { hasText: 'Send Pixel on an errand' }) })).toHaveCount(1);
  // a meal: the quote has no block now
  await setWorker(page, { errand: { block: null }, pets: { '9': { ...PIXEL, owner: {} }, '2': BISCUIT } });
  await feed.getByRole('button', { name: /^Feed · 5¢/ }).click();
  await expect(feed.getByText(/Thanks|fed|Pixel/).first()).toBeVisible();
  await feed.getByRole('button', { name: 'Close' }).click();
  await expect(feed).toHaveCount(0);
  await expect(send(page)).toBeVisible();
  await expect(drawn(page,/This errand needs up to/)).toHaveCount(0);
  await expect(field(page, 'What should Pixel find out?')).toHaveValue(LEONIDS);
});

// spec: add-pet-errands › Errand flow › out of energy
test('out of energy: instead of «Send» the line with the reset time on the player\'s clock; the text stays', async ({ page }) => {
  await open(page, { errand: { block: { reason: 'energy', until: NEXT_MIDNIGHT } } });
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await expect(drawn(page,'Pixel is resting until 02:00 — errands take energy. Chatting still works.')).toBeVisible();
  await expect(send(page)).toHaveCount(0);
  await expect(field(page, 'Paste a link or some text')).toHaveValue(DREAMS);
});

// spec: add-pet-errands › Errand flow › tired for today
test('tired for today: instead of «Send» the daily cap\'s line; the text stays', async ({ page }) => {
  await open(page, { errand: { block: { reason: 'cap', until: NEXT_MIDNIGHT } } });
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await expect(drawn(page,'Pixel is tired for today. Back at 02:00.')).toBeVisible();
  await expect(send(page)).toHaveCount(0);
});

// spec: add-pet-errands › Errand flow › several blocks at once
test('several blocks at once: only the first the quote names shows — the pause before the food, the food before the energy', async ({ page }) => {
  await open(page, { errand: { paused: true, block: { reason: 'paused' } } });
  await expect(drawn(page,'Chatting is paused on our side while we top up. Your message is kept — Pixel will be back soon.')).toBeVisible();
  await expect(drawn(page,/This errand needs up to/)).toHaveCount(0);
  await expect(drawn(page,/is resting until/)).toHaveCount(0);
  await expect(sheet(page).getByRole('button', { name: 'Feed Pixel' })).toHaveCount(0);
});

// spec: add-pet-errands › Errand flow › can't pay × the pet falls asleep while open
test("can't pay × the pet falls asleep while open: the quote is read again and the block with «Feed Pixel» stands in «Send»'s place", async ({ page }) => {
  await open(page);
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await expect(send(page)).toBeVisible();
  await setWorker(page, { errand: { block: { reason: 'asleep', need: FOOD.need } }, pets: { '9': { ...ASLEEP_PIXEL, owner: {} }, '2': BISCUIT } });
  await lookAgain(page);
  await expect(drawn(page,/This errand needs up to 0.93¢ of food/)).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(field(page, 'Paste a link or some text')).toHaveValue(DREAMS);
});

// spec: add-pet-errands › Errand flow › sent
test('sent: the sheet closes, the job under «You» with its form, the pet is away, and the rail\'s errand item is off', async ({ page }) => {
  await open(page);
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await send(page).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(await calls(page)).toContain('worker:sendErrand:read');
  const log = page.getByRole('log');
  await expect(log).toContainText('Read this');
  await expect(log).toContainText(DREAMS);
  await expect(drawn(page, 'Pixel is off on your errand — back soon, usually within a minute.')).toBeVisible();
  await expect(rail(page)).toBeDisabled();
  // the Hotbar's item is a disabled button now (DS › Hotbar `off`): the focus can not return to it
});

// spec: add-pet-errands › Errand flow › sent × no network at «Send»
test('sent × no network at «Send»: the page\'s connection line, said by the sheet\'s status too; picking a form clears it', async ({ page }) => {
  await open(page);
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await setWorker(page, { sendErrand: { fail: { status: 0, code: 'unreachable' } } });
  await send(page).click();
  const line = "Can't reach Pixel right now. Nothing's lost — try again in a moment.";
  await expect(sheet(page).locator('[role="status"]')).toHaveText(line);
  await expect(sheet(page)).toBeVisible();
  await expect(field(page, 'Paste a link or some text')).toHaveValue(DREAMS);
  await sheet(page).getByRole('radio', { name: 'Find out' }).check();
  await expect(sheet(page).locator('[role="status"]')).toHaveText('');
});

// spec: add-pet-errands › Errand flow › blocked after Send
test('blocked after Send: the server refuses what held at the tap — the block stands in «Send»\'s place, nothing is sent, the text stays', async ({ page }) => {
  await open(page);
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await setWorker(page, { sendErrand: { fail: { status: 409, code: 'blocked', body: { code: 'blocked', block: { reason: 'cap', until: NEXT_MIDNIGHT } } } } });
  await send(page).click();
  await expect(drawn(page,'Pixel is tired for today. Back at 02:00.')).toBeVisible();
  await expect(send(page)).toHaveCount(0);
  await expect(field(page, 'Paste a link or some text')).toHaveValue(DREAMS);
  await expect(rail(page)).toBeEnabled();
  // a block in «Send»'s place keeps the focus in the field (DS › Sheet › Focus)
  await expect(field(page, 'Paste a link or some text')).toBeFocused();
});

// spec: add-pet-errands › Errand flow › sent × another tab sent an errand
test('sent × another tab sent an errand: «Send» is answered that the pet is away — the sheet closes and the page shows it away', async ({ page }) => {
  await open(page);
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await setWorker(page, {
    sendErrand: { fail: { status: 409, code: 'away' } },
    petState: { errand: { state: 'away', form: 'find', job: LEONIDS, sentAt: Date.now() } },
  });
  await send(page).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(drawn(page, 'Pixel is off on your errand — back soon, usually within a minute.')).toBeVisible();
  await expect(rail(page)).toBeDisabled();
});

// spec: add-pet-errands › Errand sheet screen › success × the session ends and sign-in returns
test('success × the session ends and sign-in returns: «Send» finds the session ended — the line and «Sign in» at the body\'s top; after it the sheet is open again with the form and the text', async ({ page }) => {
  await open(page);
  await sheet(page).getByRole('radio', { name: 'Find out' }).check();
  await field(page, 'What should Pixel find out?').fill(LEONIDS);
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await send(page).click();
  await expect(drawn(page,SESSION_LINE).first()).toBeVisible();
  expect((await calls(page)).filter((c) => c.includes('sendErrand'))).toEqual([]);
  await expect(field(page, 'What should Pixel find out?')).toHaveValue(LEONIDS);
  await setWorker(page, { sessionExpired: false });
  await sheet(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole('radio', { name: 'Find out' })).toBeChecked();
  await expect(field(page, 'What should Pixel find out?')).toHaveValue(LEONIDS);
  expect((await calls(page)).filter((c) => c.includes('sendErrand'))).toEqual([]);
  // the owner's line takes none of it
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveValue('');
});

// spec: add-pet-errands › Errand sheet screen › success × sign-out
test('success × sign-out: the player signs out with the sheet open — Home without a session, the sheet and its text gone', async ({ page }) => {
  await open(page);
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await page.getByRole('button', { name: 'Account' }).click();
  // by key: the menu's layer and the sheet's share a level, and the sheet, later in the page, takes the pointer where they overlap
  await page.getByRole('menuitem', { name: 'Sign out' }).press('Enter');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(DREAMS)).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('nearling.returnPlace'))).toBeNull();
});

// spec: add-pet-errands › Errand sheet screen › success × the pet given away
test('success × the pet given away: the pet is not theirs any more — the sheet closes with the owner\'s page, the guest\'s page stands', async ({ page }) => {
  await open(page);
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await setWorker(page, { owned: [], errand: { fail: { status: 403, code: 'not_owner' } } });
  await lookAgain(page);
  await expect(sheet(page)).toHaveCount(0);
  // the guest's page has no owner conversation: no field to talk to Pixel in, only the advice log
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveCount(0);
  await expect(page.getByRole('log')).toHaveAccessibleName('Advice from Pixel');
  await expect(page.getByRole('button', { name: 'Feed Pixel' }).first()).toBeVisible();
});

// spec: add-pet-errands › Errand sheet screen › success × reload
test('success × reload: a reload closes the sheet and the draft is gone', async ({ page }) => {
  await open(page);
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await reloadHolding(page);
  await expect(rail(page)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await rail(page).click();
  await expect(field(page, 'Paste a link or some text')).toHaveValue('');
});

// spec: add-pet-errands › Errand sheet screen › success × the Diary's self-open and the New outfit notice
test('success × the Diary\'s self-open and the New outfit notice: the Diary does not open by itself over the open sheet', async ({ page }) => {
  await open(page);
  await field(page, 'Paste a link or some text').fill(DREAMS);
  await setWorker(page, { pets: { '9': { ...PIXEL, owner: { diaryUnread: true } }, '2': BISCUIT } });
  await lookAgain(page);
  // the poll has read the pet with its entry unread; the Diary waits behind the sheet
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(sheet(page)).toBeVisible();
  await expect(field(page, 'Paste a link or some text')).toHaveValue(DREAMS);
});

// spec: add-pet-errands › Errand sheet screen › success × the Diary's self-open and the New outfit notice
test('success × the Diary\'s self-open and the New outfit notice: the notice waits behind the open sheet and opens when it closes', async ({ page }) => {
  await open(page);
  await field(page, 'Paste a link or some text').fill(DREAMS);
  // an earned item is written to the chain meanwhile: its notice is due
  await setWardrobePet(page, {}, { notices: ['cozy-scarf'], outfits: [...WARDROBE_OWNS, 'cozy-scarf'] });
  await lookAgain(page);
  await page.waitForTimeout(700);
  await expect(page.getByRole('dialog', { name: 'New outfit!' })).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  await expect(field(page, 'Paste a link or some text')).toHaveValue(DREAMS);
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog', { name: 'New outfit!' })).toBeVisible();
});
