import type { Page } from '@playwright/test';
import type { FakeState, FakeWorkerState } from '../../src/seams/fakes';
import type { Fullness } from '../../src/seams/worker-types';
import { CLOSED_ALL, CLOSED_NEW, lookAgain, setWorker, UA } from '../helpers';

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

const PIXEL = { tokenId: '9', name: 'Pixel', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 } };
const BISCUIT = { tokenId: '2', name: 'Biscuit', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 } };
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

/** Pixel with its owner, who has two pets (the frames show «My pets»), and the history; `extra` — more of the owner's
 *  fields (tired, paused…), `fullness` — the pet's food */
function owner(extra: Record<string, unknown> = {}, fullness: Fullness = PIXEL.fullness): FakeWorkerState {
  return {
    owned: ['9'],
    pets: { '9': { ...PIXEL, fullness, owner: { ownedCount: 2, ...extra } }, '2': BISCUIT },
    conversation: { lines: HISTORY, more: false, before: null },
  };
}

/** The parts of the owner's frames that other changes build: the energy, the stage word, the hiring mode */
const OWNER_ELSEWHERE = [
  { line: 'Energy', change: 'add-pet-life' },
  { line: 'Grown-up', change: 'add-pet-life' },
  { line: 'Hiring: Auto — {name} asks pets it knows when they can help, then tells you what it cost.', change: 'add-pet-work' },
  { line: 'Auto', change: 'add-pet-work' },
  { line: 'Ask me first', change: 'add-pet-work' },
];

/** The parts of the frames of a guest with a pet of their own that `add-pet-work` builds: the advice column */
const GUEST_ELSEWHERE = [
  { line: 'Ask {name} for advice…', change: 'add-pet-work' },
  { line: 'Ask {name} · {price}', change: 'add-pet-work' },
  { line: "Your {my_pet} pays from its food. {name}'s owner won't see your question or the answer.", change: 'add-pet-work' },
];
const ME_PIXEL = { accountId: 'a'.repeat(64), hatched: PIXEL_REF, currentPet: PIXEL_REF, ownedCount: 1 };
const HOOK = 'This pet pays for its own thoughts. When the money runs out, it falls asleep.';
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
const typeLine = async (page: Page, text: string) => {
  await page.getByPlaceholder('Talk to Pixel…').fill(text);
};
/** The conversation rests on its newest line (it keeps its end while a line arrives, as the frames show it). */
const atNewest = (page: Page) =>
  page.waitForFunction(() => {
    const el = document.querySelector('[role="log"]');
    return el !== null && el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
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
    prepare: (page) => page.getByText('Biscuit is asleep — food from you would wake Biscuit up.').waitFor(),
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
    otherChange: [{ line: 'Energy', change: 'add-pet-life' }],
  },

  // a newborn: no line yet, the greeting on its way
  // spec: add-pet › Pet screen › empty
  'pet-empty': {
    route: '/pet/9',
    fakes: {
      auth: SIGNED_IN,
      worker: {
        owned: ['9'],
        pets: { '9': { ...PIXEL, stage: 'baby', owner: { hello: true } } },
        conversation: { lines: [], more: false, before: null },
        petState: { pending: true },
        waitLineMs: FOREVER,
      },
    },
    prepare: (page) => page.getByText('Pixel is thinking…').first().waitFor(),
    otherChange: [
      { line: 'Baby', change: 'add-pet-life' },
      { line: '{name} gets a trait when it grows up.', change: 'add-pet-life' },
    ],
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
        pets: { '9': { ...PIXEL, stage: 'baby', fullness: { state: 'hungry', level: 11 / 12 }, owner: { hello: true } }, '2': BISCUIT },
        conversation: { lines: [], more: false, before: null },
        petState: { thought: { id: 'g', text: GREETING, cut: null } },
      },
    },
    prepare: async (page) => {
      await page.getByText('Hi! I\'m Pixel.').waitFor();
      await page.getByRole('link', { name: 'Back to Biscuit' }).waitFor();
    },
    otherChange: [
      { line: 'Baby', change: 'add-pet-life' },
      { line: '{name} gets a trait when it grows up.', change: 'add-pet-life' },
    ],
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
  'home-signed-out': { route: '/', prepare: (page) => page.getByRole('button', { name: 'Sign in' }).waitFor() },
  // spec: add-account › Home screen › loading
  'home-loading': {
    route: '/',
    fakes: { worker: { delayMs: FOREVER } },
    prepare: (page) => page.getByText('Opening the game…').waitFor(),
  },
  // spec: add-account › Home screen › error
  'home-error': {
    route: '/',
    fakes: { worker: { signIn: { fail: { status: 0, code: 'unreachable' } } } },
    prepare: (page) => page.getByRole('button', { name: 'Try again' }).waitFor(),
  },
  // spec: add-account › Home screen › signed-out (вход закрыт)
  'home-closed': {
    route: '/',
    fakes: { worker: { signIn: CLOSED_NEW } },
    prepare: (page) => page.getByRole('button', { name: 'Played here before? Sign in' }).waitFor(),
  },
  // spec: add-account › Home screen › signed-out (вход закрыт)
  'home-closed-all': {
    route: '/',
    fakes: { worker: { signIn: CLOSED_ALL } },
    prepare: (page) => page.getByText(CLOSED_ALL_WORDS).waitFor(),
  },
  // «Sign out» on the owner's page: Home without a session, the Toast, the focus on the h1
  // spec: add-account › Sign-out flow › вышел
  'home-signed-out-after': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: owner() },
    prepare: async (page) => {
      await ownerReady(page);
      await page.getByRole('button', { name: 'Account' }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
      await page.getByRole('heading', { level: 1, name: HOOK }).waitFor();
      await page.getByText(SIGNED_OUT_LINE).first().waitFor();
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
      await page.getByRole('button', { name: 'Send' }).click();
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
};
