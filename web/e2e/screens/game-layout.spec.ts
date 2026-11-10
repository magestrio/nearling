import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { viewportsOf } from './copy';
import { FRAMES_DIR, captureFrame, readManifestFrames, writeComposite } from './harness';
import { FRAME_HISTORY, type ScreenFixture } from './fixtures';
import type { FakeWorkerState } from '../../src/seams/fakes';
import type { WishTarget } from '../../src/seams/worker-types';
import { ASLEEP_PIXEL, BISCUIT, lookAgain, PIXEL, setWorker, SIGNED_IN, WARDROBE_OWNS } from '../helpers';

// The frames of add-game-layout that no earlier change's fixtures reach: Pixel's card, the More menu and the folded Hatch
// notices (design/bundle/manifest.json › req `add-game-layout › …`). Pixel is drawn bare, as pet.js › OWN does since DS 0.48.
const wish = { item: 'smart-glasses' as const, reason: 'I want to see every tiny detail.', status: 'active' as const,
  reserveYocto: '660000000000000000000' };
type Patch = { wish?: WishTarget | null; wishActive?: boolean; wishReserveYocto?: string };
const ownerOf = (patch: Patch) => ({ ownedCount: 2, outfits: WARDROBE_OWNS, wish, wishActive: true,
  wishReserveYocto: wish.reserveYocto, ...patch });
const worker = (patch: Patch = {}, pet: { fullness?: typeof ASLEEP_PIXEL.fullness } = {}): FakeWorkerState => ({
  owned: ['9'], pets: { '9': { ...PIXEL, worn: null, ...pet, owner: ownerOf(patch) }, '2': BISCUIT },
  wish: { wish: patch.wish === undefined ? wish : patch.wish, reserveYocto: patch.wishReserveYocto ?? wish.reserveYocto, active: patch.wishActive ?? true, releaseStatus: null },
  conversation: { lines: FRAME_HISTORY, more: false, before: null } });
const noWish: Patch = { wish: null, wishActive: false, wishReserveYocto: '0' };
const asleep = { fullness: ASLEEP_PIXEL.fullness };

const ready = (page: Page) => page.getByText('Start with the chart, then.').first().waitFor();
const openCard = async (page: Page) => {
  await ready(page);
  await page.locator('.ds-hud__nameplate').click();
  await page.getByRole('dialog', { name: "Pixel's card" }).waitFor();
  await page.mouse.move(0, 0);
};
/** The food ran out under the open page, as the frames show it: the typed line stays in the field, the line says why. */
const fallAsleep = async (page: Page) => {
  await ready(page);
  await page.getByPlaceholder('Talk to Pixel…').fill('And if they ask why the chart matters?');
  // a pet with no wish: with one the line under the field is the Will's «Feed {name} to wake them.»
  await setWorker(page, { pets: { '9': { ...PIXEL, worn: null, ...asleep, owner: ownerOf(noWish) }, '2': BISCUIT }, petState: { events: ['fell_asleep'] } });
  await lookAgain(page);
  await page.getByText('Pixel is asleep. A meal will wake Pixel up.').first().waitFor();
  await page.getByText('Pixel fell asleep.').first().waitFor();
  await setWorker(page, { petState: {} });
  await page.getByPlaceholder('Talk to Pixel…').blur();
};
const openMore = async (page: Page) => {
  // by the keyboard, as the frame shows it: the focus ring stands on the menu's first item
  await page.getByRole('button', { name: 'More' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menu', { name: 'More' }).waitFor();
  await page.mouse.move(0, 0);
};
/** The pet changes owner under the open surface; the next read of it says so. */
const transferAway = async (page: Page) => {
  await setWorker(page, { owned: [] });
  await lookAgain(page);
};
const FORMER = 'Pixel has a new owner. You can still visit Pixel.';
// The frames hold the card at its top (data-scroll top): its Work section ends the frame's fold, and what follows it —
// Friends, Wish, the rest of Work — is below it, in the card's own scroll, on the page and on the frame's copy alike.
const CARD_BELOW = ['Friends', 'Wish', 'Relationships', "{name}'s wish", 'Auto', 'Ask me first', 'Teach {name} a skill', 'Review experience',
  'View work record', '{name} wants {outfit}', 'Saved {saved_cents} of {price_cents}', '{saved_near} of {price_near} NEAR', 'No wish yet for {name}.', 'Feed {name}'];
const cardOf = (state: ReturnType<typeof worker>): ScreenFixture =>
  ({ route: '/pet/9', fakes: { auth: SIGNED_IN, worker: state }, prepare: openCard, belowFold: CARD_BELOW });

// The Hatch frames hold the page at its top: the tall expanded notice pushes the consent button and the exit below the fold.
const HATCH_BELOW = ['Hatch my pet', 'Find a pet to ask', 'Read what goes to NEAR AI', "A thought's receipt shows how long the reply was and whether your pet thought hard — never what was said.",
  "Saved food and a bought outfit are public on NEAR forever. The wish's words stay private.",
  "Your words and your pet's memories about you and friends who feed it go to NEAR AI.",
  "To write your pet's replies, we send NEAR AI what you say and what your pet remembers about you and the friends who feed it. When your pet asks another pet for help, the question it writes goes to that pet too."];
const noticeOf = (open: Array<'public' | 'ai'>) => async (page: Page) => {
  await page.getByLabel('Name your pet').fill('Pixel');
  if (open.includes('public')) await page.getByRole('button', { name: "Read what's public" }).click();
  if (open.includes('ai')) await page.getByRole('button', { name: 'Read what goes to NEAR AI' }).click();
  await page.getByLabel('Name your pet').blur();
  // the frames hold the form at its top (data-scroll top); the taps on the controls scrolled the phone's form
  await page.evaluate(() => document.querySelectorAll('*').forEach((el) => { if (el.scrollTop > 0) el.scrollTop = 0; }));
};

const fixtures: Record<string, ScreenFixture> = {
  // spec: add-game-layout › Pet card screen › success (owner)
  'pet-card-owner': cardOf(worker()),
  // spec: add-game-layout › Pet card screen › success (Seal)
  'pet-card-seal': cardOf(worker()),
  // spec: add-game-layout › Pet card screen › success (Work)
  'pet-card-work': cardOf(worker()),
  // spec: add-game-layout › Pet card screen › success (Friends)
  'pet-card-friends': cardOf(worker()),
  // spec: add-game-layout › Pet card screen › success (Wish)
  'pet-card-wish': cardOf(worker()),
  // spec: add-game-layout › Pet card screen › success (before first wish)
  'pet-card-no-wish': cardOf(worker(noWish)),
  // spec: add-game-layout › Pet card screen › success (asleep owner)
  'pet-card-asleep': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: worker() }, belowFold: CARD_BELOW,
    prepare: async (page) => { await fallAsleep(page); await openCard(page); } },
  // spec: add-game-layout › Pet card screen › success (guest)
  'pet-card-guest': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': { ...BISCUIT, skill: { label: 'weather' } } },
      me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 } } },
    prepare: async (page) => {
      await page.getByRole('link', { name: 'Go to your Pixel' }).waitFor();
      await page.locator('.ds-hud__nameplate').click();
      await page.getByRole('dialog', { name: "Biscuit's card" }).waitFor();
      await page.mouse.move(0, 0);
    },
  },
  // spec: add-game-layout › Pet card screen › error
  'pet-card-error': {
    route: '/pet/9', fakes: { auth: SIGNED_IN, worker: worker() },
    prepare: async (page) => {
      await ready(page);
      await setWorker(page, { petResult: { fail: { status: 503, code: 'chain_unreachable' } } });
      await page.locator('.ds-hud__nameplate').click();
      await page.getByText("Couldn't open Pixel's card. Try again.").waitFor();
      await page.mouse.move(0, 0);
    },
  },
  // spec: add-game-layout › Pet card screen › error (owner changed)
  'pet-card-owner-changed': {
    route: '/pet/9', fakes: { auth: SIGNED_IN, worker: worker() },
    prepare: async (page) => {
      // the transfer lands while the former owner's card is open, as the Scenario says; the card's portrait has drawn first,
      // since a pet that unmounts before it draws leaves the capture's wait for the pets unanswered
      await openCard(page);
      await page.evaluate(() => (globalThis as { __nearlingFreeze?: () => Promise<void> }).__nearlingFreeze?.());
      await transferAway(page);
      await page.getByText(FORMER).first().waitFor();
      await page.getByRole('dialog', { name: "Pixel's card" }).waitFor({ state: 'detached' });
      await page.mouse.move(0, 0);
    },
  },
  // spec: add-game-layout › Pet actions menu screen › success (awake owner)
  'pet-more': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: worker() }, prepare: async (page) => { await ready(page); await openMore(page); } },
  // spec: add-game-layout › Pet actions menu screen › success (asleep owner)
  'pet-more-asleep': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: worker() }, prepare: async (page) => { await fallAsleep(page); await openMore(page); } },
  // spec: add-game-layout › Pet actions menu screen › success (sharing choices)
  'pet-more-sharing': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: worker() }, prepare: async (page) => {
    await ready(page);
    await openMore(page);
    // by the keyboard too: a click would leave the first item without its focus ring
    await page.getByRole('menuitem', { name: 'Share Pixel' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Share a thought' }).waitFor();
    await page.mouse.move(0, 0);
  } },
  // spec: add-game-layout › Pet actions menu screen › error
  'pet-more-owner-changed': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: worker() }, prepare: async (page) => {
    await ready(page);
    await openMore(page);
    await transferAway(page);
    await page.getByText(FORMER).first().waitFor();
    await page.mouse.move(0, 0);
  } },
  // spec: add-game-layout › Hatch notice rule › notice expanded
  'hatch-public-notice-expanded': { route: '/hatch', fakes: { auth: SIGNED_IN }, prepare: noticeOf(['public']), belowFold: HATCH_BELOW },
  // spec: add-game-layout › Hatch notice rule › notice expanded
  'hatch-ai-notice-expanded': { route: '/hatch', fakes: { auth: SIGNED_IN }, prepare: noticeOf(['ai']), belowFold: HATCH_BELOW },
  // spec: add-game-layout › Hatch notice rule › notice expanded
  'hatch-both-notices-expanded': { route: '/hatch', fakes: { auth: SIGNED_IN }, prepare: noticeOf(['public', 'ai']), belowFold: HATCH_BELOW },
};

for (const frame of readManifestFrames().filter((f) => f.id in fixtures)) {
  const fixture = fixtures[frame.id]!;
  for (const viewport of viewportsOf(frame)) {
    test(`${frame.id} · ${viewport}`, async ({ page, context }) => {
      const capture = await captureFrame(page, frame, viewport, fixture);
      if (fs.existsSync(path.join(FRAMES_DIR, `${frame.id}.${viewport}.png`))) await writeComposite(context, frame, viewport, capture);
      expect(fs.existsSync(capture)).toBe(true);
    });
  }
}
