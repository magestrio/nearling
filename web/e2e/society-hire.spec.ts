import { expect, test, type Page } from '@playwright/test';
import { BISCUIT, calls, HISTORY, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';
import type { ConversationLine, HireMeta } from '../src/seams/worker-types';
import { sampleDiary } from '../src/seams/diary.sample';

test.use({ timezoneId: 'Etc/GMT-2' });
const me = { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };
const breakUntil = '2099-01-01T16:00:00.000Z';

// spec: add-pet-society › Society hire flow › player advice quote
test('liked advice shows the effective quote before the tap', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT }, me,
    advice: { price: { yocto: '747000000000000000000', cents: 0.34 }, discounted: true } } });
  await expect(page.getByText('Pixel and Biscuit get along. Ask · 0.34¢')).toBeVisible();
  await page.getByPlaceholder('Ask Biscuit for advice…').fill('Can you help?');
  await expect(page.getByRole('button', { name: 'Ask · 0.34¢' })).toBeEnabled();
});

// spec: add-pet-society › Society hire flow › player advice refused
test('relationship refusal keeps advice unsent and offers another pet', async ({ page }) => {
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT }, me,
    advice: { refusalUntil: breakUntil } } });
  await expect(page.getByText('Biscuit needs a break from Pixel until 18:00. No food was spent.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ask another pet' })).toHaveAttribute('href', '/hire');
  await page.getByPlaceholder('Ask Biscuit for advice…').fill('Can you help?');
  await page.getByPlaceholder('Ask Biscuit for advice…').press('Enter');
  expect((await calls(page)).filter((call) => call.startsWith('worker:askAdvice:'))).toEqual([]);
});

// spec: add-pet-society › Society hire flow › player advice refused × phone Dock
test('on a phone the Hotbar stays at the viewport bottom while the page scrolls, and «Ask another pet» is in reach', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT }, me, advice: { refusalUntil: breakUntil } } });
  const hotbar = page.locator('.ds-stage__hotbar');
  await expect(page.getByRole('link', { name: 'Ask another pet' })).toBeVisible();
  const resting = await hotbar.evaluate((el) => el.getBoundingClientRect().bottom);
  expect(resting).toBeGreaterThan(844 - 8);
  await page.evaluate(() => window.scrollBy(0, 500));
  expect(await hotbar.evaluate((el) => el.getBoundingClientRect().bottom)).toBeCloseTo(resting, 0);
  await page.getByRole('link', { name: 'Ask another pet' }).scrollIntoViewIfNeeded();
  const link = await page.getByRole('link', { name: 'Ask another pet' }).boundingBox();
  const bar = (await hotbar.boundingBox())!;
  expect(link!.y + link!.height).toBeLessThanOrEqual(bar.y + 1);
});

// spec: add-pet-society › Society hire flow › manual quote
test('liked Manual offer names its price and keeps Ask available', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { ...OWNER.pets, '9': { ...PIXEL, owner: { hireMode: 'manual', offer: { worker: 'Biscuit', question: 'How do I say this?', price: { yocto: '747000000000000000000', cents: 0.34 }, discounted: true } } } },
    conversation: { lines: [{ id: 'q', who: 'pet', text: 'How do I say this?', at: 1, hireTo: 'Biscuit' }], more: false, before: null } } });
  await expect(page.getByText('Pixel likes Biscuit. Ask Biscuit · 0.34¢')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask Biscuit · 0.34¢' })).toBeVisible();
});

// spec: add-pet-society › Society diary flow › named social line
test('diary shows private social words and removes them on an ownership failure', async ({ page }) => {
  const diary = sampleDiary();
  if (diary.entry.kind !== 'text') throw new Error('sample entry');
  await openWith(page, '/pet/9/diary', { auth: SIGNED_IN, worker: { ...OWNER, diary: { entry: { ...diary.entry, socialLines: ['I think Biscuit and I are getting closer.'] } } } });
  await expect(page.getByText('I think Biscuit and I are getting closer.')).toBeVisible();
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(page.getByText('I think Biscuit and I are getting closer.')).toHaveCount(0);
});

// spec: add-pet-society › Society diary data › owner diary read × sign-out/expiry/gift/hidden/reload/site erase
test('a signed-out diary does not retain its social words', async ({ page }) => {
  const diary = sampleDiary();
  if (diary.entry.kind !== 'text') throw new Error('sample entry');
  await openWith(page, '/pet/9/diary', { auth: SIGNED_IN, worker: { ...OWNER, diary: { entry: { ...diary.entry, socialLines: ['I think Biscuit and I are getting closer.'] } } } });
  await expect(page.getByText('I think Biscuit and I are getting closer.')).toBeVisible();
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await expect(page.getByText('I think Biscuit and I are getting closer.')).toHaveCount(0);
});

// spec: add-pet-society › Society diary flow › settled gossip
test('diary shows gossip only when the Worker returns a settled social line', async ({ page }) => {
  const diary = sampleDiary();
  if (diary.entry.kind !== 'text') throw new Error('sample entry');
  await openWith(page, '/pet/9/diary', { auth: SIGNED_IN, worker: { ...OWNER, diary: { entry: { ...diary.entry, socialLines: ['I have a story about helping Nori yesterday.'] } } } });
  await expect(page.getByText('I have a story about helping Nori yesterday.')).toBeVisible();
});


// spec: add-pet-society › Society hire flow › player advice refused × phone Dock
test('on a short zoomed phone the question field stays reachable at the end of the page', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 225 });
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT }, me,
    advice: { price: { yocto: '747000000000000000000', cents: 0.34 }, discounted: true } } });
  const field = page.getByPlaceholder('Ask Biscuit for advice…');
  await field.fill('Can you help me find the words for a long, long message? '.repeat(12));
  // scrolled to the page's end the field's last line is in the viewport with nothing over it: the sticky Hotbar leaves with its Stage
  // at this height (DS finding), it never hides the field for good
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await field.focus();
  const reached = await field.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const y = Math.min(r.bottom - 4, innerHeight - 4);
    return { inView: r.bottom > 0 && r.bottom <= innerHeight + 0.5, hit: el.contains(document.elementFromPoint(r.x + r.width / 2, y)) };
  });
  expect(reached).toEqual({ inView: true, hit: true });
  await expect(field).toBeFocused();
});

// spec: add-pet-society › Society playtest data › social diary seen
test('opening a diary with a social line sends one coded event; a diary without one sends none', async ({ page }) => {
  const diary = sampleDiary();
  if (diary.entry.kind !== 'text') throw new Error('sample entry');
  await openWith(page, '/pet/9/diary', { auth: SIGNED_IN, worker: { ...OWNER, diary: { entry: { ...diary.entry, socialLines: ['I think Biscuit and I are getting closer.'] } } } });
  await expect(page.getByText('I think Biscuit and I are getting closer.')).toBeVisible();
  await expect.poll(async () => (await calls(page)).filter((call) => call.startsWith('worker:societyDiarySeen'))).toEqual(['worker:societyDiarySeen:eventId,petId,playerId,tabId']);
  await lookAgain(page);
  await expect(page.getByText('I think Biscuit and I are getting closer.')).toBeVisible();
  expect((await calls(page)).filter((call) => call.startsWith('worker:societyDiarySeen'))).toHaveLength(1);
});

// spec: add-pet-society › Society playtest data › social diary seen
test('a diary with no social line sends no society event', async ({ page }) => {
  await openWith(page, '/pet/9/diary', { auth: SIGNED_IN, worker: { ...OWNER, diary: {} } });
  await expect(page.getByRole('heading', { level: 1 }).or(page.getByRole('main')).first()).toBeVisible();
  await page.waitForTimeout(400);
  expect((await calls(page)).filter((call) => call.startsWith('worker:societyDiarySeen'))).toEqual([]);
});

// The hire turns, driven through the page: the owner's tap or typed line starts the Worker call; the Worker's answer is what the
// fake serves next (the conversation and the pet's state, as the real routes tell them after the job).
const ASKED = 'And if they ask why the chart matters?';
const QUESTION = 'How do you make a room care about a chart in one sentence?';
const PET_ALONE = 'Say what the chart changed for you — one sentence. Then let the room catch up.';
const PET_SAYS = 'Biscuit says: one sentence on what changed for you, then a pause.';
const BISCUIT_SAYS = 'Tell them what the chart changed for you. One sentence, then stop.';
const MOCHI = { tokenId: '1', name: 'Mochi' };
const NORI = { tokenId: '5', name: 'Nori' };
const LIKED = { yocto: '747000000000000000000', cents: 0.34 };
const you: ConversationLine = { id: 'h1:you', who: 'player', text: ASKED, at: 10 };
const asked = (to: string): ConversationLine => ({ id: 'h1', who: 'pet', text: QUESTION, at: 11, cut: null, hireTo: to });
const ownReply = (text: string, hire?: HireMeta): ConversationLine => ({ id: 'h3', who: 'pet', text, at: 13, cut: null, ...(hire ? { hire } : {}) });
const conversation = (...lines: ConversationLine[]) => ({ lines: [...(HISTORY as ConversationLine[]), ...lines], more: false, before: null });
const log = (page: Page) => page.getByRole('log');
const status = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });
const hireCalls = async (page: Page) => (await calls(page)).filter((call) => /^worker:(say:|askOffer:|askAdvice:)|^worker:(declineOffer|finishHire)$/.test(call));
const pixel = (owner: Record<string, unknown>) => ({ ...OWNER, pets: { '9': { ...PIXEL, owner }, '2': BISCUIT } });
const typeLine = async (page: Page) => {
  const field = page.getByPlaceholder('Talk to Pixel…');
  await field.fill(ASKED);
  await field.press('Enter');
  await expect(log(page)).toContainText(ASKED);
};
const refusedManual: ConversationLine = { id: 'h2', who: 'event', code: 'society_refused', hireMode: 'manual', worker: MOCHI, refusalUntil: breakUntil, at: 12 };
const OFFER = { worker: 'Mochi', question: QUESTION, price: { yocto: '380000000000000000000', cents: 0.38 } };
/** The Manual offer to Mochi stands, the owner taps «Ask Mochi», and the Worker refuses the hire for the pair's break. */
async function askRefusedMochi(page: Page): Promise<void> {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...pixel({ hireMode: 'manual', offer: OFFER }), conversation: conversation(you, asked('Mochi')), petState: { pending: true } } });
  await log(page).getByRole('button', { name: 'Ask Mochi' }).click();
  expect(await hireCalls(page)).toEqual([`worker:askOffer:${OFFER.price.yocto}`]);
  // the job ends: the offer is gone from the owner view, the turn holds the refusal line and the pet's own reply
  await setWorker(page, {
    pets: pixel({ hireMode: 'manual', offer: null }).pets,
    conversation: conversation(you, asked('Mochi'), refusedManual, ownReply(PET_ALONE)),
    petState: { pending: false, pendingProgress: null, offer: null, thought: { id: 'h3', text: PET_ALONE, cut: null } },
  });
}

// spec: add-pet-society › Society hire flow › manual hire refused
test('Manual Ask in the break closes the offer with the no-fee line and keeps the sent message', async ({ page }) => {
  await askRefusedMochi(page);
  const refusal = log(page).locator('li', { hasText: 'Mochi needs a break until 18:00. No hire fee was paid.' });
  await expect(refusal).toBeVisible();
  await expect(refusal).not.toContainText('¢');
  await expect(log(page).getByRole('button', { name: 'Ask Mochi' })).toHaveCount(0);
  await expect(log(page).getByRole('button', { name: 'No thanks' })).toHaveCount(0);
  await expect(log(page).getByText(ASKED)).toHaveCount(1);
  await expect(log(page)).not.toContainText('Pixel asked Mochi');
  // one tap, one call: the refusal starts no second hire and no worker call from the page
  expect(await hireCalls(page)).toEqual([`worker:askOffer:${OFFER.price.yocto}`]);
});

// spec: add-pet-society › Society hire flow › manual refusal reply
test('Manual Ask in the break ends with the pet answering its own message and no hire receipt', async ({ page }) => {
  await askRefusedMochi(page);
  const reply = log(page).locator('li', { hasText: PET_ALONE });
  await expect(reply).toBeVisible();
  await expect(reply).not.toContainText('Pixel asked');
  await expect(reply).not.toContainText('no fee');
  await expect(log(page)).not.toContainText('Pixel is asking');
  const items = await log(page).locator('li').allTextContents();
  const at = (needle: string) => items.findIndex((t) => t.includes(needle));
  expect(at(ASKED)).toBeLessThan(at('No hire fee was paid.'));
  expect(at('No hire fee was paid.')).toBeLessThan(at(PET_ALONE));
  await expect(page.getByRole('button', { name: 'Send', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
  expect(await hireCalls(page)).toEqual([`worker:askOffer:${OFFER.price.yocto}`]);
});

// spec: add-pet-society › Society hire flow › auto paid
test('Auto hire of a liked worker ends with the actual discounted fee on the pet line and the receipt', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...pixel({ hireMode: 'auto' }), petState: { pending: true } } });
  await typeLine(page);
  expect(await hireCalls(page)).toEqual(['worker:say:chat']);
  await setWorker(page, { conversation: conversation(you, asked('Biscuit')), petState: { pending: true, pendingProgress: { asking: 'Biscuit' } } });
  await expect(status(page, 'Pixel is asking Biscuit…')).toBeVisible();
  const paid: HireMeta = { worker: 'Biscuit', price: LIKED.yocto, priceCents: LIKED.cents, mode: 'auto' };
  await setWorker(page, {
    conversation: conversation(you, asked('Biscuit'), { id: 'h2', who: 'worker', text: BISCUIT_SAYS, at: 12, worker: { tokenId: '2', name: 'Biscuit' }, skilled: false }, ownReply(PET_SAYS, paid)),
    petState: { pendingProgress: null, thought: { id: 'h3', text: PET_SAYS, cut: null } },
  });
  const own = log(page).locator('li', { hasText: PET_SAYS });
  await expect(own).toContainText('I asked Biscuit. It cost 0.34¢.');
  await expect(own).toContainText('Pixel asked Biscuit · 0.34¢');
  await expect(own).not.toContainText('0.38¢');
  await expect(log(page).locator('li', { hasText: BISCUIT_SAYS }).getByRole('link', { name: 'Check this thought' })).toHaveAttribute('href', '/pet/2/verify/h2');
  // Auto pays without the owner's tap
  expect(await hireCalls(page)).toEqual(['worker:say:chat']);
});

// spec: add-pet-society › Society hire flow › auto hire refused
test('Auto hire in the break makes no worker call or fee and the pet answers itself', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...pixel({ hireMode: 'auto' }), petState: { pending: true } } });
  await typeLine(page);
  const refused: ConversationLine = { id: 'h2', who: 'event', code: 'society_refused', hireMode: 'auto', worker: MOCHI, refusalUntil: breakUntil, at: 12 };
  await setWorker(page, {
    conversation: conversation(you, refused, ownReply(PET_ALONE)),
    petState: { pendingProgress: null, events: [`society_refused:${breakUntil}`], thought: { id: 'h3', text: PET_ALONE, cut: null } },
  });
  const line = log(page).locator('li', { hasText: "Mochi needs a break today. I'll answer you myself." });
  await expect(line).toBeVisible();
  await expect(line).not.toContainText('¢');
  await expect(line.getByRole('link', { name: 'Check this thought' })).toHaveCount(0);
  await expect(log(page).getByText(PET_ALONE)).toBeVisible();
  await expect(log(page)).not.toContainText('Pixel asked');
  await expect(page.getByText('Pixel is asking Mochi…')).toHaveCount(0);
  expect(await hireCalls(page)).toEqual(['worker:say:chat']);
});

// spec: add-pet-society › Society hire price contract › post-answer hire rejection
test('a hire rejected after the worker answered shows no hire fee and the answer price', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...pixel({ hireMode: 'auto' }), petState: { pending: true } } });
  await typeLine(page);
  await setWorker(page, { conversation: conversation(you, asked('Nori')), petState: { pending: true, pendingProgress: { asking: 'Nori' } } });
  await expect(status(page, 'Pixel is asking Nori…')).toBeVisible();
  const noFee: HireMeta = { worker: 'Nori', noFee: true, answerPrice: '460000000000000000000', answerPriceCents: 0.21 };
  await setWorker(page, {
    conversation: conversation(you, asked('Nori'), { id: 'h2', who: 'worker', text: BISCUIT_SAYS, at: 12, worker: NORI, skilled: false, hire: noFee }, ownReply(PET_SAYS)),
    petState: { pendingProgress: null, thought: { id: 'h3', text: PET_SAYS, cut: null } },
  });
  const answer = log(page).locator('li', { hasText: BISCUIT_SAYS });
  await expect(answer).toContainText("No hire fee was paid. Nori's answer cost 0.21¢.");
  await expect(answer).toContainText('Pixel asked Nori · no fee');
  await expect(log(page).locator('li', { hasText: PET_SAYS })).not.toContainText('0.38¢');
  expect(await hireCalls(page)).toEqual(['worker:say:chat']);
});
