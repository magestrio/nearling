import type { Page } from '@playwright/test';
import type { FakeState, FakeWorkerState } from '../../src/seams/fakes';
import type { FeedSheetData, Fullness, SheetPortion } from '../../src/seams/worker-types';
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

/** Pixel with its owner, who has two pets (the frames show «My pets»), and the history; `extra` — more of the owner's
 *  fields (tired, paused…), `fullness` — the pet's food */
function owner(extra: Record<string, unknown> = {}, fullness: Fullness = PIXEL.fullness): FakeWorkerState {
  return {
    owned: ['9'],
    pets: { '9': { ...PIXEL, fullness, owner: { ownedCount: 2, ...extra } }, '2': BISCUIT },
    conversation: { lines: HISTORY, more: false, before: null },
  };
}

/** The parts of the owner's frames that other changes build: the hiring mode */
const OWNER_ELSEWHERE = [
  { line: 'Hiring: Auto — {name} asks pets it knows when they can help, then tells you what it cost.', change: 'add-pet-work' },
  { line: 'Auto', change: 'add-pet-work' },
  { line: 'Ask me first', change: 'add-pet-work' },
];

/** The line of the frame `advice-resting`: the advice column that says it is `add-pet-work`'s (Advice flow), not built yet */
const RESTING_LINE = { line: '{name} is resting until {time}. Nothing was spent — ask again after that.', change: 'add-pet-work' };

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

  // Biscuit at rest, its energy spent, seen by a player with a pet of their own: the page stands as the guest's; the question's
  // field and the pet's resting line are the advice column of `add-pet-work`, built after this change: the frame moves there
  // (the user, 2026-10-31) and this fixture stays until its `req` moves in the manifest. No anchor: this capture can't fail
  // on the Scenario's THEN, the worker test of `spendEnergy` holds it
  'advice-resting': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: { me: ME_PIXEL } },
    prepare: (page) => page.getByRole('link', { name: 'Go to your Pixel' }).waitFor(),
    otherChange: [...GUEST_ELSEWHERE, RESTING_LINE],
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
        pets: { '9': { ...PIXEL, stage: 'baby', owner: { hello: true } } },
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
        pets: { '9': { ...PIXEL, stage: 'baby', fullness: { state: 'hungry', level: 11 / 12 }, owner: { hello: true } }, '2': BISCUIT },
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
};
