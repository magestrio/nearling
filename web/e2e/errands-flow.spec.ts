import { expect, test, type Page } from '@playwright/test';
import type { ConversationLine, ErrandReport, ErrandState } from '../src/seams/worker-types';
import { ASLEEP_PIXEL, BISCUIT, calls, drawn, HISTORY, lookAgain, openWith, OWNER, PIXEL, reloadHolding, setWorker, SIGNED_IN } from './helpers';

// The errand's outing and its report (add-pet-errands › Errand flow, Read this flow, Find out flow, Is it true flow): the pet is away
// — the stage empty, the job under «You», the Composer busy, the rail's errand item off — and comes back with a report, or with the
// line it came back with. The state of the owner (`errand`) is what the page follows; the fakes answer it.
test.use({ timezoneId: 'Etc/GMT-2' });

const LEONIDS = 'When does the Leonid meteor shower peak this year, and when should I look?';
const DREAMS = 'https://example.com/dreams';
const OCTOPUS = 'Octopuses have three hearts.';
const FIND_SAYS = 'The Leonids peak on the night of Nov 16 into Nov 17. Look after midnight, toward the east and away from city lights.';
const NEXT_MIDNIGHT = '2026-11-04T00:00:00.000Z';
const AWAY_LINE = 'Pixel is off on your errand — back soon, usually within a minute.';
const AWAY: ErrandState = { state: 'away', form: 'find', job: LEONIDS, sentAt: 1_700_000_000_000 };
/** the paid errand that came back empty, as the owner's state keeps it for «Try again» until the next errand */
const EMPTY_KEPT: ErrandState = { state: 'failed', form: 'find', job: LEONIDS, reason: 'empty', priceCents: 0.62 };

// spec: add-pet-errands › Errand flow › can't pay
test('a failed errand reopened while asleep keeps its food block and Feed action', async ({ page }) => {
  await open(page, {
    pets: { '9': { ...ASLEEP_PIXEL, owner: {} }, '2': BISCUIT },
    petState: { errand: EMPTY_KEPT },
    conversation: conversation(job('find', LEONIDS), empty(0.62)),
    errand: { block: { reason: 'asleep', need: { yocto: '2000000000000000000000', cents: 0.93 } } },
  });
  await log(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page).getByLabel('What should Pixel find out?')).toHaveValue(LEONIDS);
  await expect(drawn(page, 'This errand needs up to 0.93¢ of food — more than Pixel has. Feed Pixel and your errand will wait here.')).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
});

const job = (form: 'read' | 'find' | 'check', text: string): ConversationLine => ({ id: 'e1:you', who: 'player', kicker: form, text, at: 1_700_000_000_100 });
const report = (r: Partial<ErrandReport>, text = FIND_SAYS): ConversationLine => ({
  id: 'e1',
  who: 'pet',
  text,
  at: 1_700_000_000_101,
  report: { form: 'find', sources: [{ label: 'in-the-sky.org', url: 'https://in-the-sky.org/a' }], verdict: null, searches: 1, priceCents: 0.66, missed: [], ...r },
});
const empty = (priceCents: number): ConversationLine => ({ id: 'e1', who: 'error', code: 'errand_empty', priceCents, at: 1_700_000_000_101 });
const conversation = (...tail: ConversationLine[]) => ({ lines: [...HISTORY, ...tail], more: false, before: null });

const rail = (page: Page) => page.getByRole('button', { name: 'Send Pixel on an errand' });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Send Pixel on an errand' });
const log = (page: Page) => page.getByRole('log');
const open = (page: Page, worker: Record<string, unknown> = {}) =>
  openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, owner: {} }, '2': BISCUIT }, conversation: conversation(), ...worker } });
/** the sheet opened, a form picked and its field filled, «Send» tapped */
const sendErrand = async (page: Page, form: 'Find out' | 'Is it true?', label: string, text: string) => {
  await rail(page).click();
  await sheet(page).getByRole('radio', { name: form }).check();
  await sheet(page).getByLabel(label).fill(text);
  await sheet(page).getByRole('button', { name: /^Send\b/ }).click();
};

// spec: add-pet-errands › Errand flow › sent
test('sent: the stage empties, the job under «You» with its form, the thinking line, the Composer busy and the rail\'s errand item off', async ({ page }) => {
  await open(page);
  await expect(page.locator('.ds-away')).toHaveCount(0);
  await sendErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.locator('.ds-away')).toHaveCount(1);
  await expect(page.locator('.ds-away')).toHaveAttribute('aria-hidden', 'true');
  await expect(log(page).locator('.ds-message__kicker', { hasText: 'Find out' })).toBeVisible();
  await expect(log(page)).toContainText(LEONIDS);
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(rail(page)).toBeDisabled();
});

// spec: add-pet-errands › Errand flow › sent × no WebGL
test('sent × no WebGL: the flat page has «Pause motion» while the pet is away, and it stops the walker', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
      return (original as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof original;
  });
  await open(page);
  await expect(page.getByRole('button', { name: 'Pause motion' })).toHaveCount(0);
  await sendErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
  await expect(page.locator('.ds-away')).toHaveCount(1);
  await page.getByRole('button', { name: 'Pause motion' }).click();
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
  await expect(page.locator('.ds-away__walker')).toHaveCSS('animation-play-state', 'paused');
});

// spec: add-pet-errands › Errand flow › sent × the Composer's send while away
test("sent × the Composer's send while away: «Send» and «Think hard» do nothing, no line goes to the pet", async ({ page }) => {
  await open(page, { petState: { errand: AWAY } });
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  const field = page.getByPlaceholder('Talk to Pixel…');
  await field.fill('Are you back yet?');
  await field.press('Enter');
  // busy buttons keep the focus and take the tap (aria-disabled): the tap must do nothing
  await page.getByRole('button', { name: 'Send', exact: true }).dispatchEvent('click');
  await page.getByRole('button', { name: /Think hard/ }).dispatchEvent('click');
  await expect(log(page)).not.toContainText('Are you back yet?');
  expect((await calls(page)).filter((c) => c.startsWith('worker:say'))).toEqual([]);
  await expect(field).toHaveValue('Are you back yet?');
});

// spec: add-pet-errands › Errand flow › sent × the rail's errand item while away
test("sent × the rail's errand item while away: the Hotbar's item is disabled and a tap on it opens nothing", async ({ page }) => {
  await open(page, { petState: { errand: AWAY } });
  await expect(rail(page)).toBeDisabled();
  await rail(page).dispatchEvent('click');
  await expect(sheet(page)).toHaveCount(0);
  await expect(rail(page)).toBeDisabled();
});

// spec: add-pet-errands › Errand flow › sent × Feed while away
test('sent × Feed while away: «Feed Pixel» works — any food pays', async ({ page }) => {
  await open(page, { petState: { errand: AWAY } });
  await page.getByRole('button', { name: 'Feed Pixel' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Feed Pixel' })).toBeVisible();
});

// spec: add-pet-errands › Errand flow › tab closed while away
test('tab closed while away: a page opened again finds the pet away, with the job under «You», then back with its report', async ({ page }) => {
  await open(page, { petState: { errand: AWAY } });
  await expect(page.locator('.ds-away')).toHaveCount(1);
  await expect(log(page)).toContainText(LEONIDS);
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await expect(rail(page)).toBeDisabled();
  await setWorker(page, { petState: { errand: null }, conversation: conversation(job('find', LEONIDS), report({})) });
  await lookAgain(page);
  await expect(page.locator('.ds-away')).toHaveCount(0);
  await expect(log(page)).toContainText(FIND_SAYS);
  await expect(drawn(page, AWAY_LINE)).toHaveCount(0);
  await expect(rail(page)).toBeEnabled();
});

// spec: add-pet-errands › Errand flow › tab closed while away × reload
test('tab closed while away × reload: the reload finds the pet still away, once, with no second job line', async ({ page }) => {
  await open(page, { petState: { errand: AWAY } });
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await reloadHolding(page);
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await expect(log(page).getByText(LEONIDS)).toHaveCount(1);
  await expect(page.locator('.ds-away')).toHaveCount(1);
});

// spec: add-pet-errands › Errand flow › report
test('report: the pet is back, the find card under its name with the form, its words, «Sources» in new tabs, the exact price and «Check this thought»', async ({ page }) => {
  await open(page);
  await sendErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await setWorker(page, {
    petState: { errand: null },
    conversation: conversation(job('find', LEONIDS), report({ sources: [{ label: 'in-the-sky.org', url: 'https://in-the-sky.org/a' }, { label: 'timeanddate.com', url: 'https://timeanddate.com/b' }], searches: 3, priceCents: 1.4 })),
    pets: { '9': { ...PIXEL, fullness: { state: 'hungry', level: 0.83 }, owner: {} }, '2': BISCUIT },
  });
  await lookAgain(page);
  const card = log(page).locator('.ds-message--report');
  await expect(card).toContainText(FIND_SAYS);
  await expect(card.locator('.ds-message__kicker')).toHaveText('Find out');
  await expect(card.getByText('Sources')).toBeVisible();
  const links = card.locator('.ds-message__source-list a');
  await expect(links).toHaveText(['in-the-sky.org', 'timeanddate.com']);
  await expect(links.first()).toHaveAttribute('target', '_blank');
  await expect(links.first()).toHaveAttribute('href', 'https://in-the-sky.org/a');
  await expect(card.getByText('3 searches · 1.4¢')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', '/pet/9/verify/e1');
  await expect(log(page).getByText(LEONIDS)).toHaveCount(1);
  await expect(page.locator('.ds-away')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Share card' })).toHaveCount(0);
});

// spec: add-pet-errands › Errand flow › report × lands on a slow phone
test('report × lands on a slow phone: the card taller than the log stands from its top at the log\'s top once it has risen in', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // a slow device: the card's rise is still under way when the log settles on it
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '.ds-message--fresh { animation-duration: 1500ms !important; }';
      document.head.append(style);
    });
  });
  await open(page, { petState: { errand: AWAY } });
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  const long = `${FIND_SAYS} ${FIND_SAYS} ${FIND_SAYS}`;
  await setWorker(page, { petState: { errand: null }, conversation: conversation(job('find', LEONIDS), report({ searches: 3, priceCents: 1.4 }, long)) });
  await lookAgain(page);
  const card = log(page).locator('[data-reveal]');
  await expect(card).toBeVisible();
  await page.waitForTimeout(1800);
  const gap = await card.evaluate((el) => {
    const log = el.closest('[role="log"]')!;
    const edge = log.getBoundingClientRect().top + (parseFloat(getComputedStyle(log).scrollPaddingBlockStart) || 0);
    return Math.round(el.getBoundingClientRect().top - edge);
  });
  expect(Math.abs(gap)).toBeLessThan(2);
});

// spec: add-pet-errands › Errand flow › report × reload
test('report × reload: the report stands in the log as it was, no longer fresh', async ({ page }) => {
  await open(page, { conversation: conversation(job('find', LEONIDS), report({ searches: 1, priceCents: 0.66 })) });
  const card = log(page).locator('.ds-message--report');
  await expect(card.getByText('1 search · 0.66¢')).toBeVisible();
  await expect(card).not.toHaveClass(/ds-message--fresh/);
  await reloadHolding(page);
  await expect(card.getByText('1 search · 0.66¢')).toBeVisible();
});

// spec: add-pet-errands › Read this flow › page can't be read
test('a read: its source is the link, the price line says «Read · {price}»; pasted text has «Your text» as words, no link', async ({ page }) => {
  await open(page, {
    conversation: conversation(
      job('read', DREAMS),
      report({ form: 'read', sources: [{ label: 'example.com', url: DREAMS }], searches: 0, priceCents: 0.14 }, 'The piece says most dreams fade within minutes.'),
      { ...job('read', 'Our lease says sixty days.'), id: 'e2:you' },
      { ...report({ form: 'read', sources: [{ label: 'Your text' }], searches: 0, priceCents: 0.11 }, 'Two dates matter.'), id: 'e2' },
    ),
  });
  const cards = log(page).locator('.ds-message--report');
  await expect(cards.first().getByText('Read · 0.14¢')).toBeVisible();
  await expect(cards.first().getByRole('link', { name: 'example.com' })).toHaveAttribute('target', '_blank');
  await expect(cards.first().getByRole('link', { name: 'example.com' })).toHaveAttribute('href', DREAMS);
  await expect(cards.last().getByText('Read · 0.11¢')).toBeVisible();
  await expect(cards.last().getByText('Your text')).toBeVisible();
  await expect(cards.last().getByRole('link')).toHaveCount(1);
});

// spec: add-pet-errands › Is it true flow › verdict
test('verdict: the stamp above the reasons, «Sources», the price and «Share card»; unclear leads with its line', async ({ page }) => {
  await open(page, {
    conversation: conversation(
      job('check', OCTOPUS),
      report({ form: 'check', verdict: 'true', searches: 2, priceCents: 1.1 }, 'Two hearts pump blood through the gills.'),
      { ...job('check', 'The first cat café opened in Taipei in 1998.'), id: 'e2:you' },
      { ...report({ form: 'check', verdict: 'unclear', searches: 3, priceCents: 1.4 }, 'Several sites name a café.'), id: 'e2' },
    ),
  });
  const cards = log(page).locator('.ds-message--report');
  await expect(cards.first().locator('.ds-message__stamp')).toHaveText('True');
  await expect(cards.first().getByRole('button', { name: 'Share card' })).toBeVisible();
  await expect(cards.last().locator('.ds-message__stamp')).toHaveCount(0);
  await expect(cards.last().getByText("Unclear — Pixel couldn't find enough to say either way.")).toBeVisible();
  await expect(cards.last().getByRole('button', { name: 'Share card' })).toBeVisible();
});

// spec: add-pet-errands › Find out flow › nothing found
test('nothing found: the line above the short report, no «Sources», the price line stays', async ({ page }) => {
  await open(page, { conversation: conversation(job('find', LEONIDS), report({ sources: [], searches: 2, priceCents: 0.98 }, 'Nothing recent turned up.')) });
  const card = log(page).locator('.ds-message--report');
  await expect(card.getByText('Pixel looked but found nothing solid on this.')).toBeVisible();
  await expect(card.getByText('Sources')).toHaveCount(0);
  await expect(card.getByText('2 searches · 0.98¢')).toBeVisible();
});

// spec: add-pet-errands › Adapter call rule › data failed in an errand
test('data failed in an errand: the data source that did not answer stands as a grey line under the words', async ({ page }) => {
  await open(page, { conversation: conversation(job('find', LEONIDS), report({ missed: ['Daybook'] })) });
  await expect(log(page).getByText("Daybook didn't answer, so Pixel went on without it.")).toBeVisible();
});

// spec: add-pet-errands › Adapter call rule › data failed in an errand, code
test('data failed in an errand, code: the skill\'s code that did not answer stands as a grey line under the words, beside a source that did not', async ({ page }) => {
  await open(page, { conversation: conversation(job('find', LEONIDS), report({ missed: ['Daybook', { code: true }] })) });
  await expect(log(page).getByText("Daybook didn't answer, so Pixel went on without it.")).toBeVisible();
  await expect(log(page).getByText("Pixel's code didn't answer, so Pixel went on without it.")).toBeVisible();
});

// spec: add-pet-errands › Errand flow › came back empty
test('came back empty: the line with what the searches cost and «Try again»; the fullness lower by what was spent', async ({ page }) => {
  await open(page, { petState: { errand: EMPTY_KEPT }, conversation: conversation(job('find', LEONIDS), empty(0.62)) });
  await expect(drawn(page, 'Pixel came back empty-handed. Its searches still cost 0.62¢. Your errand is kept — try again.')).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Try again' })).toBeVisible();
});

// spec: add-pet-errands › Errand flow › came back empty × reload
test('came back empty × reload: the line and «Try again» come back from the conversation, with the form and the job', async ({ page }) => {
  await open(page, { petState: { errand: EMPTY_KEPT }, conversation: conversation(job('find', LEONIDS), empty(0.62)) });
  await reloadHolding(page);
  await expect(log(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await log(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page).getByRole('radio', { name: 'Find out' })).toBeChecked();
  await expect(sheet(page).getByLabel('What should Pixel find out?')).toHaveValue(LEONIDS);
});

// spec: add-pet-errands › Errand flow › try again
test('try again: «Try again» opens the sheet with the same form and job and a fresh price; sending is a new errand', async ({ page }) => {
  await open(page, { petState: { errand: EMPTY_KEPT }, conversation: conversation(job('find', LEONIDS), empty(0.62)) });
  await log(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page).getByLabel('What should Pixel find out?')).toHaveValue(LEONIDS);
  await expect(sheet(page).getByRole('button', { name: /^Send\b/ })).toContainText('up to ≈ 2¢');
  expect(await calls(page)).toContain('worker:errand:find');
  await sheet(page).getByRole('button', { name: /^Send\b/ }).click();
  expect(await calls(page)).toContain('worker:sendErrand:find');
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
});

// spec: add-pet-errands › Errand flow › try again × a new errand sent
test('try again × a new errand sent: the old line stays in the conversation as it was', async ({ page }) => {
  await open(page, { petState: { errand: EMPTY_KEPT }, conversation: conversation(job('find', LEONIDS), empty(0.62)) });
  await log(page).getByRole('button', { name: 'Try again' }).click();
  await sheet(page).getByRole('button', { name: /^Send\b/ }).click();
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await expect(drawn(page, /came back empty-handed/)).toBeVisible();
});

// spec: add-pet-errands › Errand flow › not back in 3 minutes
test('not back in 3 minutes: with nothing spent — the line, «Try again», the pet back; its errand opens in the sheet again', async ({ page }) => {
  await open(page, { petState: { errand: AWAY } });
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await setWorker(page, { petState: { errand: { state: 'failed', form: 'find', job: LEONIDS, reason: 'timeout' } } });
  await lookAgain(page);
  await expect(drawn(page, "Pixel didn't make it back with a report. Nothing was spent — your errand is kept, try again.")).toBeVisible();
  await expect(page.locator('.ds-away')).toHaveCount(0);
  await expect(drawn(page, AWAY_LINE)).toHaveCount(0);
  await log(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page).getByLabel('What should Pixel find out?')).toHaveValue(LEONIDS);
});

// spec: add-pet-errands › Errand flow › failed errand after a reload
test('failed errand after a reload: its form, job, line and «Try again» are there when the page opens, once', async ({ page }) => {
  await open(page, { petState: { errand: { state: 'failed', form: 'read', job: 'https://example.com/members/plan', reason: 'unreadable' } } });
  await expect(drawn(page, "Pixel couldn't open that page. Paste its text and Pixel will read that instead. Nothing was spent.")).toBeVisible();
  await expect(log(page).locator('.ds-message__kicker', { hasText: 'Read this' })).toBeVisible();
  await expect(log(page)).toContainText('https://example.com/members/plan');
  // the next looks do not draw it twice
  await lookAgain(page);
  await lookAgain(page);
  await expect(log(page).getByText('https://example.com/members/plan')).toHaveCount(1);
  await expect(log(page).getByRole('button', { name: 'Try again' })).toHaveCount(1);
  await log(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page).getByRole('radio', { name: 'Read this' })).toBeChecked();
  await expect(sheet(page).getByLabel('Paste a link or some text')).toHaveValue('https://example.com/members/plan');
});

// spec: add-pet-errands › Read this flow › too long
test('too long: the pet comes back with its line and «Try again»', async ({ page }) => {
  await open(page, { petState: { errand: { state: 'failed', form: 'read', job: 'https://example.com/books/moby-dick', reason: 'too_long' } } });
  await expect(drawn(page, "That's too long for Pixel to read in one go. Try a single page or a shorter piece. Nothing was spent.")).toBeVisible();
});

// spec: add-pet-errands › Find out flow › web search down
test('web search down: nothing spent, the errand kept with «Try again»', async ({ page }) => {
  await open(page, { petState: { errand: { state: 'failed', form: 'find', job: LEONIDS, reason: 'search_down', cause: 'unreachable' } } });
  await expect(drawn(page, "Pixel couldn't reach web search just now. Nothing was spent — your errand is kept.")).toBeVisible();
});

// spec: add-pet-errands › Find out flow › web search down, past three
test('web search down, past three: the line says the try used a little of the food, and the conversation holds the paid receipt', async ({ page }) => {
  await open(page, {
    petState: { errand: { state: 'failed', form: 'find', job: LEONIDS, reason: 'search_down', cause: 'no_search', priceCents: 0.16 } },
    conversation: conversation(job('find', LEONIDS), empty(0.16)),
  });
  await expect(drawn(page, "Pixel couldn't reach web search just now. The try used a little of Pixel's food — your errand is kept.")).toBeVisible();
  await expect(log(page).getByText(LEONIDS)).toHaveCount(1);
  await expect(log(page).getByRole('button', { name: 'Try again' })).toHaveCount(1);
});

// spec: add-pet-errands › Errand flow › memory cleared on the way
test('memory cleared on the way: the cleared conversation, then the line that the report was not kept and the errand still used food', async ({ page }) => {
  await open(page);
  await sendErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await page.getByRole('button', { name: 'Clear memory' }).click();
  await expect(drawn(page, "Pixel's memory is clear — same Pixel, fresh start.")).toBeVisible();
  await expect(log(page).getByText(LEONIDS)).toHaveCount(0);
  await setWorker(page, { petState: { errand: null, code: 'memory_cleared', price: { yocto: '3000000000000000000000', cents: 1.4 } } });
  await lookAgain(page);
  await expect(drawn(page, "Pixel's memory was cleared while it was out, so this report wasn't kept. The errand still used 1.4¢ of food.")).toBeVisible();
  await expect(log(page).locator('.ds-message--report')).toHaveCount(0);
  await expect(page.locator('.ds-away')).toHaveCount(0);
});

// spec: add-pet-errands › Errand flow › blocked after Send
test('blocked after Send: the pet is back and Errand sheet opens with the form, the job and the first block in «Send»\'s place', async ({ page }) => {
  await open(page, { petState: { errand: AWAY }, errand: { block: { reason: 'cap', until: NEXT_MIDNIGHT } } });
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await setWorker(page, { petState: { errand: { state: 'failed', form: 'find', job: LEONIDS, reason: 'blocked' } } });
  await lookAgain(page);
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole('radio', { name: 'Find out' })).toBeChecked();
  await expect(sheet(page).getByLabel('What should Pixel find out?')).toHaveValue(LEONIDS);
  await expect(drawn(page, 'Pixel is tired for today. Back at 02:00.')).toBeVisible();
  await expect(page.locator('.ds-away')).toHaveCount(0);
  // closing it leaves the failed row: the next looks do not open it again
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await lookAgain(page);
  await page.waitForTimeout(400);
  await expect(sheet(page)).toHaveCount(0);
});

// spec: add-pet-errands › Errand flow › blocked after Send × the sheet closed without a new Send
test('blocked after Send × the sheet closed without a new Send: the job under «You» and «Try again» stay in the conversation, once', async ({ page }) => {
  await open(page, { petState: { errand: AWAY }, errand: { block: { reason: 'cap', until: NEXT_MIDNIGHT } } });
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await setWorker(page, { petState: { errand: { state: 'failed', form: 'find', job: LEONIDS, reason: 'blocked' } } });
  await lookAgain(page);
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(log(page).getByText(LEONIDS)).toHaveCount(1);
  await expect(log(page).locator('.ds-message__kicker', { hasText: 'Find out' })).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Try again' })).toHaveCount(1);
  await lookAgain(page);
  await page.waitForTimeout(400);
  await expect(log(page).getByRole('button', { name: 'Try again' })).toHaveCount(1);
  await log(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page).getByLabel('What should Pixel find out?')).toHaveValue(LEONIDS);
});

// spec: add-pet-errands › Errand flow › failed errand after a reload × a blocked errand
test('failed errand after a reload × a blocked errand: the page opens with its job and «Try again», and the sheet does not open by itself', async ({ page }) => {
  await open(page, { petState: { errand: { state: 'failed', form: 'find', job: LEONIDS, reason: 'blocked' } }, errand: { block: { reason: 'cap', until: NEXT_MIDNIGHT } } });
  await expect(log(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(log(page).getByText(LEONIDS)).toHaveCount(1);
  await lookAgain(page);
  await page.waitForTimeout(400);
  await expect(sheet(page)).toHaveCount(0);
  await reloadHolding(page);
  await expect(log(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.waitForTimeout(400);
  await expect(sheet(page)).toHaveCount(0);
});

// spec: add-pet-errands › Errand flow › memory cleared on the way × reload
test('memory cleared on the way × reload: the first look of a page opened after the clear says the line from the state, once', async ({ page }) => {
  await open(page, { petState: { errand: { state: 'done', cleared: true, priceCents: 1.4 } }, conversation: { lines: [], more: false, before: null } });
  const line = drawn(page, "Pixel's memory was cleared while it was out, so this report wasn't kept. The errand still used 1.4¢ of food.");
  await expect(line).toBeVisible();
  // the fake keeps answering it; the page says it once
  await lookAgain(page);
  await lookAgain(page);
  await page.waitForTimeout(400);
  await expect(line).toHaveCount(1);
});

// spec: add-pet-errands › Errand flow › memory cleared on the way × another tab
test('memory cleared on the way × another tab: a page that saw the pet away gets the line from the state when the errand ends', async ({ page }) => {
  await open(page, { petState: { errand: AWAY } });
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await setWorker(page, { petState: { errand: { state: 'done', cleared: true, priceCents: 1.4 } }, conversation: { lines: [], more: false, before: null } });
  await lookAgain(page);
  await expect(drawn(page, "Pixel's memory was cleared while it was out, so this report wasn't kept. The errand still used 1.4¢ of food.")).toHaveCount(1);
  await expect(page.locator('.ds-away')).toHaveCount(0);
});

// spec: add-pet-errands › Errand flow › memory cleared on the way × the sending tab
test('memory cleared on the way × the sending tab: the job outcome and the state both say it, and the line is drawn once', async ({ page }) => {
  await open(page);
  await sendErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await setWorker(page, {
    petState: { errand: { state: 'done', cleared: true, priceCents: 1.4 }, code: 'memory_cleared', price: { yocto: '3000000000000000000000', cents: 1.4 } },
    conversation: { lines: [], more: false, before: null },
  });
  await lookAgain(page);
  const line = drawn(page, "Pixel's memory was cleared while it was out, so this report wasn't kept. The errand still used 1.4¢ of food.");
  await expect(line).toBeVisible();
  await lookAgain(page);
  await lookAgain(page);
  await page.waitForTimeout(400);
  await expect(line).toHaveCount(1);
});

// spec: add-pet-errands › Errand flow › failed errand after a reload × an older failed errand
test('failed errand after a reload × an older failed errand: only the one the state keeps has «Try again»; a new errand takes it away', async ({ page }) => {
  const older: ConversationLine[] = [
    { id: 'e0:you', who: 'player', kicker: 'find', text: 'Is the old bridge open?', at: 1_699_000_000_000 },
    { id: 'e0', who: 'error', code: 'errand_empty', priceCents: 0.5, at: 1_699_000_000_001 },
  ];
  await open(page, {
    petState: { errand: { state: 'failed', form: 'find', job: LEONIDS, reason: 'empty', priceCents: 0.62 } },
    conversation: conversation(...older, job('find', LEONIDS), empty(0.62)),
  });
  await expect(drawn(page, /came back empty-handed\. Its searches still cost 0\.62¢/)).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Try again' })).toHaveCount(1);
  await log(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page).getByLabel('What should Pixel find out?')).toHaveValue(LEONIDS);
  await sheet(page).getByRole('button', { name: /^Send\b/ }).click();
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await expect(drawn(page, /came back empty-handed\. Its searches still cost 0\.62¢/)).toBeVisible();
  await expect(log(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

// spec: add-pet-errands › Errand flow › failed errand after a reload × a new errand
test('failed errand after a reload × a new errand: the job and the line drawn for one that spent nothing go with the next errand', async ({ page }) => {
  await open(page, { petState: { errand: { state: 'failed', form: 'read', job: 'https://example.com/members/plan', reason: 'unreadable' } } });
  await expect(drawn(page, /couldn't open that page/)).toBeVisible();
  await sendErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await expect(drawn(page, /couldn't open that page/)).toHaveCount(0);
  await expect(log(page).getByText('https://example.com/members/plan')).toHaveCount(0);
  await expect(log(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

// spec: add-pet-errands › Errand flow › blocked after Send × Feed sheet and back
test('blocked after Send × Feed sheet and back: the food block shows «Feed Pixel» over the sheet; closed again, the sheet and its text are there', async ({ page }) => {
  await open(page, {
    petState: { errand: AWAY },
    errand: { block: { reason: 'food', need: { yocto: '2000000000000000000000', cents: 0.93 } } },
    pets: { '9': { ...PIXEL, fullness: { state: 'hungry', level: 0.1 }, owner: {} }, '2': BISCUIT },
  });
  await expect(drawn(page, AWAY_LINE)).toBeVisible();
  await setWorker(page, { petState: { errand: { state: 'failed', form: 'find', job: LEONIDS, reason: 'blocked' } } });
  await lookAgain(page);
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Feed Pixel' }).click();
  const feed = page.getByRole('dialog', { name: 'Feed Pixel' });
  await expect(feed).toBeVisible();
  await feed.getByRole('button', { name: 'Close' }).click();
  await expect(feed).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByLabel('What should Pixel find out?')).toHaveValue(LEONIDS);
});
