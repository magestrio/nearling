import { test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { FakeWorkerState } from '../../src/seams/fakes';
import type { DebateLineRead, DebateRead } from '../../src/seams/worker-types';
import { viewportsOf } from './copy';
import { FRAME_HISTORY } from './fixtures';
import type { ScreenFixture } from './fixtures';
import { FRAMES_DIR, captureFrame, readManifestFrames, writeComposite } from './harness';
import { BISCUIT, lookAgain, PIXEL, setWorker, SIGNED_IN, WARDROBE_OWNS } from '../helpers';

// The add-debates frames (design/bundle/screens/debate.js, pet.js › debateInvitation / debateStatus, society.js).
// Each entry carries its anchor on the line above; a frame of the change without an entry fails `verify.sh add-debates`.

const FOREVER = 3_600_000;
const NORI = { tokenId: '5', name: 'Nori', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 }, mood: 'happy' as const };
const SAGE = { tokenId: '7', name: 'Sage', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 }, mood: 'happy' as const };
const TOPIC = 'Should every rainy day have a parade?';
const CARD_TOPIC = 'Should the moon keep a notebook of everything we do?';
const DEBATE_ID = 'a'.repeat(64);
const CODE = 'b'.repeat(32);
const KNOWN = [NORI, BISCUIT, SAGE].map(({ tokenId, name }) => ({ tokenId, name }));

const ownerWorker = (extra: Partial<FakeWorkerState> = {}, asleep = false): FakeWorkerState => ({
  owned: ['9'],
  pets: {
    '9': { ...PIXEL, worn: null, fullness: asleep ? { state: 'asleep', level: 0 } : PIXEL.fullness, owner: { ownedCount: 2, outfits: WARDROBE_OWNS } },
    '2': BISCUIT, '5': NORI, '7': SAGE,
  },
  conversation: { lines: FRAME_HISTORY, more: false, before: null },
  debatePartners: { partners: KNOWN },
  ...extra,
});

const settleSheet = async (page: Page) => {
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)));
  });
};

/** The «More» menu, «Debate with a known pet», the sheet open and its pair read. */
const openSheet = async (page: Page, ready: string | RegExp | null = null) => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Debate with a known pet' }).click();
  await page.getByRole('dialog', { name: 'Start a debate' }).waitFor();
  if (ready) await page.getByRole('dialog', { name: 'Start a debate' }).getByText(ready).first().waitFor();
};
const typeTopic = async (page: Page, topic = TOPIC) => {
  const field = page.getByRole('dialog', { name: 'Start a debate' }).getByRole('textbox');
  await field.fill(topic);
  await field.blur();
};
const sheetReady = async (page: Page) => {
  await openSheet(page);
  await page.getByRole('dialog', { name: 'Start a debate' }).getByRole('button', { name: 'Send invitation' }).waitFor();
};

const ELIGIBLE_NOTICE = 'Each pet can spend up to 0.01 NEAR on two lines.';
const filled = async (page: Page) => {
  await sheetReady(page);
  await page.getByRole('dialog', { name: 'Start a debate' }).getByText(ELIGIBLE_NOTICE, { exact: false }).waitFor();
  await typeTopic(page);
  await settleSheet(page);
};
const inviteFixture = (extra: Partial<FakeWorkerState>, prepare: (page: Page) => Promise<void>, asleep = false): ScreenFixture => ({
  route: '/pet/9',
  fakes: { auth: SIGNED_IN, worker: ownerWorker(extra, asleep) },
  prepare: async (page) => { await prepare(page); await settleSheet(page); },
});
// the estimate is the Worker's answer for an eligible pair: a state without one cannot draw the frame's line (design.md › Отклонения)
const noEstimate = (fixture: ScreenFixture): ScreenFixture => ({ ...fixture, staleCopy: ['About 0.15¢ per pet'] });
const fail = (status: number, code: string, body?: unknown) => ({ fail: { status, code, ...(body === undefined ? {} : { body }) } });

// the invited owner's card (pet.js › debateInvitation): Biscuit invited Pixel and speaks first
const incoming = (extra: Partial<DebateRead> = {}): Partial<FakeWorkerState> => ({
  debateIncoming: { ids: [DEBATE_ID] },
  debateRead: { id: DEBATE_ID, status: 'invited', topic: CARD_TOPIC, firstPet: { tokenId: '2', name: 'Biscuit' },
    secondPet: { tokenId: '9', name: 'Pixel' }, openerPet: '2', estimatePerPetCents: 0.15, expiresAt: Date.UTC(2099, 0, 1), ...extra },
});
const cardFixture = (extra: Partial<FakeWorkerState>, ready: string | RegExp, asleep = false): ScreenFixture => ({
  route: '/pet/9',
  fakes: { auth: SIGNED_IN, worker: ownerWorker({ ...incoming(), ...extra }, asleep) },
  prepare: async (page) => { await page.getByText(ready).first().waitFor(); await settleSheet(page); },
});

// the status line under the Pet's log (pet.js › debateStatus)
const statusFixture = (status: DebateRead['status'], side: 'proposer' | 'recipient', ready: string, read: Partial<DebateRead> = {}, retained = false): ScreenFixture => ({
  route: '/pet/9',
  fakes: { auth: SIGNED_IN, worker: ownerWorker({
    debateRecords: { records: [{ id: DEBATE_ID, status, side, ...(retained ? { retained } : {}) }] },
    debateRead: { id: DEBATE_ID, status, topic: TOPIC, firstPet: { tokenId: '9', name: 'Pixel' }, secondPet: { tokenId: '5', name: 'Nori' }, openerPet: '9', ...read },
  }) },
  prepare: async (page) => { await page.getByText(ready, { exact: false }).first().waitFor(); await settleSheet(page); },
});

// the transcript (debate.js › transcript): four lines, the rate of the frame's sample cents (fix round 1)
const SAMPLE = [
  { speaker: '9', text: 'Absolutely. Puddles are tiny mirrors, and a parade gives them something worth reflecting.', yocto: '180000000000000000000' },
  { speaker: '5', text: 'A parade would splash everyone. I would rather lend each puddle a quiet lantern.', yocto: '170000000000000000000' },
  { speaker: '9', text: 'Then let the lanterns lead. Even a quiet parade can have a little drum.', yocto: '190000000000000000000' },
  { speaker: '5', text: 'One small drum, then. The rain can keep the rhythm.', yocto: '160000000000000000000' },
];
const line = (index: number, status: DebateLineRead['status'] = 'settled', text?: string): DebateLineRead => ({
  order: index + 1, speakerPet: SAMPLE[index]!.speaker, status, text: text ?? SAMPLE[index]!.text,
  requestBytes: null, responseBytes: null, signedCall: null,
  receiptTxHash: status === 'settled' ? 'H'.repeat(44) : null,
  priceYocto: status === 'settled' ? SAMPLE[index]!.yocto : null, nearUsdRate: status === 'settled' ? '2.45' : null,
});
const settled = (count: number) => Array.from({ length: count }, (_, i) => line(i));
const debate = (status: DebateRead['status'], lines: DebateLineRead[], extra: Partial<DebateRead> = {}): DebateRead => ({
  id: DEBATE_ID, status, topic: TOPIC, firstPet: { tokenId: '9', name: 'Pixel' }, secondPet: { tokenId: '5', name: 'Nori' },
  openerPet: '9', code: CODE, analyticsId: 'c'.repeat(64), lines, ...extra,
});
const transcript = (read: DebateRead | { fail: { status: number; code: string } }, extra: Partial<FakeWorkerState> = {}, auth = true): ScreenFixture => ({
  route: `/debate#${CODE}`,
  fakes: { ...(auth ? { auth: SIGNED_IN } : {}), worker: { owned: ['9'], pets: { '9': PIXEL, '5': NORI }, debateRead: read, ...extra } },
  prepare: async (page) => { await settleSheet(page); },
});
const asLines = (read: DebateRead, wait: string | RegExp): ScreenFixture => ({
  ...transcript(read),
  prepare: async (page) => { await page.getByText(wait).first().waitFor(); await settleSheet(page); },
});

const fixtures: Record<string, ScreenFixture> = {
  // spec: add-debates › Debate invitation screen › empty
  'debate-invite-empty': inviteFixture({ debatePartners: { partners: [] } }, async (page) => {
    await openSheet(page, 'No known pet to debate yet. Meet one through feeding or work.');
  }),
  // spec: add-debates › Debate invitation screen › loading
  'debate-invite-loading': noEstimate(inviteFixture({ debateEligibilityDelayMs: FOREVER }, async (page) => {
    await openSheet(page, 'Checking pets and costs…');
    await typeTopic(page);
  })),
  // spec: add-debates › Debate invitation screen › error
  'debate-invite-error': noEstimate(inviteFixture({ debateEligibility: fail(503, 'chain_unreachable') }, async (page) => {
    await openSheet(page, 'Could not check this debate. Try again.');
    await typeTopic(page);
  })),
  // spec: add-debates › Debate invitation screen › success
  'debate-invite-success': inviteFixture({}, filled),
  // spec: add-debates › Debate invitation screen › signed-out
  'debate-invite-signed-out': inviteFixture({}, async (page) => {
    await filled(page);
    await setWorker(page, { sessionExpired: true });
    await lookAgain(page);
    await page.getByRole('dialog', { name: 'Start a debate' }).getByText('Sign in to invite these pets.').first().waitFor();
  }),
  // spec: add-debates › Debate invitation screen › asleep
  'debate-invite-asleep': noEstimate(inviteFixture({}, async (page) => {
    // the typed topic stays in the tab; the food runs out under the open sheet and the recheck says so
    await filled(page);
    await setWorker(page, { debateEligibility: fail(409, 'asleep', { name: 'Pixel', petId: '9' }),
      pets: ownerWorker({}, true).pets });
    await lookAgain(page);
    await page.getByRole('dialog', { name: 'Start a debate' }).getByText('Pixel is asleep. Feed Pixel before debating.').first().waitFor();
  })),
  // spec: add-debates › Debate invitation flow › topic rejected
  'debate-invite-topic-rejected': inviteFixture({}, async (page) => {
    await sheetReady(page);
    await page.getByRole('dialog', { name: 'Start a debate' }).getByText('Write a topic in 140 characters or less.').first().waitFor();
  }),
  // spec: add-debates › Debate invitation flow › unknown pair
  'debate-invite-unknown-pair': noEstimate(inviteFixture({}, async (page) => {
    await filled(page);
    await setWorker(page, { debateEligibility: fail(409, 'unknown_pair') });
    await page.getByRole('combobox', { name: 'Debate with' }).selectOption('Biscuit');
    await page.getByRole('dialog', { name: 'Start a debate' }).getByText('These pets need to meet before debating.').first().waitFor();
  })),
  // spec: add-debates › Debate invitation flow › same owner
  'debate-invite-same-owner': noEstimate(inviteFixture({}, async (page) => {
    await filled(page);
    await setWorker(page, { debateEligibility: fail(409, 'same_owner') });
    await page.getByRole('combobox', { name: 'Debate with' }).selectOption('Sage');
    await page.getByRole('dialog', { name: 'Start a debate' }).getByText('Choose a pet owned by someone else.').first().waitFor();
  })),
  // spec: add-debates › Debate outcome rule › daily slot used
  'debate-invite-daily-slot-used': noEstimate(inviteFixture({ debateEligibility: fail(409, 'daily_slot_used') }, async (page) => {
    await openSheet(page, 'Pixel has debated today. Try again tomorrow.');
    await typeTopic(page);
  })),

  // spec: add-debates › Debate invitation card screen › loading
  // the estimate is the Worker's answer for the invitation, not read yet: the frame draws it, the card cannot (design.md › Отклонения)
  'debate-card-loading': { ...cardFixture({ debateIncomingDelayMs: FOREVER }, 'Checking invitation…'), staleCopy: ['About 0.30¢ for both pets'] },
  // spec: add-debates › Debate invitation card screen › error
  'debate-card-error': { ...cardFixture({ debateIncoming: fail(503, 'chain_unreachable') }, 'Could not check this invitation. Try again.'), staleCopy: ['About 0.30¢ for both pets'] },
  // spec: add-debates › Debate invitation card screen › success
  'debate-card-success': cardFixture({}, 'Accept debate'),
  // spec: add-debates › Debate invitation card screen › signed-out
  'debate-card-signed-out': {
    route: '/pet/9',
    fakes: { auth: SIGNED_IN, worker: ownerWorker(incoming()) },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Accept debate' }).waitFor();
      await setWorker(page, { sessionExpired: true });
      await lookAgain(page);
      await page.getByText('Sign in to see your invitations.').first().waitFor();
      await settleSheet(page);
    },
  },
  // spec: add-debates › Debate invitation card screen › asleep
  'debate-card-asleep': cardFixture({}, 'Pixel is asleep. Feed Pixel before accepting.', true),

  // spec: add-debates › Debate invitation flow › invited
  'debate-status-invited': statusFixture('invited', 'proposer', 'Invitation sent. Waiting for the other owner.'),
  // spec: add-debates › Debate invitation flow › accepted
  'debate-status-accepted': statusFixture('accepted', 'recipient', 'Debate accepted', { code: CODE }),
  // spec: add-debates › Debate invitation flow › declined
  'debate-status-declined': statusFixture('declined', 'proposer', 'Invitation declined'),
  // spec: add-debates › Debate invitation flow › expired
  'debate-status-expired': statusFixture('expired', 'proposer', 'Invitation expired'),
  // spec: add-debates › Debate invitation flow › gift before start
  'debate-status-gift': statusFixture('gift', 'proposer', 'Invitation ended after a gift'),
  // spec: add-debates › Debate invitation flow › memory clear before start
  'debate-status-memory': statusFixture('cleared', 'proposer', 'Invitation ended after memory was cleared.'),
  // spec: add-debates › Debate transcript and deletion data › gift after paid line
  'pet-card-friends-past-debates': { ...statusFixture('gift', 'proposer', 'Past debates', { code: CODE }, true),
    prepare: async (page) => { await page.getByRole('link', { name: 'Past debates' }).first().waitFor();
      await page.locator('.ds-hud__nameplate').click();
      const card = page.getByRole('dialog', { name: "Pixel's card" });
      await card.getByRole('link', { name: 'Past debates' }).waitFor();
      // the frame rests with the card scrolled to its end, where Friends › «Past debates» stands
      await card.evaluate((dialog) => {
        for (const el of [dialog, ...dialog.querySelectorAll<HTMLElement>('*')]) {
          const overflow = getComputedStyle(el).overflowY;
          if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
        }
      });
      await settleSheet(page); } },

  // spec: add-debates › Debate invitation flow › settled-hire acquaintance
  'pet-debate-guest': {
    route: '/pet/2',
    fakes: { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT },
      me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 },
      debatePartners: { partners: [{ tokenId: '2', name: 'Biscuit' }] } } },
    prepare: async (page) => { await page.getByRole('link', { name: 'Invite to debate' }).waitFor(); await settleSheet(page); },
  },
  // spec: add-debates › Debate invitation flow › settled-hire acquaintance
  'society-debate-known': {
    route: '/pet/9/relationships',
    fakes: { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': { ...PIXEL, worn: 'thinking-cap' } },
      relationships: { tokenId: '9', name: 'Pixel', relationships: [
        { tokenId: '2', name: 'Biscuit', stance: 'liked', breakUntil: null },
        { tokenId: '5', name: 'Nori', stance: 'neutral', breakUntil: null },
        { tokenId: '7', name: 'Sage', stance: 'strained', breakUntil: null },
        { tokenId: '8', name: 'Mochi', stance: 'strained', breakUntil: Date.parse('2026-11-07T16:00:00Z') },
      ] },
      debatePartners: { partners: KNOWN } } },
    beforeLoad: (page) => page.clock.install({ time: new Date('2026-11-07T12:00:00Z') }),
    prepare: async (page) => { await page.getByRole('link', { name: 'Invite to debate' }).first().waitFor(); await settleSheet(page); },
  },

  // spec: add-debates › Debate transcript screen › empty
  'debate-transcript-empty': asLines(debate('accepted', []), 'No lines yet. The pets are getting ready.'),
  // spec: add-debates › Debate transcript screen › loading
  // the pet is unknown before the read (and never told for a deleted link): the header's back control is «Go home», the frame draws «Back to Pixel»
  'debate-transcript-loading': { ...transcript(debate('accepted', []), { debateSharedDelayMs: FOREVER }), staleCopy: ['Back to {pet}'] },
  // spec: add-debates › Debate transcript screen › error
  'debate-transcript-error': { ...transcript(fail(503, 'unavailable')), staleCopy: ['Back to {pet}'] },
  // spec: add-debates › Debate transcript screen › deleted shared link
  'debate-transcript-deleted': { ...transcript({ fail: { status: 404, code: 'not_found' } }), staleCopy: ['Back to {pet}'] },
  // spec: add-debates › Debate transcript screen › success
  'debate-transcript-success': asLines(debate('completed', settled(4)), 'Debate complete'),
  // spec: add-debates › Debate transcript screen › success
  // the frame's scroll rests on the fourth line: its «Debate complete» stands at the top of the page, above the visible part
  'debate-transcript-success-end': { ...asLines(debate('completed', settled(4)), 'Debate complete'), belowFold: ['Debate complete', 'Back to {pet}'] },
  // spec: add-debates › Debate transcript screen › signed-out
  'debate-transcript-signed-out': { ...transcript(debate('completed', settled(4)), {}, false),
    prepare: async (page) => { await page.getByRole('button', { name: 'Sign in' }).waitFor(); await settleSheet(page); } },
  // spec: add-debates › Debate transcript screen › asleep
  'debate-transcript-asleep': asLines(debate('unavailable', settled(2), { endReason: 'asleep' }), 'Pixel fell asleep. This debate has ended.'),
  // spec: add-debates › Debate turn flow › started
  'debate-transcript-started': asLines(debate('running', settled(1)), 'Stop debate'),
  // spec: add-debates › Debate turn flow › settled line
  'debate-transcript-settled-line': asLines(debate('running', settled(2)), 'Stop debate'),
  // spec: add-debates › Debate turn flow › receipt pending
  'debate-transcript-receipt-pending': asLines(debate('running', [line(0), line(1, 'receipt_pending')]), 'Receipt pending'),
  // spec: add-debates › Debate turn flow › debit rejected
  'debate-transcript-debit-rejected': asLines(debate('unavailable', [line(0), line(1, 'unavailable')], { endReason: 'debit_rejected' }), 'Receipt unavailable'),
  // spec: add-debates › Debate turn flow › owner stops
  'debate-transcript-owner-stops': asLines(debate('stopped', settled(2)), 'Stopped by an owner'),
  // spec: add-debates › Debate turn flow › character refusal
  'debate-transcript-character-refusal': asLines(debate('refused', [line(0, 'settled', 'I would rather sit this one out today.')]), 'Pixel chose not to continue.'),
  // spec: add-debates › Debate turn flow › gift mid debate
  'debate-transcript-gift-mid-debate': asLines(debate('gift', settled(2)), 'Debate ended after a gift'),
  // spec: add-debates › Debate turn flow › gift during a line
  'debate-transcript-gift-during-line': asLines(debate('gift', settled(2)), 'Debate ended after a gift'),
  // spec: add-debates › Debate turn flow › model unavailable
  'debate-transcript-model-unavailable': asLines(debate('unavailable', settled(2), { endReason: 'model_unavailable' }), 'This debate could not continue. No more food was spent.'),
  // spec: add-debates › Debate turn flow › services paused
  'debate-transcript-services-paused': asLines(debate('unavailable', settled(2), { endReason: 'services_paused' }), 'Debate paused. No more food was spent.'),
  // spec: add-debates › Debate turn flow › food or cap exhausted
  'debate-transcript-food-or-cap': asLines(debate('unavailable', settled(2), { endReason: 'cannot_pay' }), 'Pixel cannot pay for another line today.'),
  // spec: add-debates › Debate transcript and deletion data › clear during a line
  'debate-transcript-clear-during-line': { ...transcript({ fail: { status: 404, code: 'not_found' } },
    { debateCleared: { id: DEBATE_ID, status: 'cleared', endReason: 'memory_clear' } }), staleCopy: ['Back to {pet}'],
    prepare: async (page) => { await page.getByText('Debate ended after memory was cleared.').first().waitFor(); await settleSheet(page); } },
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
