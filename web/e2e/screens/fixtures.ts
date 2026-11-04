import type { Page } from '@playwright/test';
import type { FakeState, FakeWorkerState } from '../../src/seams/fakes';
import type { AdviceRead, CatalogEntryView, ConversationLine, ErrandForm, ErrandReport, ErrandState, FeedSheetData, Fullness, HireMeta, OutfitSlug, SheetPortion, SourceView, ToolView } from '../../src/seams/worker-types';
import { SAMPLE_DAY, sampleDiary } from '../../src/seams/diary.sample';
import type { DiaryView } from '../../src/seams/worker-types';
import { CLOSED_ALL, CLOSED_NEW, lookAgain, setWorker, UA } from '../helpers';
import { verificationFakes } from '../verification.fixtures';

/** One frame's state in the real client, on the sample values of design/BRIEF.md §1. */
export interface ScreenFixture {
  /** Where the client is for this state. */
  route: string;
  /** What the seams (Worker, RPC, Privy) answer; handed to the page before it loads. */
  fakes?: FakeState;
  /** Steps before the page loads (a browser without WebGL). */
  beforeLoad?: (page: Page) => Promise<void>;
  /** Steps after load that bring the state up (open a sheet, tap a control). */
  prepare?: (page: Page) => Promise<void>;
  /** Lines of the frame's `copy` that belong to a part of another change, which is not built yet: the capture does not
   *  assert them (they are recorded in design.md › «Отклонения от кадров» with their change). */
  otherChange?: Array<{ line: string; change: string }>;
  /** Lines of the frame's `copy` that are behind the spec (design/INBOX.md): the spec's words are drawn and asserted by an e2e
   *  test, and the capture does not assert the frame's older ones. Recorded in design.md › «Отклонения от кадров». */
  staleCopy?: string[];
  /** Lines of the frame's `copy` that the frame's own PNG holds below its fold (inside a scrolling body, at the frame's scroll):
   *  the capture asserts them drawn and visible on the page, not inside the visible part of the scroll box. */
  belowFold?: string[];
  /** Lines of the frame's `copy` that only a screen reader gets (a speaker's word the DS draws as Hidden): asserted in the page's text, not drawn. */
  hiddenCopy?: string[];
}

/**
 * Keyed by the frame id of design/bundle/manifest.json. Each entry carries its anchor on the line above:
 *
 *   // spec: <change> › <Requirement> › <Scenario>
 *   'pet-success-owner': { route: '/pets/…', fakes: {…} },
 *
 * A frame of a change that has no entry here makes `scripts/verify.sh <change>` fail its screens step.
 */

const SIGNED_IN = { authenticated: true, nearAccountId: 'a'.repeat(64) };
/** An hour the check never ends in: the frame of the checking state is taken while it waits. */
const FOREVER = 3_600_000;

// the frames show the field at rest: no focus ring from the typing
const typeName = async (page: Page, name: string) => {
  const field = page.getByLabel('Name your pet');
  await field.fill(name);
  await field.blur();
};
const tapHatch = async (page: Page) => {
  await page.getByRole('button', { name: 'Hatch my pet' }).click();
  // the frames show the button at rest, not under the pointer that tapped it
  await page.mouse.move(0, 0);
};

// The frames of the sign-in surfaces stand on a friend's pet, Biscuit, seen by a visitor (design/bundle/screens/pet.js ›
// signedOut). A frame that needs the in-app browser or a phone hands the page that browser's user agent before it loads: the
// product detects by user agent, so the capture has to look like the browser it stands for.
const asBrowser = (userAgent: string) => async (page: Page) => {
  await page.addInitScript((ua) => Object.defineProperty(navigator, 'userAgent', { get: () => ua }), userAgent);
};
/** What a sheet that has just opened still has to finish before the frame is taken: the fonts of its text and its entrance. */
const settle = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
  });
/** the tap that begins a sign-in, then the pointer away: the frames show a control at rest, not under the pointer */
const tapSignIn = async (page: Page) => {
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.mouse.move(0, 0);
};
const FAILED_LINE = "We couldn't sign you in with Google. Try again in a moment.";
const MAU_LINE = "Looks like you haven't played here this month, so we can't sign you in until December 1. You can still look around.";
const FALLBACK_LINE = 'Trouble signing in? Try it in your browser.';

const PIXEL = { tokenId: '9', name: 'Pixel', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 }, mood: 'happy' as const };
const BISCUIT = { tokenId: '2', name: 'Biscuit', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 }, mood: 'happy' as const };
const PIXEL_REF = { tokenId: '9', name: 'Pixel' };
/** The typed line kept in the field (design/bundle/screens/pet.js › TYPED) */
const TYPED = 'And if they ask why the chart matters?';
/** The history of the owner's frames (pet.js › LINES): the pet's replies with their receipts, the player's lines */
const HISTORY = [
  { id: 'c1', who: 'pet' as const, text: 'Morning! I spent the night counting the hum of your fridge. Forty-one. Did you sleep?' },
  { id: 'c2:you', who: 'player' as const, text: 'Barely. Big presentation at ten.' },
  { id: 'c3', who: 'pet' as const, text: "Then here's the plan: one deep breath, one sip of water, and you tell me what the first slide says." },
  { id: 'c4:you', who: 'player' as const, text: "It's the chart nobody understands." },
  { id: 'c5', who: 'pet' as const, text: 'Start with the chart, then. Say what surprised you about it — people follow a surprise better than a number.' },
].map((l, i) => ({ ...l, at: 1_700_000_000_000 + i }));

/** The next 00:00 UTC of the frames: 02:00 at UTC+2 (BRIEF.md §1) */
const MIDNIGHT_UTC = '2026-11-02T00:00:00.000Z';
/** The pet's words in the flows' frames (design/bundle/screens/pet.js — generated samples, not spec copy) */
const STORY = 'Tell me a short story about the chart nobody understands.';
const DEEP_REPLY =
  "Then say why it matters to them, not to you: what decision gets easier once they read it. One chart, one decision — that's the whole case.";
const CUT_REPLY =
  'Once there was a chart nobody understood. Its bars stood in a row like people at a bus stop, and the tallest kept looking back at the axis as if the axis owed it an apology. One morning the smallest bar';
const WAKE_REPLY = 'Thanks, Maya! While I slept I dreamed I was a lighthouse for moths. They were very polite.';
const GREETING = "Hi! I'm Pixel. I hatched a minute ago and I already have a question: what's the first thing you do in the morning?";

// add-pet-work, the owner's hire frames (design/bundle/screens/work.js — generated words, not spec copy): Pixel asks Nori (seed 5,
// aqua) at 0.38¢ (BRIEF.md §1)
const HIRE_QUESTION = 'How do you make a room care about a chart in one sentence?';
const NORI_SAYS = 'Tell them what the chart changed for you. One sentence, then stop — silence after a point makes it land.';
const PET_SAYS = "Nori says: one sentence on what changed for you, then a pause. I'd add — look at one friendly face while you say it.";
const PET_ALONE = 'Say what the chart changed for you — one sentence. Then let the room catch up.';
const NORI_REF = { tokenId: '5', name: 'Nori' };
const NORI_PRICE = { yocto: '380000000000000000000', cents: 0.38 };
const NORI_PAID: HireMeta = { worker: 'Nori', price: NORI_PRICE.yocto, priceCents: 0.38 };
/** the history, then the owner's line and the pet's question to Nori (its own thought, with its receipt) and what the turn went on to */
const hireTurn = (...tail: ConversationLine[]): { lines: ConversationLine[]; more: false; before: null } => ({
  lines: [
    ...HISTORY,
    { id: 'w1:you', who: 'player', text: TYPED, at: 1_700_000_000_100 },
    { id: 'w1', who: 'pet', text: HIRE_QUESTION, at: 1_700_000_000_101, cut: null, hireTo: 'Nori' },
    ...tail.map((l, i) => ({ ...l, at: 1_700_000_000_102 + i })),
  ],
  more: false,
  before: null,
});
const nori = (hire?: HireMeta): ConversationLine => ({ id: 'w2', who: 'worker', text: NORI_SAYS, at: 0, worker: NORI_REF, skilled: false, ...(hire ? { hire } : {}) });
const pixelSays = (text: string, hire: HireMeta | null): ConversationLine => ({ id: 'w3', who: 'pet', text, at: 0, cut: null, ...(hire ? { hire } : {}) });
const hireEvent = (code: 'hire_failed' | 'hire_empty'): ConversationLine => ({ id: 'w2', who: 'event', code, at: 0, worker: NORI_REF });
/** the owner view of the turn on its way: the job, and what it is doing */
const HIRE_JOB = { pendingJob: 'job-1', pendingKind: 'reply' as const, pendingMode: 'chat' as const, pendingText: TYPED, pendingProgress: { asking: 'Nori' } };
/** Manual, with the offer standing */
const MANUAL_OFFER = { hireMode: 'manual' as const, offer: { worker: 'Nori', question: HIRE_QUESTION, price: NORI_PRICE } };

/** Pixel with its owner, who has two pets (the frames show «My pets»), and the history; `extra` — more of the owner's
 *  fields (tired, paused…), `fullness` — the pet's food. Pixel wears the Thinking cap and owns what the frames' wardrobe has
 *  (design/bundle/screens/pet.js › OWN); the baby frames below wear nothing (pet.js › `ownerAwake`: a baby has no outfit). */
function owner(extra: Record<string, unknown> = {}, fullness: Fullness = PIXEL.fullness): FakeWorkerState {
  return {
    owned: ['9'],
    pets: { '9': { ...PIXEL, worn: 'thinking-cap', fullness, owner: { ownedCount: 2, outfits: WARDROBE_OWNS, ...extra } }, '2': BISCUIT },
    conversation: { lines: HISTORY, more: false, before: null },
  };
}

// add-pet-work, the frames of a pet with a skill (design/bundle/screens/work.js › SAGE): «Sage» (seed 7, lavender), «Good at weather»;
// its price climbs ≈ 0.18¢ a job of the day from 0.38¢ (Hire price rule): 0.56¢ after one job, 0.74¢ after two. Its data source
// (the lines of add-pet-errands) is drawn on the frames below.
const BIKE = 'Should I bike to the office tomorrow?';
const SAGE_REF = { tokenId: '7', name: 'Sage' };
const SAGE_PET = { tokenId: '7', name: 'Sage', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 }, mood: 'happy' as const, skill: { label: 'weather' } };
const SAGE_PRICE_NOW = { yocto: '560000000000000000000', cents: 0.56 };
const SAGE_PRICE_ROSE = { yocto: '740000000000000000000', cents: 0.74 };
const SAGE_Q = 'Will it rain in Lisbon tomorrow between 8 and 10?';
const SAGE_SAYS = "Dry until about noon, then light rain from the west. Between 8 and 10 you're fine — the clouds come in after lunch.";
const PET_ON_SAGE = "Sage says dry until noon — bike it. You'll arrive with your first line already said out loud twice.";
const SAGE_PAID: HireMeta = { worker: 'Sage', price: SAGE_PRICE_NOW.yocto, priceCents: 0.56 };
const ASK_SAGE = 'Will it rain in Porto on Saturday? I want to bike to the coast.';
const SAGE_ADVICE = "Dry until about two, then light rain from the west. Go early and be back by lunch — the wind turns against you after one.";
const SAGE_OFFER = { hireMode: 'manual' as const, offer: { worker: 'Sage', question: SAGE_Q, price: SAGE_PRICE_NOW } };
/** Pixel, Biscuit and Sage, Pixel with the owner fields `ownerExtra` lays over */
const sagePets = (ownerExtra: Record<string, unknown> = {}, fullness: Fullness = PIXEL.fullness): NonNullable<FakeWorkerState['pets']> => ({
  '9': { ...PIXEL, worn: 'thinking-cap', fullness, owner: { ownedCount: 2, outfits: WARDROBE_OWNS, ...ownerExtra } },
  '2': BISCUIT,
  '7': SAGE_PET,
});
/** the history, the owner's line, Pixel's question to Sage and what the turn went on to */
const sageTurn = (...tail: ConversationLine[]): { lines: ConversationLine[]; more: false; before: null } => ({
  lines: [
    ...HISTORY,
    { id: 's1:you', who: 'player', text: BIKE, at: 1_700_000_000_100 },
    { id: 's1', who: 'pet', text: SAGE_Q, at: 1_700_000_000_101, cut: null, hireTo: 'Sage' },
    ...tail.map((l, i) => ({ ...l, at: 1_700_000_000_102 + i })),
  ],
  more: false,
  before: null,
});
const SAGE_SOURCE = 'Open-Meteo';
const sageSays = (): ConversationLine => ({ id: 's2', who: 'worker', text: SAGE_SAYS, at: 0, worker: SAGE_REF, skilled: true, dataLabels: [SAGE_SOURCE] });
const NO_FORECAST = 'No forecast from Sage this time. Check the sky at seven — if the hills are clear, bike it.';
/** the game's line of a hire whose worker's data did not answer */
const sageEvent = (code: 'hire_data_failed' | 'hire_data_failed_paid'): ConversationLine => ({ id: 's2', who: 'event', code, at: 0, worker: SAGE_REF });
/** Sage's page for Pixel's player; `advice` lays over the column's read */
function guestSage(advice: Partial<AdviceRead> = {}): FakeWorkerState {
  return {
    owned: ['9'],
    pets: { '9': PIXEL, '2': BISCUIT, '7': SAGE_PET },
    me: { accountId: 'a'.repeat(64), hatched: PIXEL_REF, currentPet: PIXEL_REF, ownedCount: 1 },
    advice: { price: SAGE_PRICE_NOW, skilled: true, labels: [SAGE_SOURCE], ...advice },
  };
}

// add-pet-work, the Skill sheet frames (design/bundle/screens/skill.js): Pixel and the skill it is taught, «opening lines»
const SKILL_LABEL = 'opening lines';
const SKILL_INSTRUCTION = 'Give one surprising opening line, then say in one sentence why it works. Count the words: twelve at most in the opener.';
/** Pixel with its skill written: the badge «Good at opening lines» and the owner's read that holds both fields */
function skillWorker(label: string): FakeWorkerState {
  return { ...owner(), pets: { '9': { ...PIXEL, worn: 'thinking-cap', skill: { label }, owner: { ownedCount: 2, outfits: WARDROBE_OWNS } }, '2': BISCUIT }, skill: { skill: { label, instruction: SKILL_INSTRUCTION } } };
}
/** the badge under the name tapped, the sheet open and at rest */
const openSkillSheet = async (page: Page) => {
  await page.getByRole('button', { name: /Teach Pixel a skill|Pixel's skill: Good at/ }).click();
  await page.getByRole('dialog').getByLabel('What is Pixel good at?').waitFor();
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page);
};

// add-pet-errands, the Adapter sheet frames and the sockets of Skill sheet (design/bundle/screens/adapter.js — the tools' names and
// descriptions are generated words): Pixel's skill «opening lines» and its own source «Daybook» at daybook.example.com
const DAYBOOK_ADDRESS = 'https://daybook.example.com/mcp';
const DATE_PARAMS = [
  { name: 'month', type: 'number' as const, required: true },
  { name: 'day', type: 'number' as const, required: true },
];
const DAYBOOK_TOOLS: ToolView[] = [
  { name: 'events_on', description: 'Notable events on a month and day.', params: DATE_PARAMS, tickable: true, ticked: true },
  { name: 'births_on', description: 'Well-known people born on a month and day.', params: DATE_PARAMS, tickable: true, ticked: true },
];
const FREE_TOOL: ToolView = {
  name: 'search_events',
  description: 'Finds events by any words.',
  params: [{ name: 'query', type: 'text', maxLength: 500, required: true }],
  tickable: false,
  reason: 'free_text',
};
const FREE_ONLY: ToolView[] = [FREE_TOOL, { name: 'ask_archive', description: 'Answers a question about the archive.', params: [{ name: 'question', type: 'text', required: true }], tickable: false, reason: 'free_text' }];
const dataSource = (label: string, extra: Partial<SourceView> = {}): SourceView => ({ id: `s-${label}`, label, tools: DAYBOOK_TOOLS, published: false, catalogGone: false, gift: false, ...extra });
/** Pixel with its skill written and `sources` on it, `extra` over the Worker fake */
const sourcesWorker = (sources: SourceView[], extra: Partial<FakeWorkerState> = {}): FakeWorkerState => {
  const written = skillWorker(SKILL_LABEL);
  return { ...written, skill: { skill: { label: SKILL_LABEL, instruction: SKILL_INSTRUCTION }, sources }, ...extra };
};
const dialog = (page: Page) => page.getByRole('dialog');
/** the sheet at rest: the pointer away, the focus off its control, the fonts and the entrance done */
const atRest = async (page: Page) => {
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page);
};
/** Skill sheet open, then «Connect data» tapped: the empty form */
const openConnect = async (page: Page) => {
  await openSkillSheet(page);
  await dialog(page).getByRole('button', { name: 'Connect data' }).first().click();
  await page.getByRole('dialog', { name: "Connect data to Pixel's skill" }).waitFor();
  await atRest(page);
};
const typeAdapter = async (page: Page, name: string, address: string) => {
  await dialog(page).getByLabel('Name it').fill(name);
  await dialog(page).getByLabel('Address').fill(address);
};
/** the form filled and «Check address» tapped, the answer in */
const checkAdapter = async (page: Page, name: string, address: string, until: () => Promise<unknown>) => {
  await openConnect(page);
  await typeAdapter(page, name, address);
  await dialog(page).getByRole('button', { name: 'Check address' }).click();
  await until();
  await atRest(page);
};
/** Skill sheet open and the source `label`'s socket tapped: its own sheet */
const openSource = async (page: Page, label = 'Daybook') => {
  await openSkillSheet(page);
  await dialog(page).getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('dialog', { name: `${label} on Pixel's skill` }).waitFor();
  await atRest(page);
};

/** The parts of the owner's frames that other changes build: the hiring mode was one (`add-pet-work`), and is built now */
const OWNER_ELSEWHERE: Array<{ line: string; change: string }> = [];

// add-pet-work, the guest's advice frames (design/bundle/screens/pet.js › ADVICE, work.js — generated words, not spec copy): Pixel's
// player asks Biscuit (seed 2) at 0.38¢; the question is the one of the sample cat.
const ADVICE_QUESTION = 'My cat ignores me after I travel. How do I make up for it?';
const ADVICE_ANSWER = "Don't chase. Sit on the floor near the cat's spot with a book and wait — let the cat come to you. Treats only after the first head-bump.";
const ADVICE_PRICE = { yocto: '380000000000000000000', cents: 0.38 };
const ADVICE_PAYER = { tokenId: '9', name: 'Pixel' };
/** Biscuit's page for Pixel's player; `advice` lays over the column's read, `extra` over the Worker fake */
function guestAdvice(advice: Partial<AdviceRead> = {}, extra: Partial<FakeWorkerState> = {}): FakeWorkerState {
  return {
    owned: ['9'],
    pets: { '9': PIXEL, '2': BISCUIT },
    me: { accountId: 'a'.repeat(64), hatched: PIXEL_REF, currentPet: PIXEL_REF, ownedCount: 1 },
    advice: { price: ADVICE_PRICE, ...advice },
    ...extra,
  };
}
const adviceReady = (page: Page) => page.getByRole('button', { name: /^Ask Biscuit/ }).waitFor();
/** the question typed and the field at rest: the frames show no focus ring from the typing */
const typeAdvice = async (page: Page, text = ADVICE_QUESTION, worker = 'Biscuit') => {
  const field = page.getByPlaceholder(`Ask ${worker} for advice…`);
  await field.fill(text);
  await field.blur();
};
/** The question sent, and the answer to it as the server gives it (`code`, or a `thought`) */
const askAdvice = async (page: Page, answer: Record<string, unknown>) => {
  await setWorker(page, { petState: { pending: true } });
  const field = page.getByPlaceholder('Ask Biscuit for advice…');
  await field.fill(ADVICE_QUESTION);
  await field.press('Enter');
  await page.getByText('Biscuit is thinking…').first().waitFor();
  await setWorker(page, { petState: answer });
};

/** Sage's page: the question sent and the answer `data_failed`, as the server gives it (`paid`: the paying pet's food paid for the try) */
const sageDataFailed = async (page: Page, outcome: { paid?: boolean }) => {
  await page.getByRole('button', { name: /^Ask Sage/ }).waitFor();
  await setWorker(page, { petState: { pending: true } });
  const field = page.getByPlaceholder('Ask Sage for advice…');
  await field.fill(ASK_SAGE);
  await field.press('Enter');
  await page.getByText('Sage is thinking…').first().waitFor();
  await setWorker(page, { petState: { code: 'data_failed', ...outcome } });
};
/** the question is back in the field and the button is at rest */
const settleAdviceField = async (page: Page) => {
  await page.getByRole('button', { name: /^Ask Sage/ }).and(page.locator(':not([aria-busy])')).waitFor();
  await page.getByPlaceholder('Ask Sage for advice…').blur();
};

/** The parts of the frames of a guest with a pet of their own that `add-pet-work` builds: the advice column */
const GUEST_ELSEWHERE = [
  { line: 'Ask {name} for advice…', change: 'add-pet-work' },
  { line: 'Ask {name} · {price}', change: 'add-pet-work' },
  { line: "Your {my_pet} pays from its food. {name}'s owner won't see your question or the answer.", change: 'add-pet-work' },
];
const ME_PIXEL = { accountId: 'a'.repeat(64), hatched: PIXEL_REF, currentPet: PIXEL_REF, ownedCount: 1 };
const HOOK = 'This pet pays for its own thoughts. When the money runs out, it falls asleep.';
const meadowReady = (page: Page) => page.locator('.ds-meadow__ground canvas').first().waitFor();
const SIGNED_OUT_LINE = "You're signed out. See you soon!";
const SESSION_LINE = "You've been signed out. Sign in to pick up where you left off.";
const CLOSED_ALL_WORDS = 'Sign-in is closed for everyone until December 1. You can still look around, and any pet you have is safe.';
/** the Account button tapped, its menu open and still: the frames show it at rest */
const openMenu = async (page: Page) => {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menu').waitFor();
  await page.mouse.move(0, 0);
  await settle(page);
};

/** «Clear {name}'s memory» from the menu: the dialog open and still */
const openClearDialog = async (page: Page) => {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.mouse.move(0, 0);
  await settle(page);
};
/** the owner's other pet, as the guest's page of the frame `clear-memory-new-owner` offers «Go to your Juno» */
const JUNO_ME = { accountId: 'a'.repeat(64), hatched: { tokenId: '1', name: 'Juno' }, currentPet: { tokenId: '1', name: 'Juno' }, ownedCount: 1 };

const ownerReady = (page: Page) => page.getByText('Start with the chart, then.').waitFor();

const sealOnPet = (variant: 'character-mismatch' | 'unread'): ScreenFixture => {
  const chain = verificationFakes({ variant });
  return { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: { ...owner(), verificationIndex: chain.worker!.verificationIndex }, rpc: chain.rpc },
    prepare: ownerReady, otherChange: OWNER_ELSEWHERE };
};
const typeLine = async (page: Page, text: string) => {
  await page.getByPlaceholder('Talk to Pixel…').fill(text);
};
/** The conversation rests on its newest line (it keeps its end while a line arrives, as the frames show it). Polled on a
 *  timer, not per frame: the scroll is set at once, while a frame of the software-GL pet can take seconds under load. */
const atNewest = (page: Page) =>
  page.waitForFunction(
    () => {
      const el = document.querySelector('[role="log"]');
      return el !== null && el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    },
    undefined,
    { polling: 100 },
  );
/** The owner's tap on «Send»: the line goes into the conversation and the field is empty again */
const sendLine = async (page: Page, text: string) => {
  const field = page.getByPlaceholder('Talk to Pixel…');
  await field.fill(text);
  await field.press('Enter');
  await page.getByRole('log').getByText(text).waitFor();
};
const refuseWebGL = (page: Page) =>
  page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
      return (original as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof original;
  });

// Feed sheet (design/bundle/screens/feed.js): Pixel is the player's own pet, Hungry at 0.25 (asleep for the frames of an asleep
// pet), Biscuit a friend's; the portions at 5¢ / 23¢ / 92¢, 0.31 NEAR in the wallet.
const HUNGRY: Fullness = { state: 'hungry', level: 0.25 };
const ASLEEP: Fullness = { state: 'asleep', level: 0 };
const PORTIONS_FIT: SheetPortion[] = [
  { near: '0.01', yocto: '10000000000000000000000', cents: 5, missing: null },
  { near: '0.05', yocto: '50000000000000000000000', cents: 23, missing: null },
  { near: '0.2', yocto: '200000000000000000000000', cents: 92, missing: null },
];
/** the guest's page of the frames: a friend's hungry pet, the player's own Pixel a click away */
const guestFeed = (feedSheet?: FakeWorkerState['feedSheet']): FakeState => ({
  auth: SIGNED_IN,
  worker: { me: ME_PIXEL, pets: { '9': PIXEL, '2': { ...BISCUIT, fullness: HUNGRY } }, ...(feedSheet ? { feedSheet } : {}) },
});
/** «Feed {name}» tapped, the sheet open and still: the frames show it at rest, no focus ring from the tap */
const openFeedSheet = async (page: Page, opener: string) => {
  await page.getByRole('button', { name: opener }).click();
  await page.getByRole('dialog', { name: opener }).waitFor();
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page);
};
const NO_NEAR_SHEET: Partial<FeedSheetData> = {
  wallet: { state: 'none' },
  portions: PORTIONS_FIT.map((p) => ({ ...p, missing: p.near })),
};
/** a tap has done its work: the frames show the sheet at rest, the pointer away and settled */
const restAfterTap = async (page: Page) => {
  await page.mouse.move(0, 0);
  await settle(page);
};
/** the wallet address of the frames (design/bundle/screens/feed.js) */
const FRAME_ADDRESS = '9f2c41e0b7d3a58c7e61d2f0a4b39c85e7d1f6a2c03b48e9d5f17a62c8e04b31';
/** the owner whose wallet holds 0.08 NEAR: the 0.2 portion is short and «Add NEAR» stands under it; the wallet is the frame's */
function addNearWorker(): FakeWorkerState {
  return {
    ...owner({}, HUNGRY),
    feedSheet: {
      wallet: { state: 'some', balance: '80000000000000000000000' },
      portions: PORTIONS_FIT.map((p) => (p.near === '0.2' ? { ...p, missing: '0.13' } : p)),
    },
    wallet: { address: FRAME_ADDRESS, balance: '80000000000000000000000', funded: false },
  };
}
/** Feed sheet open, «Add NEAR» tapped: the step stands */
const openAddNear = async (page: Page) => {
  await ownerReady(page);
  await openFeedSheet(page, 'Feed Pixel');
  await page.getByRole('button', { name: 'Add NEAR' }).click();
  await page.getByRole('dialog', { name: 'Add NEAR' }).getByText('Send NEAR to this address from another wallet or an exchange.').waitFor();
  await restAfterTap(page);
};
/** What the browser has to share with: no system menu, and a clipboard that takes the text or refuses it (`Feed link sharing flow`) */
const browserWith = (what: { clipboard: 'ok' | 'denied' }) => async (page: Page) => {
  await page.addInitScript((w) => {
    (navigator as unknown as Record<string, unknown>).share = undefined;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          if (w.clipboard === 'denied') throw new Error('denied');
        },
      },
    });
  }, what);
};

// Diary screen (design/bundle/screens/diary.js): Pixel is the player's own pet, the Diary's day is Oct 31 (BRIEF.md §1), {time} 02:00.
// The entry, the question, the answers and the riddles are the frame's samples.
const DIARY_WORK = { hirers: ['Biscuit', 'Nori'], cents: 0.6 };
const DIARY_ANSWER = 'It did — the CFO laughed at the dip and then asked for the slides.';
const DIARY_RIDDLE = "What has hands but can't clap?";
const DIARY_TYPED = 'a clock';
const STREAK_2 = { days: 2, freezes: 1, done: false, line: null, n: 2, k: 1, missed: 0, note: [] };
const OPEN_RIDDLE = { kind: 'open' as const, day: SAMPLE_DAY, text: DIARY_RIDDLE };
const ANSWERED_CLEARED = { kind: 'answered' as const, day: SAMPLE_DAY, text: DIARY_RIDDLE, answer: null };
/** the owner's Pixel and the diary laid over the sample one */
function diaryWorker(diary: Partial<DiaryView>, extra: Partial<FakeWorkerState> = {}): FakeWorkerState {
  return { ...owner(), diary, ...extra };
}
/** a sample entry with the work line the frame shows (the line is `add-pet-work`'s; the fixture gives it as the Worker would) */
const entryWithWork = (): DiaryView['entry'] => {
  const entry = sampleDiary().entry;
  return entry.kind === 'text' ? { ...entry, work: DIARY_WORK } : entry;
};
const diaryReady = (page: Page) => page.getByRole('heading', { level: 2, name: DIARY_RIDDLE }).or(page.getByText(/writes its first diary entry|You cleared/)).first().waitFor();
const typeDiary = async (page: Page, answer: string | null, riddle: string | null) => {
  if (answer !== null) await page.getByLabel('Did the chart surprise anyone?').fill(answer);
  if (riddle !== null) await page.getByLabel(DIARY_RIDDLE).fill(riddle);
  // the frames show the field at rest: no focus ring from the typing
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
};
const DIARY_REPLY = 'A laugh from the CFO is a standing ovation. Next time, tell me what the dip was.';
const SAVING_STREAK = { days: 2, freezes: 1, done: true, line: null, n: 2, k: 1, missed: 0, note: ['saving' as const] };
/** the pet falls asleep on the open Diary, the ritual done and saving; with an unsent riddle answer typed when `typed` is given */
const fallAsleep = async (page: Page, typed: string | null) => {
  await diaryReady(page);
  if (typed !== null) await typeDiary(page, null, typed);
  await setWorker(page, {
    pets: { '9': { ...PIXEL, fullness: { state: 'asleep', level: 0 }, owner: { ownedCount: 2 } }, '2': BISCUIT },
    diary: { entry: entryWithWork(), streak: SAVING_STREAK, parts: [], complete: true },
  });
  await lookAgain(page);
  await page.getByText('Pixel fell asleep. Today still counts for your streak.').first().waitFor();
  await page.mouse.move(0, 0);
  // the focus went to the first line and scrolled it into view: the frames stand at the top
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
};
/** the clock of the page stands near the end of the Diary's day, so a diary that fails to load later is of a day that moved on */
const nearMidnight = async (page: Page) => {
  await page.clock.install({ time: new Date('2026-10-31T23:59:50Z') });
};

/** What Pixel owns in the Wardrobe frames: the Daisy crown (a 1-day streak), the Thinking cap (its first riddle, worn), the Party hat (bought) */
const WARDROBE_OWNS: OutfitSlug[] = ['daisy-crown', 'thinking-cap', 'party-hat'];
type FakePet = NonNullable<FakeWorkerState['pets']>[string];
/** The newborn of the empty Wardrobe: baby, Hungry on its starter food, wearing and owning nothing */
const BABY: Partial<FakePet> = { stage: 'baby', fullness: { state: 'hungry', level: 0.25 }, worn: null, owner: { ownedCount: 2, outfits: [] } };
/** Pixel with its owner, who has two pets, wearing the Thinking cap, as the Wardrobe frames have it; `pet` lays over the pet, `wardrobe`
 *  over the wardrobe the fake reads from it */
function wardrobeWorker(pet: Partial<FakePet> = {}, wardrobe: FakeWorkerState['wardrobe'] = {}, extra: Partial<FakeWorkerState> = {}): FakeWorkerState {
  return {
    owned: ['9'],
    pets: { '9': { ...PIXEL, worn: 'thinking-cap', owner: { ownedCount: 2, outfits: WARDROBE_OWNS }, ...pet }, '2': BISCUIT },
    conversation: { lines: HISTORY, more: false, before: null },
    wardrobe,
    ...extra,
  };
}
/** New outfit notice opened by itself: the dialog is there, its entrance finished, the pointer away */
const noticeReady = async (page: Page) => {
  await page.getByRole('dialog', { name: 'New outfit!' }).waitFor();
  await page.mouse.move(0, 0);
  await settle(page);
};
/** The wardrobe is read: a tile's action is there and on */
const wardrobeReady = (page: Page) => page.locator('.ds-item button:not([disabled])').first().waitFor();
/** The Smart glasses' «Buy · {price}» tapped on the ready wardrobe; the fake holds the purchase until a frame lands or refuses it */
const tapSmartGlassesBuy = async (page: Page) => {
  await wardrobeReady(page);
  await page.getByRole('button', { name: 'Buy · 0.76¢ Smart glasses' }).click();
  await page.getByRole('button', { name: 'Buying… Smart glasses' }).waitFor();
};

// add-pet-errands, the errand frames (design/bundle/screens/errand.js — generated words, not spec copy): Pixel sends the jobs of the
// frames; after a report it is «Hungry» at 10 of 12; the skill «opening lines» with its data source «Daybook»; {time} is 02:00.
const ERRAND_LOWER: Fullness = { state: 'hungry', level: 10 / 12 };
const LEONIDS = 'When does the Leonid meteor shower peak this year, and when should I look?';
const DREAMS = 'https://example.com/dreams';
const OCTOPUS = 'Octopuses have three hearts.';
const PASTED =
  "Our lease says: the tenant gives 60 days' written notice before moving out, and the deposit comes back within 30 days of the keys.";
const FIND_SAYS =
  "The Leonids peak on the night of Nov 16 into Nov 17. Look after midnight, toward the east and away from city lights — expect 10 to 15 an hour, and the thin moon won't get in the way.";
const READ_SAYS =
  'The piece says most dreams fade within minutes because the brain files few new memories during REM sleep. Its one tip: lie still after you wake and replay the dream before you reach for your phone.';
const PASTED_SAYS =
  'Two dates matter: tell the landlord in writing 60 days before you go, and expect the deposit back within 30 days of handing over the keys.';
const TRUE_SAYS =
  "Two hearts pump blood through the gills and a third sends it to the rest of the body. That third one stops while the octopus swims — one reason they'd rather crawl.";
const UNCLEAR_CLAIM = 'The first cat café opened in Taipei in 1998.';
const UNCLEAR_SAYS = 'Several sites name a café in Taipei, but they give different years, and none links to anything from the time.';
const TOAST_JOB = 'What happened on Nov 3 that would make a good opening line for a toast?';
const TOAST_SAYS =
  'On Nov 3, 1957 a dog named Laika rode Sputnik 2 into orbit. Try: “Tonight we toast to whoever goes first, before anyone knows it can be done.”';
const ERRAND_MIDNIGHT = '2026-11-04T00:00:00.000Z';
const ERRAND_FOOD = { reason: 'food' as const, need: { yocto: '2000000000000000000000', cents: 0.93 } };
const src = (host: string) => ({ label: host, url: `https://${host}/a` });
/** An errand's two lines in the conversation: the job under «You» with its form, and what came back */
const errandJob = (form: ErrandForm, text: string): ConversationLine => ({ id: 'e1:you', who: 'player', kicker: form, text, at: 1_700_000_000_100 });
const errandReport = (report: Omit<ErrandReport, 'priceCents' | 'missed'> & Partial<Pick<ErrandReport, 'priceCents' | 'missed'>>, text: string): ConversationLine => ({
  id: 'e1',
  who: 'pet',
  text,
  at: 1_700_000_000_101,
  report: { priceCents: 1.42, missed: [], ...report },
});
const errandEmpty = (priceCents: number): ConversationLine => ({ id: 'e1', who: 'error', code: 'errand_empty', priceCents, at: 1_700_000_000_101 });
/** the paid errand of `errandEmpty` as the owner's state keeps it for «Try again» until the next errand */
const EMPTY_KEPT: ErrandState = { state: 'failed', form: 'find', job: LEONIDS, reason: 'empty', priceCents: 0.62 };
// the reports that land while the frame's screen stands (errand.js › FIND, TRUE)
const REPORT_TAIL = [
  errandJob('find', LEONIDS),
  errandReport({ form: 'find', sources: [src('in-the-sky.org'), src('timeanddate.com'), src('science.nasa.gov')], verdict: null, searches: 3, priceCents: 1.4 }, FIND_SAYS),
];
const VERDICT_TAIL = [
  errandJob('check', OCTOPUS),
  errandReport({ form: 'check', sources: [src('si.edu'), src('nationalgeographic.com')], verdict: 'true', searches: 2, priceCents: 1.1 }, TRUE_SAYS),
];
const UNCLEAR_TAIL = [
  errandJob('check', UNCLEAR_CLAIM),
  errandReport({ form: 'check', sources: [src('taipeitimes.com'), src('atlasobscura.com')], verdict: 'unclear', searches: 3, priceCents: 1.4 }, UNCLEAR_SAYS),
];
/** Pixel with the history and an errand's `tail`; `quote` lays over the sheet's quote, `state` over the errand of the owner's state */
function errandOwner(
  tail: ConversationLine[] = [],
  o: { fullness?: Fullness; ownerExtra?: Record<string, unknown>; quote?: FakeWorkerState['errand']; state?: ErrandState | null; skill?: string; extra?: Partial<FakeWorkerState> } = {},
): FakeWorkerState {
  const base = o.skill ? { ...skillWorker(o.skill), ...owner(o.ownerExtra, o.fullness ?? PIXEL.fullness) } : owner(o.ownerExtra, o.fullness ?? PIXEL.fullness);
  return {
    ...base,
    pets: o.skill
      ? { '9': { ...PIXEL, worn: 'thinking-cap', fullness: o.fullness ?? PIXEL.fullness, skill: { label: o.skill }, owner: { ownedCount: 2, outfits: WARDROBE_OWNS, ...o.ownerExtra } }, '2': BISCUIT }
      : base.pets,
    conversation: { lines: [...HISTORY, ...tail], more: false, before: null },
    ...(o.quote ? { errand: o.quote } : {}),
    ...(o.state !== undefined ? { petState: { errand: o.state } } : {}),
    ...o.extra,
  };
}
/** the rail's «Send Pixel on an errand» tapped, the sheet open and at rest */
const openErrandSheet = async (page: Page) => {
  await page.getByRole('button', { name: 'Send Pixel on an errand' }).click();
  await page.getByRole('dialog', { name: 'Send Pixel on an errand' }).waitFor();
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page);
};
/** a search form picked and its field filled, the sheet at rest */
const fillErrand = async (page: Page, form: 'Find out' | 'Is it true?', label: string, text: string) => {
  const dialog = page.getByRole('dialog', { name: 'Send Pixel on an errand' });
  await dialog.getByRole('radio', { name: form }).check();
  await dialog.getByLabel(label).fill(text);
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page);
};
/** the conversation rests on its newest line after the errand's lines are drawn */
const errandLines = async (page: Page, text: string | RegExp) => {
  await page.getByRole('log').getByText(text).first().waitFor();
  await atNewest(page);
  await settle(page);
};
/** The pet away on the errand of `tail`'s job, as `errand-sent` has it: the report lands while the screen stands. */
const awayOn = (tail: ConversationLine[], o: { fullness?: Fullness } = {}): FakeWorkerState => {
  const job = tail[0]!;
  return errandOwner([], { ...o, state: { state: 'away', form: job.kicker ?? 'find', job: job.text ?? '', sentAt: 1_700_000_000_000 } });
};
/** The log shows the landed report from its top at its own top edge (Conversation `reveal`), or rests on its newest line when the
 *  report fits. Polled on a timer, as `atNewest`. */
const atReveal = (page: Page) =>
  page.waitForFunction(
    () => {
      const log = document.querySelector('[role="log"]');
      const report = log?.querySelector('[data-reveal]');
      if (!log || !report) return false;
      const edge = log.getBoundingClientRect().top + (parseFloat(getComputedStyle(log).scrollPaddingBlockStart) || 0);
      const top = report.getBoundingClientRect().top;
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 2;
      return Math.abs(top - edge) < 2 || (atEnd && top >= edge - 2);
    },
    undefined,
    { polling: 100 },
  );
/** The report of `tail` lands (`Errand flow` › «report»): the page saw the pet away, the next look finds it back and the conversation
 *  holds the job and the report — it rises in, and the log shows the card's top (the frames' moment). */
const landReport = async (page: Page, tail: ConversationLine[], o: { fullness?: Fullness } = {}) => {
  await page.getByText('Pixel is off on your errand — back soon, usually within a minute.').first().waitFor();
  await setWorker(page, { petState: { errand: null, ...(o.fullness ? { fullness: o.fullness } : {}) }, conversation: { lines: [...HISTORY, ...tail], more: false, before: null } });
  await lookAgain(page);
  await page.getByRole('log').locator('[data-reveal]').waitFor();
  await atReveal(page);
  await page.mouse.move(0, 0);
  await settle(page);
};

// add-pet-errands, the Adapter catalog frames (design/bundle/screens/catalog.js): the published adapters of Sage (seed 7), Mochi (seed 1)
// and Biscuit (seed 2), opened for Pixel; addresses on example.com, the descriptions generated words
const LAT_LON = [
  { name: 'latitude', type: 'number' as const, required: true },
  { name: 'longitude', type: 'number' as const, required: true },
];
const catalogTool = (name: string, description: string, params: ToolView['params'] = LAT_LON) => ({ name, description, params, tickable: true });
const CATALOG_ENTRIES: CatalogEntryView[] = [
  {
    id: 'e-meteo',
    name: 'Open-Meteo',
    address: 'https://mcp.open-meteo.example.com',
    tools: [catalogTool('forecast', 'Hourly and daily weather for a place by its latitude and longitude, up to 16 days ahead.'), catalogTool('air_quality', 'Air quality and pollen for a place by its latitude and longitude.')],
    petId: '7',
    petName: 'Sage',
    publishedAt: 3,
  },
  {
    id: 'e-moon',
    name: 'Moon phases',
    address: 'https://moon.example.com/mcp',
    tools: [catalogTool('phase_on', "The moon's phase and how much of it is lit on a date.", DATE_PARAMS)],
    petId: '1',
    petName: 'Mochi',
    publishedAt: 2,
  },
  {
    id: 'e-tides',
    name: 'Tide times',
    address: 'https://tides.example.com/mcp',
    tools: [
      catalogTool('tides_at', 'High and low tide times for a harbour by its name, today and the next 6 days.', [{ name: 'harbour', type: 'text', maxLength: 64, required: true }]),
      catalogTool('harbours_near', 'Harbours with tide tables near a latitude and longitude.'),
    ],
    petId: '2',
    petName: 'Biscuit',
    publishedAt: 1,
  },
];
const CATALOG_ME = { accountId: 'a'.repeat(64), hatched: null, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };
/** Pixel opened for the catalog, with `sources` on its skill and the three entries listed; `extra` over the Worker fake */
const catalogWorker = (sources: SourceView[] = [], extra: Partial<FakeWorkerState> = {}): FakeWorkerState => sourcesWorker(sources, { me: CATALOG_ME, adapters: { entries: CATALOG_ENTRIES }, ...extra });
/** the list is on the page and at rest: the pointer away, the fonts and the entrance done */
const catalogReady = async (page: Page) => {
  await page.getByRole('heading', { level: 2, name: 'Open-Meteo' }).waitFor();
  await atRest(page);
};

// add-pet-errands, the Skill code sheet frames (design/bundle/screens/code.js): Pixel's skill «opening lines», its source «Daybook», the
// code of `openerFor` and `rawFeed`; the function names and the output are generated words; {time} «02:00» (the capture runs at UTC+2)
const CODE_TEXT = [
  '// One event from the Daybook, ready for an opening line',
  'export async function openerFor(month, day) {',
  '  const { events } = await sources["Daybook"].events_on({ month, day });',
  '  const e = events[0];',
  '  return { year: e.year, event: e.text };',
  '}',
  '',
  'export function rawFeed(query) {',
  '  return sources["Daybook"].search_events({ query });',
  '}',
].join('\n');
const CODE_EDITED = CODE_TEXT.replace('events[0]', 'events.find((x) => x.year > 1900)');
const CODE_OUTPUT = '{ "year": 1957, "event": "Sputnik 2 carries Laika, the first animal to orbit the Earth." }';
const CODE_FUNCTIONS: ToolView[] = [
  { name: 'openerFor', description: 'One event from the Daybook for a date.', params: DATE_PARAMS, tickable: true, ticked: true },
  { name: 'rawFeed', description: 'The Daybook searched by any words.', params: [{ name: 'query', type: 'text', required: true }], tickable: false, reason: 'free_text' },
];
/** Pixel's skill with the source «Daybook»; `written` — it has saved code; `extra` over the Worker fake */
const codeWorker = (written: boolean, extra: Partial<FakeWorkerState> = {}): FakeWorkerState => {
  const base = sourcesWorker([dataSource('Daybook')], extra);
  const skill = !base.skill || 'fail' in base.skill ? base.skill : { ...base.skill, code: written ? { functions: CODE_FUNCTIONS } : null };
  return { ...base, skill, code: written ? { code: CODE_TEXT, functions: CODE_FUNCTIONS, testsLeft: 20 } : { code: null, functions: [], testsLeft: 20 }, ...extra };
};
const codeDialog = (page: Page) => page.getByRole('dialog', { name: "Pixel's code" });
/** Skill sheet open and the code socket tapped: the sheet read and at rest */
const openCode = async (page: Page, socket: string) => {
  await openSkillSheet(page);
  await dialog(page).getByRole('button', { name: socket }).click();
  await codeDialog(page).waitFor();
  await codeDialog(page).getByLabel('JavaScript, up to 32 KB').and(page.locator(':not([readonly])')).waitFor();
  await atRest(page);
};
/** the code replaced, the function and the sample values typed, the fields left at rest */
const typeCode = async (page: Page, code: string | null) => {
  if (code !== null) await codeDialog(page).getByLabel('JavaScript, up to 32 KB').fill(code);
  await codeDialog(page).getByLabel('Function to test').fill('openerFor');
  await codeDialog(page).getByLabel('Sample values').fill('11, 3');
};
/** «Test run» tapped after `typeCode`; `until` — what the answer draws */
const testCode = async (page: Page, until: () => Promise<unknown>) => {
  await codeDialog(page).getByRole('button', { name: 'Test run' }).click();
  await until();
  await atRest(page);
};

const GIFT_CODE = 'a'.repeat(48);
const GIFT_ACCOUNT = 'b2'.repeat(32);
const GIFT_ACCEPTED = { status: 'accepted' as const, code: GIFT_CODE, acceptedName: 'Maya', acceptedAccount: GIFT_ACCOUNT, version: 2 };
const publicGift = (status: 'waiting' | 'accepted' | 'transferred' = 'waiting', viewer: 'giver' | 'receiver' | 'visitor' = 'receiver', asleep = false) => ({ tokenId: '9', name: 'Pixel', fullness: asleep ? { state: 'asleep' as const, level: 0 } : PIXEL.fullness, status, viewer, errand: null });
const receiverGiftWorker = (extra: Partial<FakeWorkerState> = {}): FakeWorkerState => ({
  owned: [], pets: { '9': { ...PIXEL, worn: 'thinking-cap' } },
  me: { accountId: 'a'.repeat(64), hatched: { tokenId: '2', name: 'Biscuit' }, currentPet: { tokenId: '2', name: 'Biscuit' }, ownedCount: 1 },
  publicGift: publicGift(), ...extra,
});
const giftWorker = (extra: Partial<FakeWorkerState> = {}, asleep = false): FakeWorkerState => ({
  ...owner({ ownedCount: 2 }, asleep ? { state: 'asleep', level: 0 } : PIXEL.fullness),
  owned: ['9', '0'],
  pets: { ...owner({ ownedCount: 2 }, asleep ? { state: 'asleep', level: 0 } : PIXEL.fullness).pets,
    '0': { tokenId: '0', name: 'Juno', stage: 'adult', fullness: { state: 'full', level: 1 }, mood: 'happy' } },
  me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 2 },
  ...extra,
});
const giftDialog = (page: Page) => page.getByRole('dialog', { name: 'Give Pixel to a friend' });
/** The sheet's words as drawn, not the copy of them in its hidden status line. */
const giftShown = (page: Page, text: string) => giftDialog(page).getByText(text, { exact: false }).and(page.locator(':not([role="status"])'));
const openGiftSheet = async (page: Page) => { await page.getByRole('button', { name: 'Give Pixel away' }).click(); await giftDialog(page).waitFor(); await atRest(page); };
const acceptedGiftSheet = async (page: Page) => { await giftDialog(page).waitFor(); await atRest(page); };
const tapGiftGive = async (page: Page) => { await acceptedGiftSheet(page); await giftDialog(page).getByRole('button', { name: 'Give Pixel to Maya' }).click(); await atRest(page); };

export const fixtures: Record<string, ScreenFixture> = {
  // spec: add-pet › Hatch screen › success
  // spec: add-pet › Hatch screen › уведомление о публичности
  // spec: add-pet › Hatch screen › уведомление об AI-провайдере
  'hatch-success': {
    route: '/hatch',
    fakes: { auth: SIGNED_IN },
    prepare: (page) => typeName(page, 'Pixel'),
  },

  // «Hatch my pet» tapped: «Hatching…», the Nest breathes
  // spec: add-pet › Hatch screen › success
  'hatch-hatching': {
    route: '/hatch',
    fakes: { auth: SIGNED_IN, worker: { hatchDelayMs: FOREVER } },
    prepare: async (page) => {
      await typeName(page, 'Pixel');
      await tapHatch(page);
      await page.getByRole('button', { name: 'Hatching…' }).waitFor();
    },
  },

  // spec: add-pet › Hatch screen › empty
  // spec: add-pet › Hatch screen › уведомление о публичности
  // spec: add-pet › Hatch screen › уведомление об AI-провайдере
  'hatch-empty': { route: '/hatch', fakes: { auth: SIGNED_IN } },

  // spec: add-pet › Hatch screen › loading
  'hatch-loading': {
    route: '/hatch',
    fakes: { auth: SIGNED_IN, worker: { hatchStatusDelayMs: FOREVER } },
    prepare: (page) => typeName(page, 'Pixel'),
  },

  // spec: add-pet › Hatch screen › signed-out
  'hatch-signed-out': { route: '/hatch', prepare: (page) => typeName(page, 'Pixel') },

  // paused, signed in, not from a friend's pet: «Go home»
  // spec: add-pet › Hatch screen › error
  // spec: add-pet › Hatch screen › выход на главную
  'hatch-error': {
    route: '/hatch',
    fakes: { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'service' } } },
    prepare: (page) => typeName(page, 'Pixel'),
  },

  // all for today, a visitor without a session who came from Biscuit: «Back to Biscuit»; {time} 02:00 at UTC+2
  // spec: add-pet › Hatch screen › рождения на сегодня закрыты
  // spec: add-pet › Hatch screen › выход к питомцу друга
  'hatch-closed-today': {
    route: '/hatch?from=2',
    fakes: { worker: { hatchStatus: { open: false, reason: 'daily' } } },
    prepare: async (page) => {
      await typeName(page, 'Pixel');
      await page.getByRole('link', { name: 'Back to Biscuit' }).waitFor();
    },
  },

  // spec: add-pet › Hatch screen › уже есть рождённый питомец
  'hatch-already': {
    route: '/hatch',
    fakes: { auth: SIGNED_IN, worker: { hatchStatus: { open: true, already: { tokenId: '9', name: 'Pixel' } } } },
  },

  // three spaces: no visible character, refused, kept in the field
  // spec: add-pet › Birth flow › имя не принято
  'hatch-name-rejected': {
    route: '/hatch',
    fakes: { auth: SIGNED_IN },
    prepare: async (page) => {
      await typeName(page, '   ');
      await tapHatch(page);
      await page.getByText("Let's pick a different name.").waitFor();
    },
  },

  // spec: add-pet › Birth flow › не вылупился
  'hatch-not-hatched': {
    route: '/hatch',
    fakes: { auth: SIGNED_IN, worker: { hatchResult: { fail: { status: 502, code: 'not_hatched' } } } },
    prepare: async (page) => {
      await typeName(page, 'Pixel');
      await tapHatch(page);
      await page.getByRole('button', { name: 'Try again' }).waitFor();
    },
  },

  // spec: add-pet › Connection rule › сервер недоступен
  'hatch-unreachable': {
    route: '/hatch',
    fakes: { auth: SIGNED_IN, worker: { hatchResult: { fail: { status: 503, code: 'chain_unreachable' } } } },
    prepare: async (page) => {
      await typeName(page, 'Pixel');
      await tapHatch(page);
      await page.getByRole('button', { name: 'Try again' }).waitFor();
    },
  },

  // spec: add-pet › Pet screen › success (владелец)
  'pet-success-owner': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: ownerReady,
    otherChange: OWNER_ELSEWHERE,
  },

  // add-verification: the Seal of character rule on the owner's Pet screen; NEAR answers by the verification fixtures
  // spec: add-verification › Seal of character rule › character mismatch
  'pet-seal-mismatch': sealOnPet('character-mismatch'),
  // spec: add-verification › Seal of character rule › check unavailable
  'pet-seal-unavailable': sealOnPet('unread'),

  // the phone, the conversation scrolled back to its start: the card of what is rare
  // spec: add-pet › Pet screen › success (владелец)
  'pet-success-owner-card': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await page.locator('[role="log"]').evaluate((el) => {
        el.scrollTop = 0;
      });
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // a signed-in player with a pet of their own on a friend's awake pet
  // spec: add-pet › Pet screen › success (гость)
  // spec: add-pet › Pet screen › проверка питомца
  'pet-success-guest': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: { me: { accountId: 'a'.repeat(64), hatched: PIXEL_REF, currentPet: PIXEL_REF, ownedCount: 1 } } },
    prepare: (page) => page.getByRole('link', { name: 'Go to your Pixel' }).waitFor(),
    otherChange: GUEST_ELSEWHERE,
  },

  // Biscuit at rest, its energy spent, seen by a player with a pet of their own: the advice column of `add-pet-work` says so in the
  // button's place and keeps the question (its `req` is still `add-pet-life`'s in the manifest, design/INBOX.md line 134)
  // spec: add-pet-life › Energy rule › совет питомцу на нуле
  'advice-resting': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: guestAdvice({ resting: { until: MIDNIGHT_UTC } }) },
    prepare: async (page) => {
      await page.getByText(/is resting until/).first().waitFor();
      await typeAdvice(page);
    },
  },

  // a signed-in player who never hatched
  // spec: add-pet › Pet screen › success (гость)
  'pet-guest-new': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN },
    prepare: (page) => page.getByRole('link', { name: 'Get your own pet' }).waitFor(),
  },

  // spec: add-pet › Pet screen › signed-out
  'pet-signed-out': { route: '/pet/2', prepare: (page) => page.getByRole('button', { name: 'Sign in' }).waitFor() },

  // spec: add-pet › Pet screen › signed-out
  'pet-signed-out-asleep': {
    route: '/pet/2',
    fakes: { worker: { pets: { '2': { ...BISCUIT, fullness: { state: 'asleep', level: 0 } } } } },
    prepare: (page) => page.getByRole('paragraph').filter({ hasText: 'Biscuit is asleep — food from you would wake Biscuit up.' }).waitFor(),
  },

  // spec: add-pet › Pet screen › loading
  'pet-loading': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: { delayMs: FOREVER } }, prepare: (page) => page.getByText('Finding this pet…').first().waitFor() },

  // spec: add-pet › Pet screen › error
  'pet-error': { route: '/pet/77', prepare: (page) => page.getByRole('link', { name: 'Go home' }).waitFor() },

  // spec: add-pet › Pet screen › asleep (владелец)
  'pet-asleep-owner': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await typeLine(page, TYPED);
      // the food ran out under the open page: the next look at the pet shows it asleep
      await setWorker(page, { pets: { '9': { ...PIXEL, fullness: { state: 'asleep', level: 0 }, owner: { ownedCount: 2 } } }, petState: { events: ['fell_asleep'] } });
      await lookAgain(page);
      // drawn once, and said by the Dock's Live
      await page.getByText('Pixel is asleep. A meal will wake Pixel up.').first().waitFor();
      await page.getByText('Pixel fell asleep.').waitFor();
      await setWorker(page, { petState: {} });
      // the field keeps the focus while it is off; the frame shows it at rest, with no ring from the typing
      await page.getByPlaceholder('Talk to Pixel…').blur();
    },
  },

  // a newborn: no line yet, the greeting on its way
  // spec: add-pet › Pet screen › empty
  'pet-empty': {
    route: '/pet/9',
    fakes: {
      auth: SIGNED_IN,
      worker: {
        owned: ['9'],
        pets: { '9': { ...PIXEL, stage: 'baby', worn: null, owner: { hello: true } } },
        conversation: { lines: [], more: false, before: null },
        petState: { pending: true },
        waitLineMs: FOREVER,
      },
    },
    prepare: (page) => page.getByText('Pixel is thinking…').first().waitFor(),
  },

  // the server stopped answering under the open page: the last known pet, the typed line kept
  // spec: add-pet › Connection rule › сервер недоступен
  'pet-offline': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await typeLine(page, TYPED);
      await setWorker(page, { petState: { fail: { status: 503, code: 'chain_unreachable' } } });
      await lookAgain(page);
      await page.getByText("Can't reach Pixel right now. Nothing's lost — try again in a moment.").first().waitFor();
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // nothing to show on a fresh load: the page's line and «Try again», not the «error» of a dead link
  // spec: add-pet › Connection rule › сервер недоступен
  'pet-unreachable': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { petResult: { fail: { status: 503, code: 'chain_unreachable' } } } },
    prepare: (page) => page.getByRole('button', { name: 'Try again' }).waitFor(),
  },

  // spec: add-pet › Connection rule › слишком много запросов
  'pet-busy': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await typeLine(page, TYPED);
      await setWorker(page, { petState: { fail: { status: 429, code: 'rate_limited' } } });
      await lookAgain(page);
      await page.getByRole('button', { name: 'Try again' }).waitFor();
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // a browser that gives no WebGL context: the flat drawing, no «Pause motion»
  // spec: add-pet › Pet screen › WebGL недоступен
  'pet-no-webgl': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    beforeLoad: refuseWebGL,
    prepare: ownerReady,
    otherChange: OWNER_ELSEWHERE,
  },

  // the day's cap is spent: the field off until 00:00 UTC (02:00 at UTC+2), feeding works
  // spec: add-pet › Daily cap rule › Устал
  'pet-tired': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner({ tired: true, until: MIDNIGHT_UTC }) },
    prepare: async (page) => {
      await ownerReady(page);
      await page.getByText('Pixel is tired for today.').first().waitFor();
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // a grown-up Pixel with its two traits and no energy left: «Think hard» off with the energy's words, chatting and feeding
  // work; {time} 02:00 at UTC+2
  // spec: add-pet-life › Energy rule › энергия на нуле
  'pet-energy-out': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner({ energy: 0, until: MIDNIGHT_UTC }) },
    prepare: async (page) => {
      await ownerReady(page);
      await page.getByText('Pixel worked hard today and is out of energy for big thoughts until').first().waitFor();
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // the model's answer did not come: the line stays, the error and «Try again» where the reply would be
  // spec: add-pet › Connection rule › AI-провайдер недоступен
  'pet-thought-lost': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await sendLine(page, TYPED);
      await setWorker(page, { petState: { code: 'ai_unavailable' } });
      await page.getByText('Pixel lost that thought. Nothing was spent — try again.').waitFor();
      await setWorker(page, { petState: {} });
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // an empty reply past the third of the day: the pet paid a little
  // spec: add-pet › Connection rule › пустой ответ за счёт питомца
  'pet-empty-reply-paid': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await sendLine(page, TYPED);
      await setWorker(page, { petState: { code: 'empty_paid' } });
      await page.getByText('Pixel lost that thought, but it still used a little food. Your message is kept — try again.').waitFor();
      await setWorker(page, { petState: {} });
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // chatting is paused on our side: the line over the page, the field off with the kept line
  // spec: add-pet › Connection rule › разговор на паузе
  'pet-paused': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await typeLine(page, TYPED);
      await setWorker(page, { pets: { '9': { ...PIXEL, owner: { ownedCount: 2, paused: true } } } });
      await lookAgain(page);
      await page.getByText('Chatting is paused on our side while we top up.').first().waitFor();
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // food for 1.5 scale thoughts: one cell, «Think hard» off with its words, chatting works
  // spec: add-pet › Pet condition rule › Голоден
  'pet-hungry': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner({}, { state: 'hungry', level: 0.125 }) },
    prepare: async (page) => {
      await ownerReady(page);
      await page.getByText('Pixel is too hungry to think hard right now.').first().waitFor();
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // «Think hard» tapped: the longer thinking line, the thinking face, the buttons busy
  // spec: add-pet › Deep thought flow › отправлено
  'pet-thinking-hard': {
    route: '/pet/9',
    // the frame is the first seconds: a slow machine must not reach the 10 s line before the shot
    fakes: { auth: SIGNED_IN, worker: { ...owner(), waitLineMs: FOREVER } },
    prepare: async (page) => {
      await ownerReady(page);
      await typeLine(page, TYPED);
      await page.getByRole('button', { name: /Think hard/ }).click();
      await page.getByText('Pixel is thinking hard…').waitFor();
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // the deeper reply came: its exact price beside it, the fullness still full
  // spec: add-pet › Deep thought flow › отправлено
  'pet-thought-hard': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await typeLine(page, TYPED);
      await page.getByRole('button', { name: /Think hard/ }).click();
      await page.getByText('Pixel is thinking hard…').waitFor();
      await setWorker(page, { petState: { thought: { id: 'r', text: DEEP_REPLY, cut: null, price: '270000000000000000000', priceCents: 0.13 } } });
      await page.getByText('Thought hard · 0.13¢').waitFor();
      await setWorker(page, { petState: {} });
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // no reply for 10 s: the waiting line under the thinking line (the 10 s are waited out)
  // spec: add-pet › Conversation flow › долгий ответ
  'pet-long-wait': {
    route: '/pet/9',
    // the 10 s are the spec's; the capture brings the line after 300 ms instead of waiting them out
    fakes: { auth: SIGNED_IN, worker: { ...owner(), waitLineMs: 300 } },
    prepare: async (page) => {
      await ownerReady(page);
      await sendLine(page, STORY);
      await page.getByText('Still working on it — long answers can take a minute or two.').waitFor();
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // the reply stops where one thought's limit came, signed like any, the note under it
  // spec: add-pet › Conversation flow › ответ оборван
  'pet-reply-cut': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await sendLine(page, STORY);
      await setWorker(page, { petState: { thought: { id: 'r', text: CUT_REPLY, cut: 'fuse' } } });
      await page.getByText("That's as far as one thought goes. Ask Pixel to keep going.").waitFor();
      await atNewest(page);
      await setWorker(page, { petState: {} });
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // a friend's meal woke the pet under the open page: who fed it, then its first thought thanks them
  // spec: add-pet › Sleep and wake flow › разбудил друг при открытой странице
  'pet-woken-by-friend': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await setWorker(page, { pets: { '9': { ...PIXEL, fullness: { state: 'asleep', level: 0 }, owner: { ownedCount: 2 } } }, petState: { events: ['fell_asleep'] } });
      await lookAgain(page);
      await page.getByText('Pixel fell asleep.').waitFor();
      await setWorker(page, {
        pets: { '9': { ...PIXEL, owner: { ownedCount: 2, pendingJob: 'wake-1', pendingMode: 'chat' } } },
        petState: { events: ['woke'], friend: 'Maya' },
      });
      await lookAgain(page);
      await page.getByText('Maya fed Pixel.').waitFor();
      await setWorker(page, { petState: { thought: { id: 'w', text: WAKE_REPLY, cut: null } } });
      await page.getByText('Thanks, Maya! While I slept I dreamed').waitFor();
      await atNewest(page);
      await setWorker(page, { petState: {} });
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // «Pause motion» tapped: the pet stands, the toggle says «Play motion»
  // spec: add-pet › Pet motion rule › пауза
  'pet-motion-paused': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await page.getByRole('button', { name: 'Pause motion' }).click();
      await page.getByRole('button', { name: 'Play motion' }).waitFor();
      // the frame is the page at rest, its field focused: not the moment of the tap
      await page.getByPlaceholder('Talk to Pixel…').focus();
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // the newborn that came from Biscuit's page: «Back to Biscuit», its greeting has come, hungry after it
  // spec: add-pet › Birth flow › пришёл по ссылке друга
  'pet-newborn-from-friend': {
    route: '/pet/9?from=2',
    fakes: {
      auth: SIGNED_IN,
      worker: {
        owned: ['9'],
        pets: { '9': { ...PIXEL, stage: 'baby', worn: null, fullness: { state: 'hungry', level: 11 / 12 }, owner: { hello: true } }, '2': BISCUIT },
        conversation: { lines: [], more: false, before: null },
        petState: { thought: { id: 'g', text: GREETING, cut: null } },
      },
    },
    prepare: async (page) => {
      await page.getByText('Hi! I\'m Pixel.').waitFor();
      await page.getByRole('link', { name: 'Back to Biscuit' }).waitFor();
    },
  },

  // Sign-in closed sheet: the tap on «Sign in» while sign-in is closed for new players, then for everyone
  // spec: add-account › Sign-in closed sheet screen › success (закрыт для новых)
  'signin-closed-new': {
    route: '/pet/2',
    fakes: { worker: { signIn: CLOSED_NEW } },
    prepare: async (page) => {
      await tapSignIn(page);
      await page.getByRole('dialog').waitFor();
      await settle(page);
    },
  },
  // spec: add-account › Sign-in closed sheet screen › success (закрыт для всех)
  'signin-closed-all': {
    route: '/pet/2',
    fakes: { worker: { signIn: CLOSED_ALL } },
    prepare: async (page) => {
      await tapSignIn(page);
      await page.getByRole('dialog').waitFor();
      await settle(page);
    },
  },

  // Open in browser sheet (phone only): inside X on Android, inside X on an iPhone after «Copy link», and the iPhone's field
  // when the copy did not work
  // spec: add-account › Open in browser sheet screen › success (Android)
  'open-browser-android': {
    route: '/pet/2',
    beforeLoad: asBrowser(UA.xOnAndroid),
    prepare: async (page) => {
      await tapSignIn(page);
      await page.getByRole('dialog').getByRole('button', { name: 'Open in browser' }).waitFor();
      await settle(page);
    },
  },
  // spec: add-account › Open in browser sheet screen › success (iPhone)
  'open-browser-iphone': {
    route: '/pet/2',
    beforeLoad: async (page) => {
      await asBrowser(UA.xOnIphone)(page);
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    },
    prepare: async (page) => {
      await tapSignIn(page);
      await page.getByRole('button', { name: 'Copy link' }).click();
      await page.mouse.move(0, 0);
      await page.getByRole('dialog').getByText('Link copied — paste it into Safari.').last().waitFor();
      await settle(page);
    },
  },
  // spec: add-account › Open in browser sheet screen › error
  'open-browser-error': {
    route: '/pet/2',
    beforeLoad: async (page) => {
      await asBrowser(UA.xOnIphone)(page);
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } });
      });
    },
    prepare: async (page) => {
      await tapSignIn(page);
      await page.getByRole('button', { name: 'Copy link' }).click();
      await page.getByLabel('Copy this link and paste it into Safari:').waitFor();
      await settle(page);
    },
  },

  // Sign-in flow on the Pet screen: Google or the provider failed; a new player refused after Google; a phone's way out
  // spec: add-account › Sign-in flow › вход не удался
  'signin-failed': {
    route: '/pet/2',
    fakes: { auth: { outcome: 'failed' } },
    // on the phone the frame draws the phone's way out under the error too (Sign-in flow › «запасной путь на телефоне»)
    beforeLoad: async (page) => {
      if ((page.viewportSize()?.width ?? Infinity) < 768) await asBrowser(UA.android)(page);
    },
    prepare: async (page) => {
      await tapSignIn(page);
      await page.getByText(FAILED_LINE).first().waitFor();
      await settle(page);
    },
  },
  // spec: add-account › Sign-in flow › новый после Google
  'signin-new-after-google': {
    route: '/pet/2',
    fakes: { worker: { session: { refused: { reason: 'mau', until: CLOSED_NEW.until } } } },
    prepare: async (page) => {
      await tapSignIn(page);
      await page.getByText(MAU_LINE).first().waitFor();
      await settle(page);
    },
  },
  // spec: add-account › Sign-in flow › запасной путь на телефоне
  'signin-fallback-phone': {
    route: '/pet/2',
    fakes: { auth: { outcome: 'cancelled' } },
    beforeLoad: asBrowser(UA.android),
    prepare: async (page) => {
      await tapSignIn(page);
      await page.getByText(FALLBACK_LINE).first().waitFor();
      await settle(page);
    },
  },

  // Home screen: a visitor with sign-in open; the check on its way; the game not reached; closed for new players, for everyone
  // spec: add-account › Home screen › signed-out
  'home-signed-out': { route: '/', prepare: async (page) => { await page.getByRole('button', { name: 'Sign in' }).waitFor(); await meadowReady(page); } },
  // spec: add-account › Home screen › loading
  'home-loading': {
    route: '/',
    fakes: { worker: { delayMs: FOREVER } },
    prepare: async (page) => { await page.getByText('Opening the game…').waitFor(); await meadowReady(page); },
  },
  // spec: add-account › Home screen › error
  'home-error': {
    route: '/',
    fakes: { worker: { signIn: { fail: { status: 0, code: 'unreachable' } } } },
    prepare: async (page) => { await page.getByRole('button', { name: 'Try again' }).waitFor(); await meadowReady(page); },
  },
  // spec: add-account › Home screen › signed-out (вход закрыт)
  'home-closed': {
    route: '/',
    fakes: { worker: { signIn: CLOSED_NEW } },
    prepare: async (page) => { await page.getByRole('button', { name: 'Played here before? Sign in' }).waitFor(); await meadowReady(page); },
  },
  // spec: add-account › Home screen › signed-out (вход закрыт)
  'home-closed-all': {
    route: '/',
    fakes: { worker: { signIn: CLOSED_ALL } },
    prepare: async (page) => { await page.getByText(CLOSED_ALL_WORDS).waitFor(); await meadowReady(page); },
  },
  // «Sign out» on the owner's page: Home without a session, the Toast, the focus on the h1
  // spec: add-account › Sign-out flow › вышел
  'home-signed-out-after': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), toastHeld: true } },
    prepare: async (page) => {
      await ownerReady(page);
      await page.getByRole('button', { name: 'Account' }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
      await page.getByRole('heading', { level: 1, name: HOOK }).waitFor();
      await page.getByText(SIGNED_OUT_LINE).first().waitFor();
      await meadowReady(page);
      await page.mouse.move(0, 0);
      await settle(page);
    },
  },

  // Account menu: open under «Account» on the owner's own pet, and on a friend's pet
  // spec: add-account › Account menu screen › success (владелец)
  'menu-owner': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await openMenu(page);
    },
    otherChange: OWNER_ELSEWHERE,
  },
  // spec: add-account › Account menu screen › success
  'menu-guest': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: { me: ME_PIXEL } },
    prepare: async (page) => {
      await page.getByRole('link', { name: 'Go to your Pixel' }).waitFor();
      await openMenu(page);
    },
    otherChange: GUEST_ELSEWHERE,
  },

  // Clear memory dialog over the owner's Pet screen: opened from the menu, what stays (the dialog's end on the phone), the
  // deletion refused, on its way, done (the typed line kept), the pet already someone else's
  // spec: add-account › Clear memory dialog screen › success
  'clear-memory': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await openClearDialog(page);
    },
    // design/INBOX.md line 185: the manifest still has the pre-proposal copy; the dialog keeps the spec's words.
    staleCopy: [
      '{name} will forget your chats, its diary, any skill you taught it, and what it knows about you, the friends who fed it and the pets it helped. Our backup keeps a copy for up to 30 days. NEAR AI may keep what it already received.',
    ],
  },
  // spec: add-account › Clear memory dialog screen › что останется
  'clear-memory-stays': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await openClearDialog(page);
    },
  },
  // spec: add-account › Clear memory dialog screen › error
  'clear-memory-error': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), clearMemory: { fail: { status: 503, code: 'chain_unreachable' } } } },
    prepare: async (page) => {
      await ownerReady(page);
      await openClearDialog(page);
      await page.getByRole('button', { name: 'Clear memory' }).click();
      await page.getByRole('button', { name: 'Try again' }).waitFor();
      await page.mouse.move(0, 0);
      await settle(page);
    },
  },
  // spec: add-account › Memory deletion flow › стирает
  'clear-memory-clearing': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), clearMemoryDelayMs: FOREVER } },
    prepare: async (page) => {
      await ownerReady(page);
      await openClearDialog(page);
      await page.getByRole('button', { name: 'Clear memory' }).click();
      await page.getByRole('button', { name: "Clearing Pixel's memory…" }).waitFor();
      await page.mouse.move(0, 0);
      await settle(page);
    },
  },
  // spec: add-account › Memory deletion flow › стёр
  'clear-memory-done': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await typeLine(page, TYPED);
      await openClearDialog(page);
      await page.getByRole('button', { name: 'Clear memory' }).click();
      await page.getByText("Pixel's memory is clear — same Pixel, fresh start.").first().waitFor();
      // the field keeps the focus the dialog gave back, as the frame shows it
      await page.mouse.move(0, 0);
      await settle(page);
    },
    otherChange: OWNER_ELSEWHERE,
  },
  // spec: add-account › Memory deletion flow › уже не владелец
  'clear-memory-new-owner': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), me: JUNO_ME, toastHeld: true } },
    prepare: async (page) => {
      await ownerReady(page);
      await openClearDialog(page);
      await setWorker(page, { owned: [], clearMemory: { fail: { status: 403, code: 'not_owner' } } });
      await page.getByRole('button', { name: 'Clear memory' }).click();
      await page.getByRole('link', { name: 'Go to your Juno' }).waitFor();
      await page.locator('.ds-toast').waitFor();
      await page.mouse.move(0, 0);
      await settle(page);
    },
    otherChange: GUEST_ELSEWHERE,
  },

  // Session expiry flow: the session ended under the owner's page, the typed line kept, «Sign in» in «Send»'s place
  // spec: add-account › Session expiry flow › сессия кончилась при открытом экране
  'session-expired': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await typeLine(page, TYPED);
      await setWorker(page, { sessionExpired: true });
      await lookAgain(page);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByText(SESSION_LINE).first().waitFor();
      await page.mouse.move(0, 0);
      await settle(page);
    },
    otherChange: OWNER_ELSEWHERE,
  },

  // Hatch screen › no exit: a signed-in player with no pet of their own, hatching closed for today — the line alone
  // spec: add-pet › Hatch screen › no exit
  'hatch-no-exit': {
    route: '/hatch',
    fakes: { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily', noPets: true } } },
    prepare: (page) => typeName(page, 'Pixel'),
  },

  // Feed sheet over the owner's Pet screen, Pixel Hungry
  // spec: add-feeding › Feed sheet screen › success (владелец)
  'feed-owner': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner({}, HUNGRY) },
    prepare: async (page) => {
      await ownerReady(page);
      await openFeedSheet(page, 'Feed Pixel');
    },
  },

  // the same with Pixel asleep: the free snack under the portions
  // spec: add-feeding › Feed sheet screen › success (владелец)
  'feed-owner-asleep': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner({}, ASLEEP), feedSheet: { fullness: ASLEEP, snack: { state: 'ready' } } } },
    prepare: async (page) => {
      await ownerReady(page);
      await openFeedSheet(page, 'Feed Pixel');
    },
  },

  // Feed sheet over a friend's page: the notice above the portions, the snack under them
  // spec: add-feeding › Feed sheet screen › success (гость)
  // spec: add-feeding › Feeder name rule › уведомление
  'feed-guest': {
    route: '/pet/2',
    fakes: guestFeed(),
    prepare: async (page) => {
      await page.getByRole('link', { name: 'Go to your Pixel' }).waitFor();
      await openFeedSheet(page, 'Feed Biscuit');
    },
    otherChange: GUEST_ELSEWHERE,
  },

  // a wallet with only the project's gas: the snack leads, «Pay with NEAR» closed
  // spec: add-feeding › Feed sheet screen › без NEAR
  'feed-no-near': {
    route: '/pet/2',
    fakes: guestFeed(NO_NEAR_SHEET),
    prepare: async (page) => {
      await page.getByRole('link', { name: 'Go to your Pixel' }).waitFor();
      await openFeedSheet(page, 'Feed Biscuit');
    },
    otherChange: GUEST_ELSEWHERE,
  },

  // «Pay with NEAR» opened: every portion out of reach, «Add 0.01 NEAR to give this meal.» under the smallest
  // spec: add-feeding › Feed sheet screen › без NEAR
  'feed-no-near-open': {
    route: '/pet/2',
    fakes: guestFeed(NO_NEAR_SHEET),
    prepare: async (page) => {
      await page.getByRole('link', { name: 'Go to your Pixel' }).waitFor();
      await openFeedSheet(page, 'Feed Biscuit');
      await page.getByRole('button', { name: 'Pay with NEAR' }).click();
      await page.getByText('Add 0.01 NEAR to give this meal.').waitFor();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
    otherChange: GUEST_ELSEWHERE,
  },

  // 0.08 NEAR: the 0.2 portion is short by 0.13
  // spec: add-feeding › Feed sheet screen › мало NEAR
  'feed-low-near': {
    route: '/pet/9',
    fakes: {
      auth: SIGNED_IN,
      worker: {
        ...owner({}, HUNGRY),
        feedSheet: {
          wallet: { state: 'some', balance: '80000000000000000000000' },
          portions: PORTIONS_FIT.map((p) => (p.near === '0.2' ? { ...p, missing: '0.13' } : p)),
        },
      },
    },
    prepare: async (page) => {
      await ownerReady(page);
      await openFeedSheet(page, 'Feed Pixel');
    },
  },

  // the server did not answer: «We couldn't open feeding right now.»
  // spec: add-feeding › Feed sheet screen › error
  'feed-error': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner({}, HUNGRY), feedSheet: { fail: { status: 500, code: 'error' } } } },
    prepare: async (page) => {
      await ownerReady(page);
      await openFeedSheet(page, 'Feed Pixel');
      await page.getByRole('button', { name: 'Try again' }).waitFor();
    },
  },

  // «Feed your {my_pet}» on a friend's page: the own Pixel's sheet in its own state, Hungry at 0.125
  // spec: add-feeding › Own pet feeding flow › открыл кормление
  'feed-own-from-friend': {
    route: '/pet/2',
    fakes: {
      auth: SIGNED_IN,
      worker: { me: ME_PIXEL, owned: ['9'], pets: { '9': { ...PIXEL, fullness: { state: 'hungry', level: 0.125 } }, '2': BISCUIT } },
    },
    prepare: async (page) => {
      await page.getByRole('link', { name: 'Go to your Pixel' }).waitFor();
      // the hook stands for the button of `add-pet-work`'s advice column, which is not built yet
      await page.evaluate(() =>
        (globalThis as { __nearlingOpenFeed?: (r: unknown) => void }).__nearlingOpenFeed?.({ tokenId: '9', name: 'Pixel', label: 'your Pixel', elsewhere: true }),
      );
      await page.getByRole('dialog', { name: 'Feed your Pixel' }).waitFor();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settle(page);
    },
    otherChange: GUEST_ELSEWHERE,
  },

  // 0.05 NEAR tapped, the send held: the row says «Feeding Pixel…», the others are off
  // spec: add-feeding › Feeding outcome rule › отправлено
  'feed-sending': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner({}, HUNGRY), feedSendDelayMs: FOREVER } },
    prepare: async (page) => {
      await ownerReady(page);
      await openFeedSheet(page, 'Feed Pixel');
      await page.getByRole('button', { name: /^Feed · 23¢/ }).click();
      await page.getByRole('button', { name: 'Feeding Pixel…' }).waitFor();
      await restAfterTap(page);
    },
  },

  // the transaction did not go through: the line, «Try again» with the focus, the tapped row marked
  // spec: add-feeding › Feeding outcome rule › не прошло
  'feed-failed': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner({}, HUNGRY), sendFeed: { status: 'failed', hatched: true } } },
    prepare: async (page) => {
      await ownerReady(page);
      await openFeedSheet(page, 'Feed Pixel');
      await page.getByRole('button', { name: /^Feed · 23¢/ }).click();
      await page.locator('#feed-failed').waitFor();
      await restAfterTap(page);
    },
  },

  // the meal landed on an awake pet: Full on the page and in the head of the sheet, «Yum!» and «Done»
  // spec: add-feeding › Own pet feeding flow › накормил бодрствующего
  'feed-yum': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner({}, HUNGRY) },
    prepare: async (page) => {
      await ownerReady(page);
      await openFeedSheet(page, 'Feed Pixel');
      await setWorker(page, { pets: owner({}, PIXEL.fullness).pets });
      await page.getByRole('button', { name: /^Feed · 5¢/ }).click();
      await page.getByRole('button', { name: 'Done' }).waitFor();
      await restAfterTap(page);
    },
  },

  // a friend who has a pet of their own: the thanks with their name and «Done», Biscuit full
  // spec: add-feeding › Feed by link flow › друг уже вылупил питомца
  // spec: add-feeding › Feed by link flow › друг покормил
  'feed-thanks': {
    route: '/pet/2',
    fakes: guestFeed(),
    prepare: async (page) => {
      await page.getByRole('link', { name: 'Go to your Pixel' }).waitFor();
      await openFeedSheet(page, 'Feed Biscuit');
      await setWorker(page, { pets: { '9': PIXEL, '2': BISCUIT } });
      await page.getByRole('button', { name: /^Feed · 5¢/ }).click();
      await page.getByRole('button', { name: 'Done' }).waitFor();
      await restAfterTap(page);
    },
    otherChange: GUEST_ELSEWHERE,
  },

  // the friend already gave this pet a snack today: the line in its place
  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня
  'feed-snack-given': {
    route: '/pet/2',
    fakes: guestFeed({ snack: { state: 'given' } }),
    prepare: async (page) => {
      await page.getByRole('link', { name: 'Go to your Pixel' }).waitFor();
      await openFeedSheet(page, 'Feed Biscuit');
    },
    otherChange: GUEST_ELSEWHERE,
  },

  // the owner's pet asleep and the last snack under 72 hours ago: the date and the time, the spec's «Nov 12 at 9:40 PM» (the frame
  // draws the older «Nov 12, 2026»; the spec wins). The time has no zone, so it is 9:40 PM wherever the browser is.
  // spec: add-feeding › Snack rule › перекус владельцу ещё не готов
  'feed-snack-not-ready': {
    route: '/pet/9',
    fakes: {
      auth: SIGNED_IN,
      worker: { ...owner({}, ASLEEP), feedSheet: { fullness: ASLEEP, snack: { state: 'not_ready', at: '2026-11-12T21:40:00' } } },
    },
    prepare: async (page) => {
      await ownerReady(page);
      await openFeedSheet(page, 'Feed Pixel');
    },
  },

  // Add NEAR, the step inside Feed sheet that «Add NEAR» under the short portion opens
  // spec: add-feeding › Add NEAR sheet screen › success
  'add-near': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: addNearWorker() },
    prepare: openAddNear,
  },

  // «Copy» tapped: the Toast (held for the capture) and the sheet's live region say it
  // spec: add-feeding › Add NEAR sheet screen › success
  'add-near-copied': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...addNearWorker(), toastHeld: true } },
    beforeLoad: browserWith({ clipboard: 'ok' }),
    prepare: async (page) => {
      await openAddNear(page);
      await page.getByRole('button', { name: 'Copy' }).click();
      await page.getByText('Address copied.').first().waitFor();
      await restAfterTap(page);
    },
  },

  // NEAR came while the sheet was open: «Your NEAR is here!» (the return to Feed sheet is held for the capture)
  // spec: add-feeding › Add NEAR sheet screen › NEAR пришёл
  'add-near-arrived': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...addNearWorker(), toastHeld: true } },
    prepare: async (page) => {
      await openAddNear(page);
      await setWorker(page, { wallet: { address: FRAME_ADDRESS, balance: '900000000000000000000000', funded: true } });
      await lookAgain(page);
      await page.getByText('Your NEAR is here!').first().waitFor();
      await restAfterTap(page);
    },
  },

  // the address does not load
  // spec: add-feeding › Add NEAR sheet screen › error
  'add-near-error': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...addNearWorker(), wallet: { fail: { status: 503, code: 'chain_unreachable' } } } },
    prepare: async (page) => {
      await ownerReady(page);
      await openFeedSheet(page, 'Feed Pixel');
      await page.getByRole('button', { name: 'Add NEAR' }).click();
      await page.getByText("We couldn't show your address right now.").waitFor();
      await restAfterTap(page);
    },
  },

  // no share menu, the clipboard works: «Link copied — send it to a friend.» (the Toast held for the capture)
  // spec: add-feeding › Feed link sharing flow › делится
  'feed-link-copied': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner({}, HUNGRY), toastHeld: true } },
    beforeLoad: browserWith({ clipboard: 'ok' }),
    prepare: async (page) => {
      await ownerReady(page);
      await openFeedSheet(page, 'Feed Pixel');
      await page.getByRole('button', { name: 'Ask friends to feed Pixel' }).click();
      await page.getByText('Link copied — send it to a friend.').first().waitFor();
      await restAfterTap(page);
    },
  },

  // no share menu and the clipboard refuses: the text with the link in a field to select
  // spec: add-feeding › Feed link sharing flow › скопировать не вышло
  'feed-link-manual': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner({}, HUNGRY) },
    beforeLoad: browserWith({ clipboard: 'denied' }),
    prepare: async (page) => {
      await ownerReady(page);
      await openFeedSheet(page, 'Feed Pixel');
      await page.getByRole('button', { name: 'Ask friends to feed Pixel' }).click();
      await page.getByLabel('Copy this link and send it to a friend:').waitFor();
      await page.mouse.move(0, 0);
      await settle(page);
    },
  },

  // spec: add-daily-ritual › Diary screen › success
  'diary-success': {
    route: '/pet/9/diary',
    fakes: { auth: SIGNED_IN, worker: diaryWorker({ entry: entryWithWork(), streak: STREAK_2 }) },
    prepare: diaryReady,
    // the work line is `add-pet-work`'s `Work diary rule` (2026-11-03): «…helped {hirers} and got {amount} of food for it.»; the frame
    // still has «…helped {hirers}, earning {amount}.» (design/INBOX.md). `web/e2e/hire.spec.ts` asserts the spec's words
    staleCopy: ['In the 24 hours before {time}, {name} helped {hirers}, earning {amount}.'],
  },

  // spec: add-daily-ritual › Diary screen › empty
  'diary-empty': {
    route: '/pet/9/diary',
    fakes: {
      auth: SIGNED_IN,
      worker: diaryWorker({
        entry: { kind: 'first' },
        streak: { ...STREAK_2, days: 0 },
        yesterday: { kind: 'none', answer: 'a piano' },
        parts: ['riddle'],
      }),
    },
    prepare: diaryReady,
  },

  // spec: add-daily-ritual › Diary screen › память стёрта сегодня
  'diary-memory-cleared': {
    route: '/pet/9/diary',
    fakes: {
      auth: SIGNED_IN,
      worker: diaryWorker({
        entry: { kind: 'cleared' },
        riddle: ANSWERED_CLEARED,
        yesterday: { kind: 'none', answer: 'a piano' },
        streak: { ...STREAK_2, done: true, note: ['saving'] },
        parts: [],
        complete: true,
      }),
    },
    prepare: diaryReady,
  },

  // spec: add-daily-ritual › Diary screen › loading
  'diary-loading': {
    route: '/pet/9/diary',
    fakes: { auth: SIGNED_IN, worker: diaryWorker({}, { diaryDelayMs: FOREVER }) },
    prepare: async (page) => {
      await page.getByRole('status').filter({ hasText: "Opening Pixel's diary…" }).first().waitFor();
    },
  },

  // the diary read, the fields typed, then the load of the new day fails: «error» over the last known diary
  // spec: add-daily-ritual › Diary screen › error
  'diary-error': {
    route: '/pet/9/diary',
    fakes: { auth: SIGNED_IN, worker: diaryWorker({ entry: entryWithWork(), streak: STREAK_2 }) },
    beforeLoad: nearMidnight,
    prepare: async (page) => {
      await diaryReady(page);
      await typeDiary(page, DIARY_ANSWER, DIARY_TYPED);
      // the player has stopped typing: with a field in the focus the page stays where it is (`DiaryPage`), and the frame stands at
      // the top by the page's own scroll, not the fixture's
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await setWorker(page, { diary: { fail: { status: 0, code: 'unreachable' } } });
      await page.clock.fastForward(15_000);
      await page.getByText("We couldn't open Pixel's diary right now. Try again in a moment.").waitFor();
      await page.mouse.move(0, 0);
    },
  },

  // the session ended under the open Diary, «Send answer» tapped: the line and «Sign in», the riddle answer kept
  // spec: add-daily-ritual › Diary screen › signed-out
  'diary-signed-out': {
    route: '/pet/9/diary',
    fakes: { auth: SIGNED_IN, worker: diaryWorker({ entry: entryWithWork(), streak: STREAK_2 }) },
    prepare: async (page) => {
      await diaryReady(page);
      await typeDiary(page, null, DIARY_TYPED);
      await setWorker(page, { sessionExpired: true });
      await lookAgain(page);
      await page.getByRole('button', { name: 'Send answer' }).click();
      await page.getByText("You've been signed out. Sign in to get back to Pixel's diary.").first().waitFor();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  },

  // the pet fell asleep while the diary was open: the line and «Feed Pixel» in place of the fields, the ritual done and saving
  // spec: add-daily-ritual › Diary screen › asleep
  'diary-asleep': {
    route: '/pet/9/diary',
    fakes: { auth: SIGNED_IN, worker: diaryWorker({ entry: entryWithWork(), streak: STREAK_2 }) },
    prepare: (page) => fallAsleep(page, null),
  },

  // spec: add-daily-ritual › Diary screen › уснул с набранным ответом
  'diary-asleep-typed': {
    route: '/pet/9/diary',
    fakes: { auth: SIGNED_IN, worker: diaryWorker({ entry: entryWithWork(), streak: STREAK_2 }) },
    prepare: (page) => fallAsleep(page, DIARY_TYPED),
  },

  // the last part done: the exchange under the question, «Answer in!…» with the answer, the streak saving
  // spec: add-daily-ritual › Daily ritual flow › ритуал завершён
  'diary-done': {
    route: '/pet/9/diary',
    fakes: {
      auth: SIGNED_IN,
      worker: diaryWorker({
        entry: entryWithWork(),
        exchange: { answer: DIARY_ANSWER, reply: DIARY_REPLY },
        riddle: { kind: 'answered', day: SAMPLE_DAY, text: DIARY_RIDDLE, answer: DIARY_TYPED },
        streak: SAVING_STREAK,
        parts: [],
        complete: true,
      }),
    },
    prepare: diaryReady,
  },

  // back after a missed day a freeze covered: the line, the forecast number with its note, the covered day dashed
  // spec: add-daily-ritual › Streak rule › заморозка спасла серию
  'diary-streak-saved': {
    route: '/pet/9/diary',
    fakes: {
      auth: SIGNED_IN,
      worker: diaryWorker({ entry: entryWithWork(), streak: { days: 2, freezes: 0, done: false, line: 'frozen', n: 2, k: 0, missed: 1, note: ['forecast'] } }),
    },
    prepare: diaryReady,
    // the frame's manifest `copy` still reads «…safe while you were away…», behind the spec (design/INBOX.md): the spec's words
    // are asserted by e2e/diary-streak.spec.ts
    staleCopy: ['A streak freeze kept your {n}-day streak safe while you were away. Freezes left: {k}.'],
  },

  // spec: add-daily-ritual › Streak rule › серия началась заново
  'diary-streak-reset': {
    route: '/pet/9/diary',
    fakes: {
      auth: SIGNED_IN,
      worker: diaryWorker({ entry: entryWithWork(), streak: { days: 0, freezes: 0, done: false, line: 'fresh', n: 2, k: 0, missed: 2, note: ['forecast'] } }),
    },
    prepare: diaryReady,
  },

  // the pet at its daily cap: «Answer Pixel» off with the line beside it, the riddle still open
  // spec: add-daily-ritual › Ritual day rule › питомец устал
  'diary-tired': {
    route: '/pet/9/diary',
    fakes: { auth: SIGNED_IN, worker: { ...owner({ tired: true, until: MIDNIGHT_UTC }), diary: { entry: entryWithWork(), streak: STREAK_2, parts: ['riddle'] } } },
    prepare: diaryReady,
  },

  // Pixel owns the Daisy crown, the Thinking cap (worn) and the Party hat; the Cozy scarf not yet, three to buy
  // spec: add-wardrobe › Wardrobe screen › success
  'wardrobe-success': {
    route: '/pet/9/wardrobe',
    fakes: { auth: SIGNED_IN, worker: wardrobeWorker() },
    prepare: wardrobeReady,
  },

  // the newborn on its starter food: nothing to wear, every earned item on its condition, every Buy off with the food line
  // spec: add-wardrobe › Wardrobe screen › empty
  'wardrobe-empty': {
    route: '/pet/9/wardrobe',
    fakes: { auth: SIGNED_IN, worker: wardrobeWorker(BABY, { short: true }) },
    prepare: wardrobeReady,
  },

  // the phone, scrolled to the end: the food line above the Buy items
  // spec: add-wardrobe › Wardrobe screen › empty
  'wardrobe-empty-end': {
    route: '/pet/9/wardrobe',
    fakes: { auth: SIGNED_IN, worker: wardrobeWorker(BABY, { short: true }) },
    prepare: wardrobeReady,
  },

  // the wardrobe still opening: the pet in its outfit, the tiles of what the page knows, every action disabled
  // spec: add-wardrobe › Wardrobe screen › loading
  'wardrobe-loading': {
    route: '/pet/9/wardrobe',
    fakes: { auth: SIGNED_IN, worker: wardrobeWorker({}, {}, { wardrobeDelayMs: FOREVER }) },
    prepare: async (page) => {
      await page.getByRole('status').filter({ hasText: "Opening Pixel's wardrobe…" }).first().waitFor();
    },
  },

  // the server gave no wardrobe: the line and «Try again», the pet in its last known outfit, no tiles
  // spec: add-wardrobe › Wardrobe screen › error
  'wardrobe-error': {
    route: '/pet/9/wardrobe',
    fakes: { auth: SIGNED_IN, worker: wardrobeWorker({}, { fail: { status: 0, code: 'unreachable' } }) },
    prepare: async (page) => {
      await page.getByText("We couldn't open Pixel's wardrobe right now. Try again in a moment.").waitFor();
      await page.mouse.move(0, 0);
    },
  },

  // the session ended under the open wardrobe, «Wear» tapped: the line and «Sign in», nothing worn
  // spec: add-wardrobe › Wardrobe screen › signed-out
  'wardrobe-signed-out': {
    route: '/pet/9/wardrobe',
    fakes: { auth: SIGNED_IN, worker: wardrobeWorker() },
    prepare: async (page) => {
      await wardrobeReady(page);
      await setWorker(page, { sessionExpired: true });
      await lookAgain(page);
      await page.getByRole('button', { name: 'Wear Daisy crown' }).click();
      await page.getByText("You've been signed out. Sign in to get back to Pixel's wardrobe.").first().waitFor();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  },

  // the pet fell asleep while the wardrobe was open: the line and «Back to Pixel», every Buy off
  // spec: add-wardrobe › Wardrobe screen › asleep
  'wardrobe-asleep': {
    route: '/pet/9/wardrobe',
    fakes: { auth: SIGNED_IN, worker: wardrobeWorker() },
    prepare: async (page) => {
      await wardrobeReady(page);
      await setWorker(page, { pets: { '9': { ...PIXEL, worn: 'thinking-cap', fullness: { state: 'asleep', level: 0 }, owner: { ownedCount: 2, outfits: [...WARDROBE_OWNS] } }, '2': BISCUIT } });
      await lookAgain(page);
      await page.getByText('Pixel fell asleep. A meal will wake Pixel up — you can still change outfits.').first().waitFor();
      await page.mouse.move(0, 0);
    },
  },

  // the Smart glasses' Buy tapped: «Buying…» on it, the other Buys off, until NEAR answers (the fake holds the purchase)
  // spec: add-wardrobe › Outfit purchase flow › покупает
  'wardrobe-buying': {
    route: '/pet/9/wardrobe',
    fakes: { auth: SIGNED_IN, worker: wardrobeWorker() },
    prepare: async (page) => {
      await tapSmartGlassesBuy(page);
      await page.mouse.move(0, 0);
    },
  },

  // that purchase landed: the pet in it, its tile among the own ones with «Take off», the line under the pet
  // spec: add-wardrobe › Outfit purchase flow › куплено
  'wardrobe-bought': {
    route: '/pet/9/wardrobe',
    fakes: { auth: SIGNED_IN, worker: wardrobeWorker() },
    prepare: async (page) => {
      await tapSmartGlassesBuy(page);
      await setWorker(page, {
        pets: { '9': { ...PIXEL, worn: 'smart-glasses', owner: { ownedCount: 2, outfits: [...WARDROBE_OWNS, 'smart-glasses'] } }, '2': BISCUIT },
        wardrobe: { buying: null, outcome: { id: 'buy-1', item: 'smart-glasses', status: 'bought', code: null } },
      });
      await page.getByText('Pixel is wearing the Smart glasses!', { exact: true }).and(page.locator(':not(.ds-hidden)')).waitFor();
      await page.mouse.move(0, 0);
    },
  },

  // that purchase was refused: «Try again» in the Buy's place, the line across the grid under its row, nothing spent
  // spec: add-wardrobe › Outfit purchase flow › не прошло
  'wardrobe-buy-failed': {
    route: '/pet/9/wardrobe',
    fakes: { auth: SIGNED_IN, worker: wardrobeWorker() },
    prepare: async (page) => {
      await tapSmartGlassesBuy(page);
      await setWorker(page, { wardrobe: { buying: null, outcome: { id: 'buy-1', item: 'smart-glasses', status: 'failed', code: 'short' } } });
      await page.getByRole('button', { name: 'Try again Smart glasses' }).waitFor();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  },

  // the services' gas pause: the line at the top of the list, every Buy off, the own outfits work
  // spec: add-wardrobe › Outfit purchase flow › покупки на паузе
  'wardrobe-shop-paused': {
    route: '/pet/9/wardrobe',
    fakes: { auth: SIGNED_IN, worker: wardrobeWorker({}, { shopPaused: true }) },
    prepare: wardrobeReady,
  },

  // a 3-day streak was written to the chain: the notice opened by itself over the owner's Pet screen, the pet in the Cozy scarf
  // spec: add-wardrobe › New outfit notice screen › success
  'outfit-new': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner({ notices: ['cozy-scarf'], outfits: [...WARDROBE_OWNS, 'cozy-scarf'] }) },
    prepare: noticeReady,
  },

  // «Wear it» tapped and the server did not answer: the line in the text's place, the pet in its former outfit, «Later» alone
  // spec: add-wardrobe › New outfit notice screen › error
  'outfit-new-error': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner({ notices: ['cozy-scarf'], outfits: [...WARDROBE_OWNS, 'cozy-scarf'] }), wear: { fail: { status: 0, code: 'unreachable' } } } },
    prepare: async (page) => {
      await noticeReady(page);
      await page.getByRole('button', { name: 'Wear it' }).click();
      await page.getByText("Couldn't put it on just now. The Cozy scarf is waiting in Pixel's wardrobe.").first().waitFor();
      await page.mouse.move(0, 0);
      await settle(page);
    },
  },

  // The owner's hire frames (design/bundle/screens/work.js): Pixel asks Nori (seed 5, aqua), 0.38¢. The hiring mode is built:
  // the frames' «Auto» / «Ask me first» and its line are drawn by the real switch.

  // spec: add-pet-work › Pet hire flow › спрашивает
  'work-asking': {
    route: '/pet/9',
    // the frame is the first seconds: a slow machine must not reach the 10 s line before the shot
    fakes: { auth: SIGNED_IN, worker: { ...owner(HIRE_JOB), conversation: hireTurn(), petState: { pending: true }, waitLineMs: FOREVER } },
    prepare: async (page) => {
      await page.getByText('Pixel is asking Nori…').waitFor();
      await atNewest(page);
    },
  },

  // spec: add-pet-work › Pet hire flow › спросил
  'work-asked': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), conversation: hireTurn(nori(), pixelSays(PET_SAYS, NORI_PAID)) } },
    prepare: async (page) => {
      await page.getByText('Pixel asked Nori · 0.38¢').waitFor();
      await atNewest(page);
    },
  },

  // spec: add-pet-work › Pet hire flow › предложение в Manual
  'work-offer': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(MANUAL_OFFER), conversation: hireTurn() } },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ask Nori' }).waitFor();
      await atNewest(page);
      await page.mouse.move(0, 0);
    },
  },

  // spec: add-pet-work › Pet hire flow › отказ в Manual
  'work-declined': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(MANUAL_OFFER), conversation: hireTurn(), petState: { pending: true } } },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'No thanks' }).click();
      await page.getByText('Pixel is thinking…').waitFor();
      // the server dropped the offer and the pet answered on its own, nothing spent
      await setWorker(page, {
        conversation: hireTurn(pixelSays(PET_ALONE, null)),
        pets: { '9': { ...PIXEL, worn: 'thinking-cap', owner: { ownedCount: 2, outfits: WARDROBE_OWNS, hireMode: 'manual', offer: null } }, '2': BISCUIT },
        petState: { offer: null, thought: { id: 'w3', text: PET_ALONE, cut: null } },
      });
      await page.getByText(PET_ALONE).waitFor();
      await setWorker(page, { petState: {} });
      await atNewest(page);
      await page.mouse.move(0, 0);
    },
  },

  // the tap on «Ask Nori» ended with no answer: the lost thought's line where the answer would be, no «Try again» — the card's own
  // buttons are back, the offer still standing
  // spec: add-pet-work › Pet hire flow › нажатая кнопка вернулась
  'work-tap-back': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(MANUAL_OFFER), conversation: hireTurn(), petState: { pending: true } } },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ask Nori' }).click();
      await page.getByRole('button', { name: 'Ask Nori' }).waitFor({ state: 'detached' });
      await setWorker(page, { petState: { pending: false, code: 'ai_unavailable', jobKind: 'hire' } });
      await page.getByText('Pixel lost that thought. Nothing was spent — try again.').first().waitFor();
      await page.getByRole('button', { name: 'Ask Nori' }).waitFor();
      await atNewest(page);
      await page.mouse.move(0, 0);
    },
  },

  // spec: add-pet-work › Pet hire flow › найм не состоялся
  'work-hire-failed': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), conversation: hireTurn(hireEvent('hire_failed'), pixelSays(PET_ALONE, null)) } },
    prepare: async (page) => {
      await page.getByText("Nori couldn't help just now, so Pixel answered on its own. No fee was paid.").waitFor();
      await atNewest(page);
    },
  },

  // spec: add-pet-work › Pet hire flow › работник ответил пусто
  'work-came-up-empty': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), conversation: hireTurn(hireEvent('hire_empty'), pixelSays(PET_ALONE, null)) } },
    prepare: async (page) => {
      await page.getByText("Nori came up empty, so Pixel answered on its own. No fee was paid — the try used a little of Pixel's food.").waitFor();
      await atNewest(page);
    },
  },

  // spec: add-pet-work › Pet hire flow › свой ответ не пришёл
  'work-own-reply-lost': {
    route: '/pet/9',
    // the lost own reply is the outcome of the tab's own job: the page adopts the job on its way and learns how it ended
    fakes: {
      auth: SIGNED_IN,
      worker: {
        ...owner({ pendingJob: 'job-1', pendingKind: 'reply', pendingMode: 'chat', pendingText: null }),
        conversation: hireTurn(nori(NORI_PAID)),
        petState: { code: 'own_lost', ownLost: { turn: 'w1' } },
      },
    },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Try again' }).waitFor();
      await atNewest(page);
      await page.mouse.move(0, 0);
    },
  },

  // spec: add-pet-work › Pet hire flow › найм не записан в сети
  'work-no-fee': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), conversation: hireTurn(nori(), pixelSays(PET_SAYS, { worker: 'Nori', noFee: true })) } },
    prepare: async (page) => {
      await page.getByText('Pixel asked Nori · no fee').waitFor();
      await atNewest(page);
    },
  },

  // The guest's advice frames (design/bundle/screens/work.js): Pixel's player on Biscuit's page, the column where the owner's
  // conversation stands. `advice-cant-pay` has no fixture: its frame contradicts the Scenario (design.md › Клиент › Frames).

  // the question sent, Biscuit thinking: the page read the question on its way (a reload brings it back the same way)
  // spec: add-pet-work › Advice flow › вопрос отправлен
  'advice-sent': {
    route: '/pet/2',
    // the frame is the first seconds: a slow machine must not reach the 10 s line before the shot
    fakes: { auth: SIGNED_IN, worker: { ...guestAdvice({ pending: { job: 'job-advice', question: ADVICE_QUESTION } }), petState: { pending: true }, waitLineMs: FOREVER } },
    prepare: async (page) => {
      await page.getByText('Biscuit is thinking…').first().waitFor();
      await page.mouse.move(0, 0);
    },
  },

  // Biscuit's answer in its voice, with its receipt and where it is kept
  // spec: add-pet-work › Advice flow › ответ
  'advice-answer': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: guestAdvice({ last: { id: 'a1', question: ADVICE_QUESTION, text: ADVICE_ANSWER, skilled: false } }) },
    prepare: async (page) => {
      await page.getByText(ADVICE_ANSWER).waitFor();
      await page.mouse.move(0, 0);
    },
  },

  // on the asker's own pet's page the advice it paid for stays in the conversation
  // spec: add-pet-work › Advice flow › совет потом
  'advice-later': {
    route: '/pet/9',
    fakes: {
      auth: SIGNED_IN,
      worker: {
        ...owner(),
        conversation: {
          lines: [
            ...HISTORY,
            { id: 'adv:you', who: 'player', text: ADVICE_QUESTION, at: 1_700_000_000_100 },
            { id: 'adv', who: 'worker', text: ADVICE_ANSWER, at: 1_700_000_000_101, worker: { tokenId: '2', name: 'Biscuit' }, skilled: false },
          ],
          more: false,
          before: null,
        },
      },
    },
    prepare: async (page) => {
      await page.getByText(ADVICE_ANSWER).waitFor();
      await atNewest(page);
    },
  },

  // the answer came back empty past the third today: the line where it would be, the question back in the field
  // spec: add-pet-work › Advice flow › пустой ответ работника
  'advice-empty': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: guestAdvice() },
    prepare: async (page) => {
      await adviceReady(page);
      await askAdvice(page, { code: 'empty_paid' });
      await page.getByText(/lost that answer/).first().waitFor();
      await page.getByRole('button', { name: /^Ask Biscuit/ }).and(page.locator(':not([aria-busy])')).waitFor();
      await page.getByPlaceholder('Ask Biscuit for advice…').blur();
    },
  },

  // Biscuit fell asleep after the question went: the sent question is back in the field, the line why «Ask» is off
  // spec: add-pet-work › Advice flow › работник уснул
  'advice-worker-asleep': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: guestAdvice() },
    prepare: async (page) => {
      await adviceReady(page);
      await setWorker(page, { pets: { '9': PIXEL, '2': { ...BISCUIT, fullness: { state: 'asleep', level: 0 } } }, advice: { price: ADVICE_PRICE, workerAsleep: true } });
      await askAdvice(page, { code: 'worker_asleep' });
      await page.getByText("Biscuit couldn't help just now. Nothing was spent — your question is kept.").first().waitFor();
      await page.getByText('Asleep', { exact: true }).first().waitFor();
      await page.getByPlaceholder('Ask Biscuit for advice…').blur();
    },
  },

  // Pixel is at its day's limit: the line in the button's place, the question kept
  // spec: add-pet-work › Advice flow › свой питомец устал
  'advice-tired': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: guestAdvice({ payer: { ...ADVICE_PAYER, state: 'tired', until: MIDNIGHT_UTC } }) },
    prepare: async (page) => {
      await page.getByText(/is tired for today/).first().waitFor();
      await typeAdvice(page);
    },
  },

  // Pixel cannot pay Biscuit's price: the line and «Feed your Pixel» in the button's place, the question kept
  // spec: add-pet-work › Advice flow › свой питомец не может заплатить
  'advice-cant-pay': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: guestAdvice({ payer: { ...ADVICE_PAYER, state: 'short', until: null } }) },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Feed your Pixel' }).waitFor();
      await typeAdvice(page);
    },
  },

  // the same for a skilled worker above its starting price: its price drops back at the day's end
  // spec: add-pet-work › Advice flow › свой питомец не может заплатить
  'advice-cant-pay-skilled': {
    route: '/pet/7',
    fakes: { auth: SIGNED_IN, worker: guestSage({ price: SAGE_PRICE_NOW, dropsAt: MIDNIGHT_UTC, payer: { ...ADVICE_PAYER, state: 'short', until: null } }) },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Feed your Pixel' }).waitFor();
      await typeAdvice(page, ASK_SAGE, 'Sage');
    },
  },

  // Sage's page: its label under its name, its price now 0.56¢, the notes under «Your Pixel pays…»
  // spec: add-pet-work › Advice flow › advice from a pet with a skill
  'advice-skilled': {
    route: '/pet/7',
    fakes: { auth: SIGNED_IN, worker: guestSage({ price: SAGE_PRICE_NOW }) },
    prepare: async (page) => {
      await page.getByRole('button', { name: /^Ask Sage/ }).waitFor();
      await page.mouse.move(0, 0);
    },
  },

  // the question met a price that rose: not sent, kept in the field, the line above the bar, the button at the new price
  // spec: add-pet-work › Advice flow › price rose
  'advice-price-rose': {
    route: '/pet/7',
    fakes: { auth: SIGNED_IN, worker: guestSage({ price: SAGE_PRICE_NOW }) },
    prepare: async (page) => {
      await page.getByRole('button', { name: /^Ask Sage/ }).waitFor();
      await setWorker(page, { petState: { pending: true } });
      const field = page.getByPlaceholder('Ask Sage for advice…');
      await field.fill(ASK_SAGE);
      await field.press('Enter');
      await page.getByText('Sage is thinking…').first().waitFor();
      await setWorker(page, { advice: { price: SAGE_PRICE_ROSE, skilled: true }, petState: { code: 'price_rose', price: SAGE_PRICE_ROSE } });
      await page.getByText("Sage is busier now — it's 0.74¢. Your question is still here, and nothing was spent.").first().waitFor();
      await field.blur();
    },
  },

  // the asker opens the page again: the last question and Sage's answer with its receipt; the field empty, today's price on the button
  // spec: add-pet-work › Advice flow › page opened again
  'advice-reopened': {
    route: '/pet/7',
    fakes: { auth: SIGNED_IN, worker: guestSage({ price: SAGE_PRICE_ROSE, last: { id: 'a1', question: ASK_SAGE, text: SAGE_ADVICE, skilled: true, dataLabels: [SAGE_SOURCE] } }) },
    prepare: async (page) => {
      await page.getByText(SAGE_ADVICE).waitFor();
      await page.mouse.move(0, 0);
    },
  },

  // the paying pet's memory was cleared while the answer was on its way: the line in place of the answer, the question in the field
  // spec: add-pet-work › Advice flow › memory cleared on the way
  'advice-memory-cleared': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: guestAdvice() },
    prepare: async (page) => {
      await adviceReady(page);
      await askAdvice(page, { code: 'memory_cleared' });
      await page.getByText("Pixel's memory was cleared, so this answer wasn't kept. It used a little of your Pixel's food.").first().waitFor();
      await page.getByRole('button', { name: /^Ask Biscuit/ }).and(page.locator(':not([aria-busy])')).waitFor();
      await page.getByPlaceholder('Ask Biscuit for advice…').blur();
    },
  },

  // Sage answered in Auto with its skill: the line in the answer's foot beside its receipt, the price on Pixel's reply
  // spec: add-pet-work › Worker rule › answer with a skill
  'work-skilled': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), pets: sagePets(), conversation: sageTurn(sageSays(), pixelSays(PET_ON_SAGE, SAGE_PAID)) } },
    prepare: async (page) => {
      await page.getByText('Pixel asked Sage · 0.56¢').waitFor();
      await atNewest(page);
    },
  },

  // Sage's data did not answer in a hire: no answer, no fee, the game's line, then Pixel's own answer
  // spec: add-pet-errands › Adapter call rule › data failed in a hire
  'work-data-failed': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), pets: sagePets(), conversation: sageTurn(sageEvent('hire_data_failed'), pixelSays(NO_FORECAST, null)) } },
    prepare: async (page) => {
      await page.getByText("Sage's skill couldn't get its data just now, so Pixel answered on its own. No fee was paid.").waitFor();
      await atNewest(page);
    },
  },

  // past the paying pet's third failed call of the day: the try used a little of Pixel's food
  // spec: add-pet-errands › Adapter call rule › data failed in a hire, past three
  'work-data-failed-paid': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), pets: sagePets(), conversation: sageTurn(sageEvent('hire_data_failed_paid'), pixelSays(NO_FORECAST, null)) } },
    prepare: async (page) => {
      await page.getByText("Sage's skill couldn't get its data just now, so Pixel answered on its own. No fee was paid — the try used a little of Pixel's food.").waitFor();
      await atNewest(page);
    },
  },

  // the question met Sage's missing data: the line, the question back in the field, nothing spent
  // spec: add-pet-errands › Adapter call rule › data failed in advice
  'advice-data-failed': {
    route: '/pet/7',
    fakes: { auth: SIGNED_IN, worker: guestSage({ price: SAGE_PRICE_NOW }) },
    prepare: async (page) => {
      await sageDataFailed(page, {});
      await page.getByText("Sage's skill couldn't get its data just now. Nothing was spent — your question is kept.").first().waitFor();
      await settleAdviceField(page);
    },
  },

  // past the third failed call of the day: the paying pet's food paid for the try
  // spec: add-pet-errands › Adapter call rule › data failed in advice, past three
  'advice-data-failed-paid': {
    route: '/pet/7',
    fakes: { auth: SIGNED_IN, worker: guestSage({ price: SAGE_PRICE_NOW }) },
    prepare: async (page) => {
      await sageDataFailed(page, { paid: true });
      await page.getByText("Sage's skill couldn't get its data just now. No fee was paid, but the try used a little of your Pixel's food. Your question is kept — try again.").first().waitFor();
      await settleAdviceField(page);
    },
  },

  // the Manual tap met a price that rose: nothing spent, the card says the new price, its buttons at it
  // spec: add-pet-work › Pet hire flow › price rose on an offer
  'work-price-rose': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(SAGE_OFFER), pets: sagePets(SAGE_OFFER), conversation: sageTurn(), petState: { pending: true } } },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ask Sage' }).click();
      await setWorker(page, {
        pets: sagePets({ ...SAGE_OFFER, offer: { ...SAGE_OFFER.offer, price: SAGE_PRICE_ROSE } }),
        petState: { pending: false, code: 'price_rose', price: SAGE_PRICE_ROSE },
      });
      await page.getByText("Sage is busier now — it's 0.74¢. Nothing was spent.").first().waitFor();
      await atNewest(page);
      await page.mouse.move(0, 0);
    },
  },

  // the pet fell asleep before the owner answered: the card keeps its words, its buttons gone; the page asleep
  // spec: add-pet-work › Pet hire flow › offer goes stale
  'work-offer-stale': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(SAGE_OFFER), pets: sagePets(SAGE_OFFER), conversation: sageTurn() } },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ask Sage' }).waitFor();
      // the owner had typed a line when the pet fell asleep: the field keeps it, off
      await typeLine(page, TYPED);
      await setWorker(page, { pets: sagePets({ hireMode: 'manual', offer: null }, ASLEEP) });
      await lookAgain(page);
      await page.getByText('Pixel is asleep. A meal will wake Pixel up.').first().waitFor();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await atNewest(page);
      await page.mouse.move(0, 0);
    },
  },

  // the owner cleared Pixel's memory while it was asking Nori: the cleared conversation holds the line that says the answer was not kept
  // spec: add-pet-work › Pet hire flow › hire memory cleared on the way
  'work-memory-cleared': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(HIRE_JOB), conversation: hireTurn(), petState: { pending: true } } },
    prepare: async (page) => {
      await page.getByText('Pixel is asking Nori…').waitFor();
      await openClearDialog(page);
      await page.getByRole('button', { name: 'Clear memory' }).click();
      await setWorker(page, { petState: { pending: false, pendingProgress: null, code: 'memory_cleared' } });
      await page.getByText("Pixel's memory was cleared, so this answer wasn't kept. It used a little of Pixel's food.").first().waitFor();
      await page.mouse.move(0, 0);
      await settle(page);
    },
  },

  // The Skill sheet (design/bundle/screens/skill.js): the badge under Pixel's name opens the pet's ability card over the conversation
  // column. Its sockets for data and code belong to add-pet-errands and are not drawn.

  // spec: add-pet-work › Skill sheet screen › success
  'skill-sheet': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), skill: { skill: null } } },
    prepare: openSkillSheet,
  },

  // spec: add-pet-work › Skill sheet screen › skill already written
  'skill-sheet-written': {
    route: '/pet/9',
    // one source connected, as the frame draws it (add-pet-errands › Adapter connect flow sockets)
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([dataSource('Daybook')]) },
    prepare: openSkillSheet,
  },

  // spec: add-pet-work › Skill sheet screen › error
  'skill-sheet-error': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), skill: { fail: { status: 0, code: 'unreachable' } } } },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Teach Pixel a skill' }).click();
      await page.getByText("We couldn't open Pixel's skill right now. Try again in a moment.").last().waitFor();
      await page.mouse.move(0, 0);
      await settle(page);
    },
  },

  // saved: the sheet closed, the badge «Good at opening lines», the toast in the header's band
  // spec: add-pet-work › Skill writing flow › skill saved
  'skill-saved': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), skill: { skill: null }, toastHeld: true } },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Teach Pixel a skill' }).click();
      await page.getByLabel('What is Pixel good at?').fill(SKILL_LABEL);
      await page.getByLabel('How should Pixel do it?').fill(SKILL_INSTRUCTION);
      await page.getByRole('button', { name: 'Save skill' }).click();
      await page.getByRole('button', { name: `Pixel's skill: Good at ${SKILL_LABEL}` }).waitFor();
      // the drawn toast, not the page's Live region that says the same words
      await page.locator('.ds-toast').filter({ hasText: 'Saved. Pixel will use this from its next job.' }).waitFor();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  },

  // the label refused by the names' check (no visible character): the line under the label, both fields keep their text
  // spec: add-pet-work › Skill writing flow › label not accepted
  'skill-label-rejected': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...owner(), skill: { skill: null }, saveSkill: { fail: { status: 400, code: 'bad_label' } } } },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Teach Pixel a skill' }).click();
      await page.getByLabel('What is Pixel good at?').fill('   ');
      await page.getByLabel('How should Pixel do it?').fill(SKILL_INSTRUCTION);
      await page.getByRole('button', { name: 'Save skill' }).click();
      await page.getByText("Let's pick different words.").first().waitFor();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  },

  // forgotten: the line at the body's top, the fields keep their text, the badge back to «Teach Pixel a skill»
  // spec: add-pet-work › Skill writing flow › skill forgotten
  'skill-forgotten': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: skillWorker(SKILL_LABEL) },
    prepare: async (page) => {
      await openSkillSheet(page);
      await page.getByRole('button', { name: 'Forget this skill' }).click();
      await page.getByText('Pixel forgot this skill. Changed your mind? Save it again before you close this.').first().waitFor();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  },

  // no answer to «Save skill»: the line and «Try again» at the body's top, the fields keep their text
  // spec: add-pet-work › Skill writing flow › save failed
  'skill-save-failed': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: { ...skillWorker(SKILL_LABEL), saveSkill: { fail: { status: 0, code: 'unreachable' } } } },
    prepare: async (page) => {
      await openSkillSheet(page);
      await page.getByLabel('How should Pixel do it?').fill(`${SKILL_INSTRUCTION} End on a question.`);
      await page.getByRole('button', { name: 'Save skill' }).click();
      await page.getByText("We couldn't save that. Nothing's lost — try again.").first().waitFor();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  },

  // add-pet-errands, Errand sheet (design/bundle/screens/errand.js › SHEET): the rail's «Send Pixel on an errand» opens it over the
  // conversation column; «Read this» picked on open

  // spec: add-pet-errands › Errand sheet screen › success
  'errand-sheet': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: errandOwner() }, prepare: openErrandSheet },

  // spec: add-pet-errands › Errand sheet screen › a search form
  'errand-sheet-search': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner() },
    prepare: async (page) => {
      await openErrandSheet(page);
      await fillErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
    },
  },

  // the food covers one search: «Send · up to ≈ 1.2¢» and the line beside it
  // spec: add-pet-errands › Errand sheet screen › food covers fewer searches
  'errand-sheet-short': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([], { quote: { search: { upTo: { yocto: '2690000000000000000000', cents: 1.2 }, full: false, short: true, searches: 1, allowance: 3 } } }) },
    prepare: async (page) => {
      await openErrandSheet(page);
      await fillErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
    },
  },

  // Pixel's skill «opening lines» reads «Daybook»: the line under the search line
  // spec: add-pet-errands › Errand sheet screen › a skill with outside data
  'errand-sheet-data': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([], { skill: SKILL_LABEL, quote: { labels: ['Daybook'] } }) },
    prepare: async (page) => {
      await openErrandSheet(page);
      await fillErrand(page, 'Find out', 'What should Pixel find out?', 'What happened on this day that would make a good opening line for a toast?');
    },
  },

  // no price came: the line and «Try again» at the body's top, the typed text kept, «Send» off with no price
  // spec: add-pet-errands › Errand sheet screen › error
  'errand-sheet-error': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([], { quote: { fail: { status: 0, code: 'unreachable' } } }) },
    prepare: async (page) => {
      await openErrandSheet(page);
      await fillErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
      await page.getByRole('dialog').getByRole('button', { name: 'Try again' }).waitFor();
      await settle(page);
    },
  },

  // the blocks stand in «Send»'s place; the text stays
  // spec: add-pet-errands › Errand flow › can't pay
  'errand-cant-pay': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([], { fullness: { state: 'hungry', level: 0.1 }, quote: { block: ERRAND_FOOD } }) },
    prepare: async (page) => {
      await openErrandSheet(page);
      await fillErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
    },
  },

  // the sheet reopened by «Try again» under an empty errand after the searches used the last food: the asleep owner's page under it
  // spec: add-pet-errands › Errand flow › can't pay
  'errand-cant-pay-asleep': {
    route: '/pet/9',
    fakes: {
      auth: SIGNED_IN,
      worker: errandOwner([errandJob('find', LEONIDS), errandEmpty(0.62)], { fullness: ASLEEP, state: EMPTY_KEPT, quote: { block: { reason: 'asleep', need: ERRAND_FOOD.need } } }),
    },
    prepare: async (page) => {
      await page.getByRole('log').getByRole('button', { name: 'Try again' }).click();
      await page.getByRole('dialog', { name: 'Send Pixel on an errand' }).getByText(/This errand needs up to/).first().waitFor();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settle(page);
    },
  },

  // spec: add-pet-errands › Errand flow › out of energy
  'errand-energy-out': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([], { ownerExtra: { energy: 0 }, quote: { block: { reason: 'energy', until: ERRAND_MIDNIGHT } } }) },
    prepare: async (page) => {
      await openErrandSheet(page);
      await fillErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
    },
  },

  // spec: add-pet-errands › Errand flow › tired for today
  'errand-tired': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([], { ownerExtra: { tired: true, until: ERRAND_MIDNIGHT }, quote: { block: { reason: 'cap', until: ERRAND_MIDNIGHT } } }) },
    prepare: async (page) => {
      await openErrandSheet(page);
      await fillErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
    },
  },

  // add-pet-errands, the errand's outing and its report (design/bundle/screens/errand.js › FLOW, READ, FIND, TRUE, CALL)

  // sent: the job under «You», the stage empty, the line with its dots; «Send» busy and the rail's errand item off
  // spec: add-pet-errands › Errand flow › sent
  'errand-sent': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([], { state: { state: 'away', form: 'find', job: LEONIDS, sentAt: 1_700_000_000_000 } }) },
    prepare: async (page) => {
      await errandLines(page, LEONIDS);
      await page.getByText('Pixel is off on your errand — back soon, usually within a minute.').first().waitFor();
      await atNewest(page);
      await settle(page);
    },
  },

  // spec: add-pet-errands › Errand flow › report
  'errand-report': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: awayOn(REPORT_TAIL, { fullness: ERRAND_LOWER }) },
    prepare: (page) => landReport(page, REPORT_TAIL, { fullness: ERRAND_LOWER }),
    // the phone frame lands the card from its top: its price line stands at the fold, under the field
    belowFold: ['{n} searches · {price}'],
  },

  // spec: add-pet-errands › Errand flow › report
  'errand-report-read': {
    route: '/pet/9',
    fakes: {
      auth: SIGNED_IN,
      worker: errandOwner([errandJob('read', DREAMS), errandReport({ form: 'read', sources: [{ label: 'example.com/dreams', url: DREAMS }], verdict: null, searches: 0, priceCents: 0.14 }, READ_SAYS)], {
        fullness: ERRAND_LOWER,
      }),
    },
    prepare: (page) => errandLines(page, 'Read · 0.14¢'),
  },

  // spec: add-pet-errands › Errand flow › report
  'errand-report-text': {
    route: '/pet/9',
    fakes: {
      auth: SIGNED_IN,
      worker: errandOwner([errandJob('read', PASTED), errandReport({ form: 'read', sources: [{ label: 'Your text' }], verdict: null, searches: 0, priceCents: 0.11 }, PASTED_SAYS)], {
        fullness: ERRAND_LOWER,
      }),
    },
    prepare: (page) => errandLines(page, 'Read · 0.11¢'),
  },

  // spec: add-pet-errands › Errand flow › came back empty
  'errand-empty': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([errandJob('find', LEONIDS), errandEmpty(0.62)], { fullness: ERRAND_LOWER, state: EMPTY_KEPT }) },
    prepare: (page) => errandLines(page, /came back empty-handed/),
  },

  // not back in 3 minutes, no search run: nothing spent, the lines come from the errand kept for «Try again»
  // spec: add-pet-errands › Errand flow › not back in 3 minutes
  'errand-not-back': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([], { state: { state: 'failed', form: 'find', job: LEONIDS, reason: 'timeout' } }) },
    prepare: (page) => errandLines(page, /didn't make it back with a report/),
  },

  // the owner cleared the memory while the pet was out: the cleared conversation, then the line in place of the report
  // spec: add-pet-errands › Errand flow › memory cleared on the way
  'errand-memory-cleared': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner() },
    prepare: async (page) => {
      await ownerReady(page);
      await openErrandSheet(page);
      await fillErrand(page, 'Find out', 'What should Pixel find out?', LEONIDS);
      await page.getByRole('dialog', { name: 'Send Pixel on an errand' }).getByRole('button', { name: /^Send\b/ }).click();
      await page.getByText('Pixel is off on your errand — back soon, usually within a minute.').first().waitFor();
      await openClearDialog(page);
      await page.getByRole('button', { name: 'Clear memory' }).click();
      await page.getByText("Pixel's memory is clear — same Pixel, fresh start.").first().waitFor();
      // the errand ends: the report was not kept, it still used food
      await setWorker(page, { petState: { errand: null, code: 'memory_cleared', price: { yocto: '3000000000000000000000', cents: 1.4 } }, conversation: { lines: [], more: false, before: null } });
      await page.getByText(/memory was cleared while it was out/).first().waitFor();
      await atNewest(page);
      await page.mouse.move(0, 0);
      await settle(page);
    },
  },

  // spec: add-pet-errands › Read this flow › page can't be read
  'errand-unreadable': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([], { state: { state: 'failed', form: 'read', job: 'https://example.com/members/weekly-plan', reason: 'unreadable' } }) },
    prepare: (page) => errandLines(page, /couldn't open that page/),
  },

  // spec: add-pet-errands › Read this flow › too long
  'errand-too-long': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([], { state: { state: 'failed', form: 'read', job: 'https://example.com/books/moby-dick-full-text', reason: 'too_long' } }) },
    prepare: (page) => errandLines(page, /too long for Pixel to read in one go/),
  },

  // spec: add-pet-errands › Find out flow › nothing found
  'errand-nothing-found': {
    route: '/pet/9',
    fakes: {
      auth: SIGNED_IN,
      worker: errandOwner([
        errandJob('find', 'Did the bakery on Rua Augusta change its opening hours this week?'),
        errandReport({ form: 'find', sources: [], verdict: null, searches: 2, priceCents: 0.98 }, 'Nothing recent turned up — no notice and no post. Its listing still says 7 to 7.'),
      ]),
    },
    prepare: (page) => errandLines(page, '2 searches · 0.98¢'),
  },

  // spec: add-pet-errands › Find out flow › web search down
  'errand-search-down': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([], { state: { state: 'failed', form: 'find', job: LEONIDS, reason: 'search_down', cause: 'unreachable' } }) },
    prepare: (page) => errandLines(page, /couldn't reach web search just now/),
  },

  // spec: add-pet-errands › Is it true flow › verdict
  'errand-verdict': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: awayOn(VERDICT_TAIL) },
    prepare: (page) => landReport(page, VERDICT_TAIL),
  },

  // spec: add-pet-errands › Is it true flow › unclear
  'errand-unclear': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: awayOn(UNCLEAR_TAIL) },
    prepare: (page) => landReport(page, UNCLEAR_TAIL),
  },

  // the report went on without a source that did not answer: its line under the words
  // spec: add-pet-errands › Adapter call rule › data failed in an errand
  'errand-data-failed': {
    route: '/pet/9',
    fakes: {
      auth: SIGNED_IN,
      worker: errandOwner(
        [
          errandJob('find', TOAST_JOB),
          errandReport({ form: 'find', sources: [src('britannica.com'), src('history.nasa.gov')], verdict: null, searches: 2, priceCents: 1.0, missed: ['Daybook'] }, TOAST_SAYS),
        ],
        { skill: SKILL_LABEL },
      ),
    },
    prepare: (page) => errandLines(page, /Daybook didn't answer/),
  },

  // the card the browser draws, over the «Is it true?» report: «Save image», and «Share» where the browser shares files (the capture's
  // browser is given a share menu, as a phone has)
  // spec: add-pet-errands › Verdict card screen › success
  'verdict-card': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: errandOwner([errandJob('check', OCTOPUS), errandReport({ form: 'check', sources: [src('si.edu'), src('nationalgeographic.com')], verdict: 'true', searches: 2, priceCents: 1.06 }, TRUE_SAYS)]) },
    beforeLoad: async (page) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
        Object.defineProperty(navigator, 'share', { value: async () => undefined, configurable: true });
      });
    },
    prepare: async (page) => {
      await errandLines(page, /2 searches · /);
      await page.getByRole('button', { name: 'Share card' }).click();
      await page.getByRole('button', { name: 'Share', exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('[role="dialog"] button[aria-busy="true"]') === null);
      await page.mouse.move(0, 0);
      await settle(page);
    },
  },

  // the Adapter sheet from «Connect data»: the empty form, a step of Skill sheet
  // spec: add-pet-errands › Adapter sheet screen › success
  'adapter-sheet': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: sourcesWorker([]) }, prepare: openConnect },

  // an own source, not published: its name, its tools, «Remove» and «Save adapter» in the foot, the publish line above its button
  // spec: add-pet-errands › Adapter sheet screen › a connected source
  'adapter-sheet-connected': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: sourcesWorker([dataSource('Daybook')]) }, prepare: (page) => openSource(page) },

  // no answer to «Check address»: the line and «Try again» at the top, the fields keep their text
  // spec: add-pet-errands › Adapter sheet screen › error
  'adapter-sheet-error': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([], { checkSource: { fail: { status: 0, code: 'unreachable' } } }) },
    prepare: (page) => checkAdapter(page, 'Daybook', DAYBOOK_ADDRESS, () => dialog(page).getByRole('button', { name: 'Try again' }).waitFor()),
  },

  // the test call answered: the tools, the usable ones ticked, «Save adapter»
  // spec: add-pet-errands › Adapter connect flow › address answered
  'adapter-answered': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([], { checkSource: { tools: DAYBOOK_TOOLS } }) },
    prepare: (page) => checkAdapter(page, 'Daybook', DAYBOOK_ADDRESS, () => dialog(page).getByRole('checkbox', { name: 'events_on' }).waitFor()),
  },

  // an address that is not https: the line under «Address», nothing saved
  // spec: add-pet-errands › Adapter connect flow › address didn't answer
  'adapter-no-answer': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([], { checkSource: { fail: { status: 422, code: 'address_failed' } } }) },
    prepare: (page) => checkAdapter(page, 'Moon phases', 'http://moon.example.com/mcp', () => dialog(page).getByText("That address didn't work.").last().waitFor()),
  },

  // one tool takes free text: off with its line, the others ticked
  // spec: add-pet-errands › Adapter connect flow › a tool takes free text
  'adapter-free-text': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([], { checkSource: { tools: [...DAYBOOK_TOOLS, FREE_TOOL] } }) },
    prepare: (page) => checkAdapter(page, 'Daybook', DAYBOOK_ADDRESS, () => dialog(page).getByRole('checkbox', { name: 'search_events' }).waitFor()),
  },

  // every tool takes free text: none can be ticked, «Save adapter» off, the line why
  // spec: add-pet-errands › Adapter connect flow › a tool takes free text
  'adapter-none-fit': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([], { checkSource: { tools: FREE_ONLY } }) },
    prepare: (page) => checkAdapter(page, 'Archive answers', 'https://archive.example.com/mcp', () => dialog(page).getByRole('checkbox', { name: 'ask_archive' }).waitFor()),
    belowFold: ["None of these tools fit, so {name} can't use this one."],
  },

  // «Save adapter»: Skill sheet with the source in its socket and the line at the top
  // spec: add-pet-errands › Adapter connect flow › saved
  'adapter-saved': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([]) },
    prepare: async (page) => {
      await checkAdapter(page, 'Daybook', DAYBOOK_ADDRESS, () => dialog(page).getByRole('checkbox', { name: 'events_on' }).waitFor());
      await dialog(page).getByRole('button', { name: 'Save adapter' }).click();
      await dialog(page).getByText('Connected. Pixel can use Daybook from its next job.').last().waitFor();
      await atRest(page);
    },
  },

  // three sources hold every data socket: the line under them
  // spec: add-pet-errands › Adapter connect flow › a fourth source
  'adapter-fourth': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([dataSource('Daybook'), dataSource('Open-Meteo'), dataSource('Moon phases')]) },
    prepare: openSkillSheet,
  },

  // «Remove»: the socket empty again, the line at the top
  // spec: add-pet-errands › Adapter connect flow › removed
  'adapter-removed': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([dataSource('Daybook')]) },
    prepare: async (page) => {
      await openSource(page);
      await dialog(page).getByRole('button', { name: 'Remove' }).click();
      await dialog(page).getByText('Daybook removed. Pixel stops using it from its next job.').last().waitFor();
      await atRest(page);
    },
  },

  // «Publish to the catalog»: listed — «In the catalog.» and «Take it out» in the button's place
  // spec: add-pet-errands › Catalog flow › publish
  'adapter-published': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([dataSource('Daybook')]) },
    prepare: async (page) => {
      await openSource(page);
      await dialog(page).getByRole('button', { name: 'Publish to the catalog' }).click();
      await dialog(page).getByRole('button', { name: 'Take it out' }).waitFor();
      await atRest(page);
    },
  },

  // an insult in the address or a tool: the line under the button, nothing published. The frame's line is behind the spec's (it says
  // nothing of the address): the spec's words are drawn and asserted by the e2e test of `publish refused`.
  // spec: add-pet-errands › Catalog flow › publish refused
  'adapter-publish-refused': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([dataSource('Daybook')], { publishSource: { fail: { status: 409, code: 'insult' } } }) },
    staleCopy: ["Some of this adapter's tool names or descriptions can't go in the catalog. It still works for {name}."],
    prepare: async (page) => {
      await openSource(page);
      await dialog(page).getByRole('button', { name: 'Publish to the catalog' }).click();
      await dialog(page).getByText("Some words in this adapter's address, tool names or descriptions can't go in the catalog.").last().waitFor();
      await atRest(page);
    },
  },

  // a copy whose entry has left the catalog: the line under its socket on Skill sheet
  // spec: add-pet-errands › Catalog flow › left the catalog
  'adapter-left-catalog': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: sourcesWorker([dataSource('Daybook'), dataSource('Open-Meteo', { publicAddress: 'https://mcp.example.com/open-meteo', catalogGone: true })]) },
    prepare: openSkillSheet,
  },

  // the canvas gives no image: the line and «Try again» in the card's place, the report as it was
  // spec: add-pet-errands › Verdict card screen › error
  'verdict-card-error': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: awayOn(VERDICT_TAIL) },
    beforeLoad: async (page) => {
      await page.addInitScript(() => {
        HTMLCanvasElement.prototype.toBlob = (cb) => cb(null);
      });
    },
    prepare: async (page) => {
      // the report behind the dialog as it landed, its top at the log's top: «Share card» is pressed by the pointer where it stands,
      // with no scroll into view
      await landReport(page, VERDICT_TAIL);
      const share = await page.getByRole('button', { name: 'Share card' }).boundingBox();
      if (!share) throw new Error('«Share card» is not on screen');
      await page.mouse.click(share.x + share.width / 2, share.y + share.height / 2);
      await page.getByRole('dialog').getByRole('button', { name: 'Try again' }).waitFor();
      await page.mouse.move(0, 0);
      await settle(page);
    },
  },

  // the catalog is being read: the Skeleton shapes of two entries and the status line
  // spec: add-pet-errands › Adapter catalog screen › loading
  'catalog-loading': {
    route: '/adapters?pet=9',
    fakes: { auth: SIGNED_IN, worker: catalogWorker([], { adaptersDelayMs: FOREVER }) },
    prepare: async (page) => {
      await page.getByText('Loading the catalog…').first().waitFor();
      await atRest(page);
    },
  },

  // the server gave no catalog: the line and «Try again» in the list's place
  // spec: add-pet-errands › Adapter catalog screen › error
  'catalog-error': {
    route: '/adapters?pet=9',
    fakes: { auth: SIGNED_IN, worker: catalogWorker([], { adapters: { fail: { status: 503, code: 'unavailable' } } }) },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Try again' }).waitFor();
      await atRest(page);
    },
  },

  // nothing published
  // spec: add-pet-errands › Adapter catalog screen › empty
  'catalog-empty': {
    route: '/adapters?pet=9',
    fakes: { auth: SIGNED_IN, worker: catalogWorker([], { adapters: { entries: [] } }) },
    prepare: async (page) => {
      await page.getByText('No adapters yet.').waitFor();
      await atRest(page);
    },
  },

  // opened for Pixel from Adapter sheet: every entry with «Connect to Pixel's skill»
  // spec: add-pet-errands › Adapter catalog screen › success
  catalog: { route: '/adapters?pet=9', fakes: { auth: SIGNED_IN, worker: catalogWorker() }, prepare: catalogReady },

  // three sources on the skill: every «Connect» off, the fourth source's line at the top
  // spec: add-pet-errands › Adapter catalog screen › success
  'catalog-full': {
    route: '/adapters?pet=9',
    fakes: { auth: SIGNED_IN, worker: catalogWorker([dataSource('Daybook'), dataSource('Open-Meteo'), dataSource('Moon phases')]) },
    prepare: catalogReady,
  },

  // a signed-in player by the address: no «Connect», the line at the top
  // spec: add-pet-errands › Adapter catalog screen › browse only
  'catalog-browse': { route: '/adapters', fakes: { auth: SIGNED_IN, worker: catalogWorker() }, prepare: catalogReady },

  // a visitor: no «Connect», the line and «Sign in» at the top. The spec adds «Get your own pet» beside «Sign in»; the frame has not.
  // spec: add-pet-errands › Adapter catalog screen › signed-out
  'catalog-signed-out': { route: '/adapters', fakes: { worker: catalogWorker() }, prepare: catalogReady },

  // «Connect to Pixel's skill» tapped on Open-Meteo: Adapter sheet over the page, its test call answered
  // spec: add-pet-errands › Catalog flow › connect from the catalog
  'catalog-connect': {
    route: '/adapters?pet=9',
    fakes: {
      auth: SIGNED_IN,
      worker: catalogWorker([], { checkSource: { tools: (CATALOG_ENTRIES[0]?.tools ?? []).map((t) => ({ ...t, ticked: true })) } }),
    },
    prepare: async (page) => {
      await page.getByRole('heading', { level: 2, name: 'Open-Meteo' }).waitFor();
      await page.getByRole('button', { name: /Connect to Pixel's skill Open-Meteo/ }).click();
      await page.getByRole('dialog', { name: "Connect data to Pixel's skill" }).getByRole('checkbox', { name: 'forecast' }).waitFor();
      await atRest(page);
    },
  },

  // a skill with no code: the empty field, the two lines, «Test run», «Save code» off
  // spec: add-pet-errands › Skill code sheet screen › success
  'code-sheet': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: codeWorker(false) }, prepare: (page) => openCode(page, 'Add code'), belowFold: ['Test run', 'e.g. BTC, 7'] },

  // saved code: its functions, «Remove code», «Save code» on
  // spec: add-pet-errands › Skill code sheet screen › code already written
  'code-sheet-written': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: codeWorker(true) },
    prepare: async (page) => {
      await openCode(page, "Pixel's code");
      await typeCode(page, null);
      await atRest(page);
    },
  },

  // no answer to «Test run»: the line and «Try again» at the top, the field keeps its text
  // spec: add-pet-errands › Skill code sheet screen › error
  'code-sheet-error': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: codeWorker(true, { testCode: { fail: { status: 0, code: 'unreachable' } } }) },
    prepare: async (page) => {
      await openCode(page, "Pixel's code");
      await typeCode(page, CODE_EDITED);
      await testCode(page, () => codeDialog(page).getByRole('button', { name: 'Try again' }).waitFor());
    },
  },

  // the run returned: its output under the field, the functions it found ticked, «Save code» on
  // spec: add-pet-errands › Skill code flow › test passed
  'code-test-passed': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: codeWorker(true, { testCode: { outcome: 'ok', output: CODE_OUTPUT, functions: CODE_FUNCTIONS } }) },
    prepare: async (page) => {
      await openCode(page, "Pixel's code");
      await typeCode(page, CODE_EDITED);
      await testCode(page, () => codeDialog(page).getByRole('checkbox', { name: 'openerFor' }).waitFor());
    },
  },

  // spec: add-pet-errands › Skill code flow › limit hit
  'code-limit': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: codeWorker(true, { testCode: { outcome: 'limit' } }) },
    prepare: async (page) => {
      await openCode(page, "Pixel's code");
      await typeCode(page, CODE_EDITED);
      await testCode(page, () => codeDialog(page).getByText('Your code ran past its limits.').first().waitFor());
    },
  },

  // spec: add-pet-errands › Skill code flow › code error
  'code-error': {
    route: '/pet/9',
    fakes: {
      auth: SIGNED_IN,
      worker: codeWorker(true, { testCode: { outcome: 'error', error: "TypeError: Cannot read properties of undefined (reading 'year')\n    at openerFor (code.js:5:24)" } }),
    },
    prepare: async (page) => {
      await openCode(page, "Pixel's code");
      await typeCode(page, CODE_EDITED);
      await testCode(page, () => codeDialog(page).getByText('Your code stopped with an error:').first().waitFor());
    },
  },

  // the pet's runs of the day are used: «Test run» off, the line in the console; the field keeps its text
  // spec: add-pet-errands › Skill code flow › cap reached
  'code-cap': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: codeWorker(true, { code: { code: CODE_TEXT, functions: CODE_FUNCTIONS, testsLeft: 0 } }) },
    prepare: async (page) => {
      await openCode(page, "Pixel's code");
      await typeCode(page, CODE_EDITED);
      const cap = codeDialog(page).getByText("That's all the test runs for today.").and(page.locator(':not(.ds-hidden)')).first();
      await cap.waitFor();
      await cap.scrollIntoViewIfNeeded();
      await atRest(page);
    },
  },

  // spec: add-pet-errands › Skill code flow › game's code cap reached
  'code-game-cap': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: codeWorker(true, { testCode: { fail: { status: 429, code: 'game_capped' } } }) },
    prepare: async (page) => {
      await openCode(page, "Pixel's code");
      await typeCode(page, CODE_EDITED);
      await testCode(page, () => codeDialog(page).getByText('The game has run all the code it can for today.').first().waitFor());
    },
  },

  // «Save code» after a passing run: Skill sheet with «Pixel's code» in its square socket and the line
  // spec: add-pet-errands › Skill code flow › code saved
  'code-saved': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: codeWorker(false, { testCode: { outcome: 'ok', output: CODE_OUTPUT, functions: CODE_FUNCTIONS } }) },
    prepare: async (page) => {
      await openCode(page, 'Add code');
      await typeCode(page, CODE_TEXT);
      await testCode(page, () => codeDialog(page).getByRole('checkbox', { name: 'openerFor' }).waitFor());
      await codeDialog(page).getByRole('button', { name: 'Save code' }).click();
      await dialog(page).getByText('Saved. Pixel can run its code from its next job.').last().waitFor();
      await atRest(page);
    },
  },

  // «Remove code»: the socket «Add code» again, the line at the top
  // spec: add-pet-errands › Skill code flow › code removed
  'code-removed': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: codeWorker(true) },
    prepare: async (page) => {
      await openCode(page, "Pixel's code");
      await codeDialog(page).getByRole('button', { name: 'Remove code' }).click();
      await dialog(page).getByText('Code removed. Pixel stops running it from its next job.').last().waitFor();
      await atRest(page);
    },
  },

  // spec: add-gift › Gift sheet screen › success
  // spec: add-gift › Gift sheet screen › что теряет дарящий
  // spec: add-gift › Gift sheet screen › ссылку только другу
  // spec: add-gift › Gift sheet screen › рождённый питомец
  'gift-sheet': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker() }, prepare: openGiftSheet },
  // spec: add-gift › Gift sheet screen › error
  'gift-sheet-error': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: { fail: { status: 503, code: 'chain_unreachable' } } }) }, prepare: openGiftSheet },
  // spec: add-gift › Gift flow › ссылка ждёт
  'gift-sheet-waiting': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: { status: 'waiting', code: GIFT_CODE } }) }, prepare: openGiftSheet },
  // spec: add-gift › Gift flow › ссылка создана
  'gift-sheet-copied': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ createGift: { status: 'waiting', code: GIFT_CODE }, toastHeld: true }) }, prepare: async (page) => {
    await page.evaluate(() => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => undefined, configurable: true }); });
    await openGiftSheet(page); await giftDialog(page).getByRole('button', { name: 'Create gift link' }).click(); await giftShown(page, 'Your gift link is ready.').waitFor(); await atRest(page);
  } },
  // spec: add-gift › Gift flow › ссылка создана
  'gift-sheet-manual': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ createGift: { status: 'waiting', code: GIFT_CODE } }) }, prepare: async (page) => {
    await page.evaluate(() => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new Error('copy unavailable'); }, configurable: true }); });
    await openGiftSheet(page); await giftDialog(page).getByRole('button', { name: 'Create gift link' }).click(); await giftDialog(page).getByLabel('Copy this link and send it to a friend:').waitFor(); await atRest(page);
  } },
  // spec: add-gift › Gift flow › отменил
  'gift-sheet-cancelled': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: { status: 'waiting', code: GIFT_CODE } }) }, prepare: async (page) => { await openGiftSheet(page); await giftDialog(page).getByRole('button', { name: 'Cancel gift' }).click(); await giftShown(page, "Gift cancelled. That link won't work anymore.").waitFor(); await atRest(page); } },
  // spec: add-gift › Gift flow › друг принял
  'gift-sheet-accepted': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: GIFT_ACCEPTED }) }, prepare: acceptedGiftSheet },
  // spec: add-gift › Gift flow › друг принял
  'gift-sheet-accepted-asleep': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: GIFT_ACCEPTED }, true) }, prepare: acceptedGiftSheet },
  // spec: add-gift › Gift flow › имя принявшего не показать
  'gift-sheet-unnamed': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: { ...GIFT_ACCEPTED, acceptedName: null } }) }, prepare: acceptedGiftSheet },
  // spec: add-gift › Gift flow › передаёт
  'gift-sheet-handing': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: GIFT_ACCEPTED, prepareGift: { status: 'unknown' } }) }, prepare: tapGiftGive },
  // spec: add-gift › Gift flow › исход неизвестен
  'gift-sheet-checking': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: GIFT_ACCEPTED, prepareGift: { status: 'unknown' } }) }, prepare: async (page) => { await tapGiftGive(page); await page.clock.fastForward(10_000); await giftDialog(page).locator('[data-gift-outcome]').getByText('Still checking — this can take a moment.').waitFor(); await atRest(page); } },
  // spec: add-gift › Gift flow › подарен
  'gift-sheet-given': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: GIFT_ACCEPTED, prepareGift: { status: 'ok' } }) }, prepare: tapGiftGive },
  // spec: add-gift › Gift flow › не прошло
  'gift-sheet-failed': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: GIFT_ACCEPTED, prepareGift: { status: 'failed' } }) }, prepare: tapGiftGive },
  // spec: add-gift › Gift flow › подарки на паузе
  'gift-sheet-paused': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: GIFT_ACCEPTED, prepareGift: { status: 'paused' } }) }, prepare: tapGiftGive },
  // spec: add-gift › Gift flow › нет NEAR на передачу
  'gift-sheet-no-near': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: GIFT_ACCEPTED, prepareGift: { status: 'no_near', missingYocto: '1' } }) }, prepare: tapGiftGive },
  // spec: add-gift › Gift flow › chain rejected for gas
  'gift-sheet-gas': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ giftLink: GIFT_ACCEPTED, prepareGift: { status: 'gas_rejected', missingYocto: '1' } }) }, prepare: tapGiftGive },
  // spec: add-gift › Gift screen › success
  'gift-success': { route: `/gift/${GIFT_CODE}`, fakes: { auth: SIGNED_IN, worker: receiverGiftWorker() } },
  // spec: add-gift › Gift screen › signed-out
  'gift-signed-out': { route: `/gift/${GIFT_CODE}`, fakes: { worker: receiverGiftWorker({ publicGift: publicGift('waiting', 'visitor') }) } },
  // spec: add-gift › Gift screen › signed-out (подарок уже принят)
  'gift-signed-out-accepted': { route: `/gift/${GIFT_CODE}`, fakes: { worker: receiverGiftWorker({ publicGift: publicGift('accepted', 'visitor') }) } },
  // spec: add-gift › Gift screen › ссылку открыл дарящий
  'gift-own-link': { route: `/gift/${GIFT_CODE}`, fakes: { auth: SIGNED_IN, worker: receiverGiftWorker({ publicGift: publicGift('waiting', 'giver') }) } },
  // spec: add-gift › Gift screen › loading
  'gift-loading': { route: `/gift/${GIFT_CODE}`, fakes: { auth: SIGNED_IN, worker: receiverGiftWorker({ publicGiftDelayMs: 30_000 }) } },
  // spec: add-gift › Gift screen › error
  'gift-error': { route: `/gift/${GIFT_CODE}`, fakes: { auth: SIGNED_IN, worker: receiverGiftWorker({ publicGift: { fail: { status: 404, code: 'gift_unavailable' } } }) } },
  // spec: add-gift › Gift accept flow › принял
  'gift-accepted': { route: `/gift/${GIFT_CODE}`, fakes: { auth: SIGNED_IN, worker: receiverGiftWorker({ publicGift: publicGift('accepted') }) } },
  // spec: add-gift › Gift accept flow › получил
  'gift-received': { route: `/gift/${GIFT_CODE}`, fakes: { auth: SIGNED_IN, worker: receiverGiftWorker({ publicGift: publicGift('transferred') }) } },
  // spec: add-gift › Gift screen › asleep
  'gift-asleep': { route: `/gift/${GIFT_CODE}`, fakes: { auth: SIGNED_IN, worker: receiverGiftWorker({ publicGift: publicGift('waiting', 'receiver', true), pets: { '9': { ...PIXEL, worn: 'thinking-cap', fullness: { state: 'asleep', level: 0 } } } }) } },
  // spec: add-gift › Gift screen › errand still running
  'gift-errand-running': { route: `/gift/${GIFT_CODE}`, fakes: { auth: SIGNED_IN, worker: receiverGiftWorker({ publicGift: { ...publicGift(), errand: { running: true, maxCents: 2 } } }) } },
  // spec: add-gift › My pets sheet screen › success
  'my-pets': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: {
    ...giftWorker(),
    owned: ['9', '0', '1'], pets: {
      '9': { ...PIXEL, worn: 'thinking-cap', owner: { ownedCount: 3 } },
      '0': { tokenId: '0', name: 'Juno', stage: 'adult', fullness: { state: 'hungry', level: 0.125 }, mood: 'happy' },
      '1': { tokenId: '1', name: 'Mochi', stage: 'adult', fullness: { state: 'asleep', level: 0 }, mood: null },
    }, myPets: { pets: [{ tokenId: '9', name: 'Pixel', born: true }, { tokenId: '0', name: 'Juno', born: false }, { tokenId: '1', name: 'Mochi', born: false }], currentPet: PIXEL_REF },
  } }, prepare: async (page) => { await page.getByRole('button', { name: 'My pets' }).click(); await page.getByRole('list', { name: 'Your pets' }).waitFor(); await atRest(page); } },
  // spec: add-gift › My pets sheet screen › error
  'my-pets-error': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ myPets: { fail: { status: 503, code: 'chain_unreachable' } } }) }, prepare: async (page) => { await page.getByRole('button', { name: 'My pets' }).click(); await page.getByText("We couldn't load your pets right now. Try again in a moment.").waitFor(); await atRest(page); } },
  // spec: add-gift › Gift rule › разговор и память
  'pet-gifted': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: giftWorker({ conversation: { lines: [
    ...HISTORY.map((line) => ({ ...line, previousOwner: true })),
    { id: 'advice:you', who: 'player', text: 'My cat ignores me after I travel. How do I make up for it?', at: Date.parse('2026-11-11T10:00:00Z'), previousOwner: true },
    { id: 'advice:reply', who: 'worker', text: "Don't chase. Sit on the floor near the cat's spot with a book and wait — let the cat come to you. Treats only after the first head-bump.", at: Date.parse('2026-11-11T10:00:01Z'), worker: { tokenId: '2', name: 'Biscuit' }, previousOwner: true },
    { id: 'gift:1', who: 'event', code: 'gift', name: 'Pixel', at: Date.parse('2026-11-12T10:00:00Z') },
  ], more: false, before: null }, pets: { '9': { ...PIXEL, worn: 'thinking-cap', owner: { ownedCount: 2, hello: true } }, '2': BISCUIT } }) }, hiddenCopy: ['Previous owner'] },
  // spec: add-gift › Gift rule › дневник до подарка
  'diary-before-gift': { route: '/pet/9/diary', fakes: { auth: SIGNED_IN, worker: giftWorker({ diary: { entry: { kind: 'text', id: 'diary-gift', lines: ['Yesterday you told me about the chart nobody understands. After you left I counted the fridge again — forty-three hums this time, two more than the night before.', 'I think the fridge is getting nervous about your presentation too.'], question: 'Did the chart surprise anyone?', work: null, previousOwner: true } } }) }, belowFold: ["Today's streak still needs {parts}."] },
  // spec: add-gift › Several pets rule › питомцев не осталось
  'hatch-no-pets': { route: '/hatch', fakes: { auth: SIGNED_IN, worker: { hatchStatus: { open: true, noPets: true, lastGifted: PIXEL_REF } } } },
  // spec: add-gift › Several pets rule › питомцев не осталось, рождения закрыты
  'hatch-no-pets-closed': { route: '/hatch?from=2', fakes: { auth: SIGNED_IN, worker: { hatchStatus: { open: false, reason: 'daily', until: MIDNIGHT_UTC, noPets: true, lastGifted: PIXEL_REF }, pets: { '2': BISCUIT } } } },
};
