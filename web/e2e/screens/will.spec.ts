import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { viewportsOf } from './copy';
import { FRAMES_DIR, captureFrame, readManifestFrames, writeComposite } from './harness';
import type { ScreenFixture } from './fixtures';
import { ASLEEP_PIXEL, BISCUIT, lookAgain, OWNER, PIXEL, setPixel, setWorker, SIGNED_IN, WARDROBE_OWNS } from '../helpers';
import { verificationFakes } from '../verification.fixtures';
import { sampleDiary } from '../../src/seams/diary.sample';
import type { WishTarget } from '../../src/seams/worker-types';

const wish = { item: 'smart-glasses' as const, reason: 'I want to see every tiny detail.', status: 'active' as const,
  reserveYocto: '660000000000000000000' };
const history = [
  { id: 'will-c1', who: 'pet' as const, text: 'Morning! I spent the night counting the hum of your fridge. Forty-one. Did you sleep?', at: 1 },
  { id: 'will-c2', who: 'player' as const, text: 'Barely. Big presentation at ten.', at: 2 },
  { id: 'will-c3', who: 'pet' as const, text: "Then here's the plan: one deep breath, one sip of water, and you tell me what the first slide says.", at: 3 },
  { id: 'will-c4', who: 'player' as const, text: "It's the chart nobody understands.", at: 4 },
  { id: 'will-c5', who: 'pet' as const, text: 'Start with the chart, then. Say what surprised you about it — people follow a surprise better than a number.', at: 5 },
];
const owns = [...WARDROBE_OWNS];
// Pixel bare, as pet.js › OWN draws it since DS 0.48
const owner = { ownedCount: 2, wish, wishActive: true, wishReserveYocto: wish.reserveYocto, outfits: owns, worn: null };
const pixel = (patch: Record<string, unknown> = {}) => ({ ...PIXEL, worn: null, owner: { ...owner, ...patch } });
const worker = (patch: Record<string, unknown> & { wish?: WishTarget | null; wishReserveYocto?: string; wishActive?: boolean } = {}) => ({ ...OWNER, pets: { '9': pixel(patch), '2': OWNER.pets['2'] },
  wish: { wish: patch.wish === undefined ? wish : patch.wish, reserveYocto: patch.wishReserveYocto ?? wish.reserveYocto,
    active: patch.wishActive ?? true, releaseStatus: null },
  conversation: { lines: history, more: false, before: null } });
const signed = (patch: Record<string, unknown> = {}): ScreenFixture => ({ route: '/pet/9', fakes: { auth: SIGNED_IN, worker: worker(patch) } });
const invitation = (id: string, workerId: string, name: string, createdAt: number, label: string | null = null) =>
  ({ id, workerId, name, label, price: { cents: name === 'Sage' ? 0.56 : 0.38, yocto: '830000000000000000000' },
    createdAt, expiresAt: Date.UTC(2099, 0, 1) });
const noWish = { wish: null, wishActive: false, wishReserveYocto: '0' };
const inviteOne = invitation('a'.repeat(24), '2', 'Biscuit', 1);
const inviteMany = [invitation('c'.repeat(24), '5', 'Sage', 3, 'Good at weather'),
  invitation('b'.repeat(24), '3', 'Nori', 2), inviteOne];
const adviceQuestion = 'My cat ignores me after I travel. How do I make up for it?';
const adviceFrame = (code: 'character_refused' | 'screening_failed' | 'screening_exhausted' | 'screening_capacity', expected: string, belowFold?: string[]): ScreenFixture => ({
  route: '/pet/2', fakes: { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT },
    me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 },
    advice: { price: { cents: 0.38, yocto: '830000000000000000000' } },
    petState: { code, jobKind: 'advice', characterRefusal: code === 'character_refused'
      ? { id: 'f'.repeat(24), reason: 'I would rather sit this one out.' } : undefined } } },
  prepare: async (page) => {
    await page.getByPlaceholder('Ask Biscuit for advice…').fill(adviceQuestion);
    await page.getByRole('button', { name: 'Ask Biscuit · 0.38¢' }).click();
    await page.getByText(expected, { exact: false }).first().waitFor();
    if (code === 'screening_exhausted' || code === 'screening_capacity') {
      // the Worker's read after a closed day says so (useAdvice › load): the field stays off, as the frame draws it
      await setWorker(page, { advice: { price: { cents: 0.38, yocto: '830000000000000000000' },
        screeningAvailable: false, screeningResetAt: '2099-01-01T00:00:00.000Z' } });
      await lookAgain(page);
      await expect(page.getByRole('button', { name: 'Ask Biscuit · 0.38¢' })).toHaveClass(/ds-button--off/);
    }
    // the frames show the field at rest, with no ring from the typing
    // The client returns focus to the field after the answer arrives; blur until it stays at rest.
    await expect.poll(() => page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      return document.activeElement === document.body;
    })).toBe(true);
  },
  belowFold,
});
const hireLines = [
  ...history,
  { id: 'will-ask', who: 'player' as const, text: 'And if they ask why the chart matters?', at: 4 },
  { id: 'will-question', who: 'pet' as const, text: 'How do you make a room care about a chart in one sentence?', hireTo: 'Nori', at: 5 },
  { id: 'will-refused', who: 'event' as const, code: 'character_refused' as const, worker: { tokenId: '5', name: 'Nori' },
    hireMode: 'manual' as const, refusal: { id: 'f'.repeat(24), reason: 'I would rather leave this one to Pixel.' }, at: 6 },
  { id: 'will-answer', who: 'pet' as const, text: 'Say what the chart changed for you — one sentence. Then let the room catch up.', at: 7 },
];
/** The nameplate tapped: Pixel's card open over the Stage (add-game-layout › Pet card screen) */
const openCard = async (page: import('@playwright/test').Page) => {
  await page.locator('.ds-hud__nameplate').click();
  await page.getByRole('dialog', { name: "Pixel's card" }).waitFor();
  await page.mouse.move(0, 0);
};
// the frames hold the card at its top (data-scroll top): the Wish section is below its fold, in the card's own scroll
const WISH_BELOW = ['{name} wants {outfit}', '{name} has every outfit for now.', '{name} already has {outfit}.', "{name}'s wish",
  'Saved {saved_cents} of {price_cents}', '{saved_near} of {price_near} NEAR'];
// the card's Wish section opens the Wish sheet; the card closes as the sheet opens
const openSheet = async (page: import('@playwright/test').Page) => {
  await openCard(page);
  await page.getByRole('link', { name: "Pixel's wish" }).click();
  await page.getByRole('dialog', { name: "Pixel's wish" }).waitFor();
  await page.mouse.move(0, 0);
  // the frames keep the conversation on its newest line
  await page.evaluate(() => document.querySelectorAll('[role="log"]').forEach((log) => { log.scrollTop = log.scrollHeight; }));
};

const diary = sampleDiary();
if (diary.entry.kind !== 'text') throw new Error('sample diary must have a text entry');

const fixtures: Record<string, ScreenFixture> = {
  // spec: add-pet-will › Work invitation card screen › success
  'invite-card': { ...signed(), fakes: { auth: SIGNED_IN, worker: { ...worker(noWish), invitations: { invitations: [inviteOne] } } }, belowFold: ['Work invitation'] },
  // spec: add-pet-will › Work invitation card screen › several valid invitations
  'invite-cards': { ...signed(), fakes: { auth: SIGNED_IN, worker: { ...worker(noWish), invitations: { invitations: inviteMany } } }, belowFold: ['Work invitation'] },
  // spec: add-pet-will › Work invitation card screen › error
  'invite-ended': { ...signed(), fakes: { auth: SIGNED_IN, worker: { ...worker(noWish), invitations: { invitations: [inviteOne] },
    acceptInvitation: { fail: { status: 409, code: 'invitation_ended' } } } }, prepare: async (page) => {
      await page.getByRole('button', { name: 'Ask Biscuit' }).click();
      await page.getByText('This invitation has ended.').filter({ visible: true }).first().waitFor();
    } },
  // spec: add-pet-will › Refusal privacy data › worker owner views refusal
  'pet-declined': signed({ ...noWish, willActivity: [{ at: 1, code: 'character' }] }),
  // spec: add-pet-will › Character refusal flow › character declines pet hire
  'work-character-refused': { ...signed(), fakes: { auth: SIGNED_IN, worker: { ...worker({ ...noWish, hireMode: 'manual' }),
    conversation: { lines: hireLines, more: false, before: null } } } },
  'work-character-refused-auto': { ...signed(), fakes: { auth: SIGNED_IN, worker: { ...worker({ ...noWish, hireMode: 'auto' }),
    conversation: { lines: hireLines, more: false, before: null } } }, prepare: async (page) => {
      const answer = page.getByText('Say what the chart changed for you — one sentence. Then let the room catch up.', { exact: true }).first();
      await answer.waitFor();
      await answer.evaluate(async (element) => {
        await document.fonts.ready;
        await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
    } },
  // spec: add-pet-will › Character refusal flow › character declines player advice
  'advice-character-refused': adviceFrame('character_refused', 'No food was spent.', ['No food was spent.']),
  // spec: add-pet-will › Character refusal flow › no signed answer
  'advice-screening-lost': adviceFrame('screening_failed', 'lost that thought. Nothing was spent — try again.', ['{name} lost that thought. Nothing was spent — try again.']),
  // spec: add-pet-will › Character refusal flow › third screening fails
  'advice-screening-third': adviceFrame('screening_exhausted', 'unavailable until tomorrow.', ['{name} lost that thought. Nothing was spent.', '{name} is unavailable until tomorrow.']),
  // spec: add-pet-will › Character refusal flow › refusal capacity reached
  'advice-refusal-cap': adviceFrame('screening_capacity', 'unavailable until tomorrow.', ['{name} is unavailable until tomorrow.']),
  // spec: add-pet-will › Refusal privacy data › receipt read
  'verify-refusal': (() => { const proof = verificationFakes(); return { route: `/pet/9/verify/refusal/${'f'.repeat(24)}`,
    fakes: { ...proof, worker: { ...proof.worker, refusalEvidence: { id: 'f'.repeat(24), reason: "I can't answer that as myself. I need to know them better first.",
      at: 1, signedEvidenceBase64: Buffer.from(JSON.stringify({ signature: `8k2R${'a'.repeat(40)}s4Hq` })).toString('base64'), onChainReceipt: false } } },
    prepare: async (page) => {
      await page.getByText('No on-chain receipt for this refusal.').filter({ visible: true }).first().waitFor();
      await page.getByRole('link', { name: 'Back to Pixel' }).waitFor();
      await page.getByRole('heading', { level: 1, name: 'Pixel' }).waitFor();
      await expect.poll(() => page.getByRole('link', { name: 'Back to Pixel' }).evaluate((link) => {
        const label = link.querySelector('.ds-button__label');
        return Boolean(label && label.getBoundingClientRect().right <= link.getBoundingClientRect().right);
      })).toBe(true);
    } }; })(),
  // spec: add-pet-will › Wish pursuit flow › wish chosen
  'pet-wish': { ...signed(), prepare: openCard, belowFold: WISH_BELOW },
  // spec: add-pet-will › Wish pursuit flow › no target
  'pet-wish-none': { ...signed({ wish: null, wishActive: false, wishReserveYocto: '0', outfits: [...owns, 'smart-glasses', 'bow-tie', 'headphones'] }), prepare: openCard, belowFold: WISH_BELOW },
  // spec: add-pet-will › Wish pursuit flow › automatic purchase
  'pet-wish-earned': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: { ...worker({ wish: null, wishActive: false, wishReserveYocto: '0', outfits: [...owns, 'smart-glasses'] }),
    wardrobe: { outcome: { id: 'wish-buy', item: 'smart-glasses', status: 'bought', code: null, source: 'pet_wish' } } } },
    prepare: async (page) => { await page.getByText('Pixel earned Smart glasses!').waitFor(); } },
  // spec: add-pet-will › Wish pursuit flow › target bought by owner
  'pet-wish-owner-bought': { ...signed(), fakes: { auth: SIGNED_IN, worker: { ...worker(), wardrobe: { outcome: { id: 'owner-buy', item: 'smart-glasses', status: 'bought', code: null, source: 'owner' } } } },
    prepare: async (page) => {
      await page.getByText('Start with the chart, then.').first().waitFor();
      await setPixel(page, { ...owner, wish: null, wishActive: false, wishReserveYocto: '0', outfits: [...owns, 'smart-glasses'] });
      await lookAgain(page);
      await openCard(page);
      await page.getByText('Pixel already has Smart glasses.').waitFor();
    }, belowFold: WISH_BELOW },
  // spec: add-pet-will › Work seeking flow › pet asleep
  'pet-work-seeking-asleep': { ...signed(), prepare: async (page) => {
    // the food ran out under the open page, as the frame shows it: the typed line stays in the field, the line says why
    await page.getByText('Start with the chart, then.').first().waitFor();
    await page.getByPlaceholder('Talk to Pixel…').fill('And if they ask why the chart matters?');
    await setWorker(page, { pets: { '9': { ...ASLEEP_PIXEL, worn: null, owner }, '2': OWNER.pets['2'] }, petState: { events: ['fell_asleep'] } });
    await lookAgain(page);
    await page.getByText('Feed Pixel to wake them.').filter({ visible: true }).first().waitFor();
    await page.getByText('Pixel fell asleep.').filter({ visible: true }).first().waitFor();
    await setWorker(page, { petState: {} });
    await page.getByPlaceholder('Talk to Pixel…').blur();
  } },
  // spec: add-pet-will › Will ownership rule › former owner opens
  'pet-former-owner': { ...signed(), fakes: { auth: SIGNED_IN, worker: { ...worker(), toastHeld: true } }, prepare: async (page) => {
    await openCard(page);
    await page.getByRole('link', { name: "Pixel's wish" }).click();
    await page.getByRole('dialog', { name: "Pixel's wish" }).waitFor();
    await setWorker(page, { owned: [] });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByRole('main').getByText('This pet belongs to someone else now.').waitFor();
  } },
  // spec: add-pet-will › Wish sheet screen › success
  'wish-sheet': { ...signed(), prepare: openSheet },
  // spec: add-pet-will › Wish sheet screen › error
  'wish-sheet-error': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: { ...worker(), wish: { fail: { status: 503, code: 'chain_unreachable' } } } }, prepare: async (page) => {
    await openSheet(page);
    await expect(page.getByRole('dialog', { name: "Pixel's wish" }).getByRole('button', { name: 'Try again' })).toHaveClass(/ds-button--block/);
  } },
  // spec: add-pet-will › Wish pursuit flow › purchase waits for daily reset
  'wish-sheet-waiting': { ...signed({ wish: { ...wish, status: 'waiting_day', reserveYocto: '1660000000000000000000' } }), prepare: openSheet },
  // spec: add-pet-will › Will ownership rule › gift confirmed
  'wish-sheet-new-owner': { ...signed({ wish: { ...wish, status: 'paused' }, wishActive: false }), prepare: openSheet },
  // spec: add-pet-will › Will ownership rule › new owner continues
  // the Wish read comes from the pet itself, which the confirmed Continue turns active (the other frames pin the read)
  'wish-sheet-continued': { route: '/pet/9', fakes: { auth: SIGNED_IN, worker: { ...worker({ wish: { ...wish, status: 'paused' }, wishActive: false }), wish: undefined } }, prepare: async (page) => {
    await openSheet(page);
    await page.getByRole('dialog', { name: "Pixel's wish" }).getByRole('button', { name: 'Continue wish' }).click();
    // the confirmed read: no inherited-wish line, no «Continue wish» — the sheet of an active wish
    const sheet = page.getByRole('dialog', { name: "Pixel's wish" });
    await sheet.getByRole('button', { name: 'Continue wish' }).waitFor({ state: 'detached' });
    await sheet.getByText('Saved 0.30¢ of 0.76¢').waitFor();
  } },
  // spec: add-pet-will › Wish pursuit flow › wish chosen
  'diary-will': { route: '/pet/9/diary', fakes: { auth: SIGNED_IN, worker: { ...worker(), diary: { ...diary, entry: {
    ...diary.entry, socialLines: ['I think Biscuit and I are getting closer.', 'Sage and I had a rough day.'],
    willLine: 'I keep thinking about the Smart glasses. My saved food is getting closer.',
    work: { hirers: ['Biscuit', 'Nori'], cents: 0.6 },
  } } } }, prepare: async (page) => {
    await page.getByText('I keep thinking about the Smart glasses. My saved food is getting closer.').waitFor();
  } },
};

for (const frame of readManifestFrames().filter((f) => f.id in fixtures)) {
  const fixture = fixtures[frame.id]!;
  for (const viewport of viewportsOf(frame)) {
    test(`${frame.id} · ${viewport}`, async ({ page, context }) => {
      const capture = await captureFrame(page, frame, viewport, fixture);
      if (fs.existsSync(path.join(FRAMES_DIR, `${frame.id}.${viewport}.png`))) await writeComposite(context, frame, viewport, capture);
    });
  }
}
