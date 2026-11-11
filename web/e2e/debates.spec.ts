import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { expect, test, type Page } from '@playwright/test';
import { buildEnvFor } from '../build-env';
import type { FakeState, FakeWorkerState } from '../src/seams/fakes';
import type { DebateLineRead, DebateRead } from '../src/seams/worker-types';
import { BISCUIT, calls, lookAgain, openMore, openWith, OWNER, PIXEL, reloadHolding, setWorker, SIGNED_IN } from './helpers';

const NORI = { tokenId: '5', name: 'Nori', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 }, mood: 'happy' as const };
const SAGE = { tokenId: '7', name: 'Sage', stage: 'adult' as const, fullness: { state: 'full' as const, level: 1 }, mood: 'happy' as const };
const KNOWN = [NORI, BISCUIT, SAGE].map(({ tokenId, name }) => ({ tokenId, name }));
const ID = 'a'.repeat(64);
const CODE = 'b'.repeat(32);
const TOPIC = 'Should every rainy day have a parade?';
const SHEET = 'Start a debate';
const ASLEEP_FULLNESS = { state: 'asleep' as const, level: 0 };
const fail = (status: number, code: string, body?: unknown) => ({ fail: { status, code, ...(body === undefined ? {} : { body }) } });

const ownerWorker = (extra: Partial<FakeWorkerState> = {}, asleep = false): FakeWorkerState => ({
  ...OWNER,
  pets: { '9': { ...PIXEL, fullness: asleep ? ASLEEP_FULLNESS : PIXEL.fullness }, '2': BISCUIT, '5': NORI, '7': SAGE },
  debatePartners: { partners: KNOWN },
  ...extra,
});
const sheet = (page: Page) => page.getByRole('dialog', { name: SHEET });
const openPet = (page: Page, extra: Partial<FakeWorkerState> = {}, asleep = false, route = '/pet/9', auth: FakeState['auth'] = SIGNED_IN) =>
  openWith(page, route, { auth, worker: ownerWorker(extra, asleep) });
const openSheet = async (page: Page) => {
  await openMore(page);
  await page.getByRole('menuitem', { name: 'Debate with a known pet' }).click();
  await sheet(page).waitFor();
};
const typeTopic = async (page: Page, topic = TOPIC) => { await sheet(page).getByRole('textbox').fill(topic); };
const NOTICE = 'Each pet can spend up to 0.01 NEAR on two lines. Anyone with the link may read the topic and lines. The other owner must accept.';
const ready = async (page: Page) => { await openSheet(page); await expect(sheet(page).getByText(NOTICE)).toBeVisible(); };
const named = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const countOf = async (page: Page, call: string) => (await calls(page)).filter((c) => c === call).length;

// the invited owner's card: Biscuit invited Pixel
const incoming = (extra: Partial<DebateRead> = {}): Partial<FakeWorkerState> => ({
  debateIncoming: { ids: [ID] },
  debateRead: { id: ID, status: 'invited', topic: 'Should the moon keep a notebook of everything we do?',
    firstPet: { tokenId: '2', name: 'Biscuit' }, secondPet: { tokenId: '9', name: 'Pixel' }, openerPet: '2',
    estimatePerPetCents: 0.15, expiresAt: Date.UTC(2099, 0, 1), ...extra },
});
const card = (page: Page) => page.getByRole('list', { name: 'Debate invitation' });

// ---- the invitation sheet ----

// spec: add-debates › Debate invitation screen › success
// spec: add-debates › Debate invitation screen › success × Send invitation
// spec: add-debates › Debate invitation flow › invited
test('sends one invitation with the topic and the chosen opener, then says it is waiting', async ({ page }) => {
  await openPet(page);
  await ready(page);
  await expect(sheet(page).getByText('About 0.15¢ per pet')).toBeVisible();
  await expect(named(page, 'Send invitation')).toBeDisabled();
  await typeTopic(page);
  await sheet(page).getByRole('radio', { name: 'Nori' }).check();
  await named(page, 'Send invitation').click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText('Invitation sent. Waiting for the other owner.')).toBeVisible();
  expect(await countOf(page, 'worker:debateInvite')).toBe(1);
});

// spec: add-debates › Debate invitation screen › loading
// spec: add-debates › Debate invitation screen › loading × Send invitation inactive
test('loading: the sheet says it is checking and Send invitation stays off', async ({ page }) => {
  await openPet(page, { debateEligibilityDelayMs: 3_600_000 });
  await openSheet(page);
  await expect(sheet(page).getByText('Checking pets and costs…').first()).toBeVisible();
  await typeTopic(page);
  await expect(named(page, 'Send invitation')).toBeDisabled();
  expect(await countOf(page, 'worker:debateInvite')).toBe(0);
});

// spec: add-debates › Debate invitation screen › error
// spec: add-debates › Debate invitation screen › error × Try again
test('error: says it could not check, and Try again checks once more', async ({ page }) => {
  await openPet(page, { debateEligibility: fail(503, 'chain_unreachable') });
  await openSheet(page);
  await expect(sheet(page).getByText('Could not check this debate. Try again.').first()).toBeVisible();
  const before = await countOf(page, 'worker:debateEligibility');
  await setWorker(page, { debateEligibility: undefined });
  await named(page, 'Try again').click();
  await expect(sheet(page).getByText(NOTICE)).toBeVisible();
  expect(await countOf(page, 'worker:debateEligibility')).toBeGreaterThan(before);
});

// spec: add-debates › Debate invitation screen › empty
// spec: add-debates › Debate invitation screen › empty × Back to {name}
test('empty: no known pet, and Back to Pixel closes the sheet on the Pet screen', async ({ page }) => {
  await openPet(page, { debatePartners: { partners: [] } });
  await openSheet(page);
  await expect(sheet(page).getByText('No known pet to debate yet. Meet one through feeding or work.').first()).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Back to Pixel' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-debates › Debate invitation screen › asleep
// spec: add-debates › Debate invitation screen › asleep × Feed {name}
test('asleep: says Pixel needs food, sends nothing and Feed Pixel opens the feed sheet', async ({ page }) => {
  await openPet(page, { debateEligibility: fail(409, 'asleep', { name: 'Pixel', petId: '9' }) }, true);
  await openSheet(page);
  await expect(sheet(page).getByText('Pixel is asleep. Feed Pixel before debating.').first()).toBeVisible();
  await expect(named(page, 'Send invitation')).toHaveCount(0);
  await sheet(page).getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(page.getByRole('dialog', { name: 'Feed Pixel' })).toBeVisible();
  expect(await countOf(page, 'worker:debateInvite')).toBe(0);
});

// spec: add-debates › Debate invitation screen › signed-out
// spec: add-debates › Debate invitation screen › signed-out × Sign in return
test('signed-out: the topic stays in the tab, nothing is sent and Sign in starts the sign-in', async ({ page }) => {
  await openPet(page);
  await ready(page);
  await typeTopic(page);
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await expect(sheet(page).getByText('Sign in to invite these pets.').first()).toBeVisible();
  await expect(sheet(page).getByRole('textbox')).toHaveValue(TOPIC);
  await expect(named(page, 'Send invitation')).toHaveCount(0);
  const stored = await page.evaluate(() => sessionStorage.getItem('debate:draft'));
  expect(stored).toContain(TOPIC);
  await sheet(page).getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(async () => (await calls(page)).includes('privy:login')).toBe(true);
  expect(await page.evaluate(() => sessionStorage.getItem('debate:draft'))).toContain(TOPIC);
  expect(await countOf(page, 'worker:debateInvite')).toBe(0);
});

// Close sheet: success, loading, error, signed-out and asleep each close on the Pet screen.
const closing: Array<{ state: string; extra: Partial<FakeWorkerState>; asleep?: boolean; expired?: boolean; anchor: string }> = [
  { state: 'success', extra: {}, anchor: 'Debate invitation screen › success × Close sheet' },
  { state: 'loading', extra: { debateEligibilityDelayMs: 3_600_000 }, anchor: 'Debate invitation screen › loading × Close sheet' },
  { state: 'error', extra: { debateEligibility: fail(503, 'chain_unreachable') }, anchor: 'Debate invitation screen › error × Close sheet' },
  { state: 'asleep', extra: { debateEligibility: fail(409, 'asleep', { name: 'Pixel', petId: '9' }) }, asleep: true,
    anchor: 'Debate invitation screen › asleep × Close sheet' },
  { state: 'signed-out', extra: {}, expired: true, anchor: 'Debate invitation screen › signed-out × Close sheet' },
];
for (const row of closing) {
  // spec: add-debates › Debate invitation screen › success × Close sheet
  // spec: add-debates › Debate invitation screen › loading × Close sheet
  // spec: add-debates › Debate invitation screen › error × Close sheet
  // spec: add-debates › Debate invitation screen › signed-out × Close sheet
  // spec: add-debates › Debate invitation screen › asleep × Close sheet
  // spec: add-debates › Debate invitation flow › invited × Close sheet
  test(`${row.anchor}: Close returns to the Pet screen`, async ({ page }) => {
    await openPet(page, row.extra, row.asleep);
    await openSheet(page);
    if (row.expired) { await setWorker(page, { sessionExpired: true }); await lookAgain(page); }
    await sheet(page).getByRole('button', { name: 'Close' }).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More' })).toBeVisible();
    expect(await countOf(page, 'worker:debateInvite')).toBe(0);
  });
}

// spec: add-debates › Debate invitation flow › unknown pair × choose eligible known pet
test('unknown pair: no invitation, and choosing a pet that is known clears the error', async ({ page }) => {
  await openPet(page);
  await ready(page);
  await typeTopic(page);
  await setWorker(page, { debateEligibility: fail(409, 'unknown_pair') });
  await page.getByRole('combobox', { name: 'Debate with' }).selectOption('Biscuit');
  await expect(sheet(page).getByText('These pets need to meet before debating.').first()).toBeVisible();
  await expect(named(page, 'Send invitation')).toBeDisabled();
  await setWorker(page, { debateEligibility: undefined });
  await page.getByRole('combobox', { name: 'Debate with' }).selectOption('Nori');
  await expect(sheet(page).getByText(NOTICE)).toBeVisible();
  await expect(named(page, 'Send invitation')).toBeEnabled();
  expect(await countOf(page, 'worker:debateInvite')).toBe(0);
});

// spec: add-debates › Debate invitation flow › same owner × choose differently owned known pet
test('same owner: no invitation, and choosing a pet of someone else clears the error', async ({ page }) => {
  await openPet(page);
  await ready(page);
  await typeTopic(page);
  await setWorker(page, { debateEligibility: fail(409, 'same_owner') });
  await page.getByRole('combobox', { name: 'Debate with' }).selectOption('Sage');
  await expect(sheet(page).getByText('Choose a pet owned by someone else.').first()).toBeVisible();
  await setWorker(page, { debateEligibility: undefined });
  await page.getByRole('combobox', { name: 'Debate with' }).selectOption('Nori');
  await expect(named(page, 'Send invitation')).toBeEnabled();
});

// spec: add-debates › Debate invitation screen › success × tab hidden and back
test('success: the tab coming back checks the pair again', async ({ page }) => {
  await openPet(page);
  await ready(page);
  const before = await countOf(page, 'worker:debateEligibility');
  await lookAgain(page);
  await expect.poll(() => countOf(page, 'worker:debateEligibility')).toBeGreaterThan(before);
});

// spec: add-debates › Debate invitation screen › success × gift
// spec: add-debates › Debate invitation screen › success × gift or memory clear
test('gift: once Pixel belongs to someone else the sheet and its controls are gone', async ({ page }) => {
  await openPet(page);
  await ready(page);
  await typeTopic(page);
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(sheet(page)).toHaveCount(0);
  await expect(named(page, 'Send invitation')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('debate:draft'))).toBeNull();
});

// spec: add-debates › Debate invitation screen › success × memory clear
// spec: add-debates › Debate invitation screen › success × gift or memory clear
// spec: add-debates › Debate invitation flow › memory clear before start
test('memory clear:the unsent draft is erased and the status says the invitation ended', async ({ page }) => {
  await openPet(page);
  await ready(page);
  await typeTopic(page);
  // the sheet closed: the Account menu opens under it on the desktop; the draft stays in the tab
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('debate:draft'))).toContain(TOPIC);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  await page.getByRole('alertdialog', { name: "Clear Pixel's memory?" }).getByRole('button', { name: 'Clear memory' }).click();
  await expect(page.getByText('Invitation ended after memory was cleared.')).toBeVisible();
  await expect(named(page, 'Send invitation')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('debate:draft') ?? '')).not.toContain(TOPIC);
});

// spec: add-debates › Debate invitation flow › invited × sign-out/site data erased
test('invited: after the tab forgets its draft the status is read again from the Worker', async ({ page }) => {
  await openPet(page, { debateRecords: { records: [{ id: ID, status: 'invited', side: 'proposer' }] } });
  await expect(page.getByText('Invitation sent. Waiting for the other owner.')).toBeVisible();
  await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
  await reloadHolding(page);
  await expect(page.getByText('Invitation sent. Waiting for the other owner.')).toBeVisible();
});

// ---- the invitation card ----

// spec: add-debates › Debate invitation card screen › success
// spec: add-debates › Debate invitation card screen › success × Accept debate
// spec: add-debates › Debate invitation flow › accepted
test('card: the notice stands before Accept debate, which accepts and offers the transcript link', async ({ page }) => {
  await openPet(page, { ...incoming(), debateDecision: { id: ID, status: 'accepted', code: CODE } });
  await expect(card(page).getByText('Each pet can spend up to 0.01 NEAR. Anyone with the link may read the topic and lines.')).toBeVisible();
  await expect(card(page).getByText('About 0.30¢ for both pets')).toBeVisible();
  expect(await countOf(page, 'worker:debateDecision')).toBe(0);
  await named(page, 'Accept debate').click();
  await expect(page.getByText('Debate accepted')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View debate' })).toHaveAttribute('href', `/debate#${CODE}`);
  await expect(card(page)).toHaveCount(0);
});

// spec: add-debates › Debate invitation card screen › success × Decline
// spec: add-debates › Debate invitation flow › declined
test('card: Decline closes the invitation with no transcript', async ({ page }) => {
  await openPet(page, { ...incoming(), debateDecision: { id: ID, status: 'declined' } });
  await named(page, 'Decline').click();
  await expect(page.getByText('Invitation declined')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View debate' })).toHaveCount(0);
});

// spec: add-debates › Debate invitation card screen › loading
// spec: add-debates › Debate invitation card screen › loading × Accept debate inactive
test('card loading: says it is checking and Accept debate stays off', async ({ page }) => {
  await openPet(page, { ...incoming(), debateIncomingDelayMs: 3_600_000 });
  await expect(page.getByText('Checking invitation…')).toBeVisible();
  await expect(named(page, 'Accept debate')).toBeDisabled();
  expect(await countOf(page, 'worker:debateDecision')).toBe(0);
});

// spec: add-debates › Debate invitation card screen › error
// spec: add-debates › Debate invitation card screen › error × Try again
test('card error: says it could not check, and Try again reads it again', async ({ page }) => {
  await openPet(page, { ...incoming(), debateIncoming: fail(503, 'chain_unreachable') });
  await expect(page.getByText('Could not check this invitation. Try again.')).toBeVisible();
  await setWorker(page, { debateIncoming: { ids: [ID] } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(named(page, 'Accept debate')).toBeVisible();
});

// spec: add-debates › Debate invitation card screen › signed-out
// spec: add-debates › Debate invitation card screen › signed-out × Sign in
// spec: add-debates › Debate invitation card screen › success × session expiry
test('card signed-out: the private card is hidden and Sign in starts the sign-in', async ({ page }) => {
  await openPet(page, incoming());
  await expect(named(page, 'Accept debate')).toBeVisible();
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await expect(page.getByText('Sign in to see your invitations.')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByText('Should the moon keep a notebook')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in' }).first().click();
  await expect.poll(async () => (await calls(page)).includes('privy:login')).toBe(true);
});

// spec: add-debates › Debate invitation card screen › asleep
// spec: add-debates › Debate invitation card screen › asleep × Feed {name}
test('card asleep: says Pixel needs food, accepts nothing and Feed Pixel opens the feed sheet', async ({ page }) => {
  await openPet(page, incoming(), true);
  await expect(card(page).getByText('Pixel is asleep. Feed Pixel before accepting.')).toBeVisible();
  await expect(named(page, 'Accept debate')).toHaveCount(0);
  await card(page).getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(page.getByRole('dialog', { name: 'Feed Pixel' })).toBeVisible();
  expect(await countOf(page, 'worker:debateDecision')).toBe(0);
});

// spec: add-debates › Debate invitation card screen › success × gift
// spec: add-debates › Debate invitation card screen › success × memory clear
test('card: a gift or a memory clear takes the card away', async ({ page }) => {
  await openPet(page, incoming());
  await expect(named(page, 'Accept debate')).toBeVisible();
  await setWorker(page, { debateIncoming: { ids: [] } });
  await lookAgain(page);
  await expect(card(page)).toHaveCount(0);
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(named(page, 'Accept debate')).toHaveCount(0);
});

// spec: add-debates › Debate invitation card screen › success × reload
// spec: add-debates › Debate invitation card screen › success × tab hidden and back
// spec: add-debates › Debate invitation card screen › success × site data erased
test('card: a reload, the tab coming back and erased site data all read the invitation from the Worker', async ({ page }) => {
  await openPet(page, incoming());
  await expect(named(page, 'Accept debate')).toBeVisible();
  await reloadHolding(page);
  await expect(named(page, 'Accept debate')).toBeVisible();
  const before = await countOf(page, 'worker:debateIncoming');
  await lookAgain(page);
  await expect.poll(() => countOf(page, 'worker:debateIncoming')).toBeGreaterThan(before);
  await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
  await reloadHolding(page);
  await expect(named(page, 'Accept debate')).toBeVisible();
});

// spec: add-debates › Debate invitation flow › accepted × existing Pet/Society entry changes
test('the entries: a known pet opens the sheet with that pet chosen, from its Pet screen and from Society', async ({ page }) => {
  const worker: Partial<FakeWorkerState> = { debatePartners: { partners: [{ tokenId: '5', name: 'Nori' }, { tokenId: '2', name: 'Biscuit' }] },
    relationships: { tokenId: '9', name: 'Pixel', relationships: [{ tokenId: '5', name: 'Nori', stance: 'neutral', breakUntil: null },
      { tokenId: '8', name: 'Mochi', stance: 'strained', breakUntil: null }] } };
  await openPet(page, worker, false, '/pet/9/relationships');
  await expect(page.getByRole('link', { name: 'Invite to debate' })).toHaveCount(1);
  await page.getByRole('link', { name: 'Invite to debate' }).click();
  await expect(page).toHaveURL(/\/pet\/9\?debate=5/);
  await expect(sheet(page)).toBeVisible();
  const pair = sheet(page).getByRole('combobox', { name: 'Debate with' });
  await expect(pair).toHaveValue('5');
  expect(await pair.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent)).toBe('Nori');
});

// ---- the transcript ----

const BYTES = { request: JSON.stringify({ model: 'public', messages: [] }), response: JSON.stringify({ choices: [{ finish_reason: 'stop',
  message: { content: 'A line' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }) };
const TEXTS = [
  'Absolutely. Puddles are tiny mirrors, and a parade gives them something worth reflecting.',
  'A parade would splash everyone. I would rather lend each puddle a quiet lantern.',
  'Then let the lanterns lead. Even a quiet parade can have a little drum.',
  'One small drum, then. The rain can keep the rhythm.',
];
const YOCTO = ['180000000000000000000', '170000000000000000000', '190000000000000000000', '160000000000000000000'];
const TX = '6VJXsf3nL3uGi7kJKBjHLgZE7sLjGpVvT45q9dtp6dg5';
const PRIVATE_KEY = new Uint8Array(32).fill(1);
const SIGNER = `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(PRIVATE_KEY, false).slice(1)).slice(-20)).toString('hex')}`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** A line whose bytes, signature and chain receipt agree, as the Worker would return and NEAR would hold them. */
function proofFor(order: number) {
  const call = { req_sha256: sha(BYTES.request), res_sha256: sha(BYTES.response), signature: '', sig_kind: 'gateway',
    signer: SIGNER, tokens_in: 12, tokens_out: 4, tokens_reasoning: 0, cut: false };
  const message = new TextEncoder().encode(`${call.req_sha256}:${call.res_sha256}`);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const signed = new Uint8Array([...prefix, ...message]);
  const sig = secp256k1.sign(keccak_256(signed), PRIVATE_KEY);
  call.signature = `0x${Buffer.from(new Uint8Array([...sig.toCompactRawBytes(), 27 + sig.recovery!])).toString('hex')}`;
  const speaker = order % 2 ? '9' : '5';
  const receipt = { token_id: speaker, debate_id: ID, line_order: order, price: YOCTO[order - 1], model: 'public', calls: [call] };
  const env = buildEnvFor('e2e');
  const outcome = { status: { SuccessValue: '' }, transaction: { signer_id: env.VITE_SERVER_ACCOUNT_ID, receiver_id: env.VITE_CONTRACT_ID,
    actions: [{ FunctionCall: { method_name: 'debit_session', args: Buffer.from(JSON.stringify({ token_id: speaker,
      thoughts: [{ debate: { id: ID, line_order: order } }] })).toString('base64') } }] },
  receipts_outcome: [{ outcome: { logs: [`EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', event: 'receipt', data: receipt })}`] } }] };
  return { call, outcome };
}
const settledLine = (index: number, withBytes = false): DebateLineRead => {
  const proof = proofFor(index + 1);
  return { order: index + 1, speakerPet: index % 2 ? '5' : '9', status: 'settled', text: TEXTS[index]!,
    requestBytes: withBytes ? Buffer.from(BYTES.request).toString('base64') : null,
    responseBytes: withBytes ? Buffer.from(BYTES.response).toString('base64') : null,
    signedCall: withBytes ? JSON.stringify({ model: 'public', ...proof.call }) : null,
    receiptTxHash: TX, priceYocto: YOCTO[index]!, nearUsdRate: '2.45' };
};
const debate = (status: DebateRead['status'], lines: DebateLineRead[], extra: Partial<DebateRead> = {}): DebateRead => ({
  id: ID, status, topic: TOPIC, firstPet: { tokenId: '9', name: 'Pixel' }, secondPet: { tokenId: '5', name: 'Nori' }, openerPet: '9',
  code: CODE, analyticsId: 'c'.repeat(64), lines, ...extra,
});
const four = (withBytes = false) => [0, 1, 2, 3].map((i) => settledLine(i, withBytes));
const openDebate = (page: Page, read: DebateRead | { fail: { status: number; code: string } }, extra: Partial<FakeWorkerState> = {}, auth: FakeState['auth'] | null = SIGNED_IN, rpc?: FakeState['rpc']) =>
  openWith(page, `/debate#${CODE}`, { ...(auth ? { auth } : {}), ...(rpc ? { rpc } : {}),
    worker: { owned: ['9'], pets: { '9': PIXEL, '5': NORI, '2': BISCUIT }, debateRead: read, ...extra } });

// spec: add-debates › Debate transcript screen › success
// spec: add-debates › Debate transcript screen › success × Check this line
// spec: add-debates › Debate transcript screen › success × Debate invitation back
// spec: add-debates › Debate playtest data › link opened
test('transcript success: four lines in order with their costs, Check this line on each, Back to Pixel, no Stop', async ({ page }) => {
  await openDebate(page, debate('completed', four()));
  await expect(page.getByText('Debate complete').first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: TOPIC })).toBeVisible();
  const lines = page.getByRole('list', { name: 'Debate lines' }).getByRole('listitem');
  await expect(lines).toHaveCount(4);
  for (const [i, text] of TEXTS.entries()) await expect(lines.nth(i)).toContainText(text);
  await expect(lines.nth(0)).toContainText('0.04¢');
  await expect(lines.nth(0)).toContainText('0.00018 NEAR');
  await expect(lines.nth(2)).toContainText('0.05¢');
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Stop debate' })).toHaveCount(0);
  await expect.poll(async () => (await calls(page)).includes('worker:debateOpen:debate_link_opened')).toBe(true);
  expect((await calls(page)).filter((c) => c === 'worker:debateOpen:debate_link_opened')).toHaveLength(1);
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-debates › Debate transcript screen › empty
// spec: add-debates › Debate transcript screen › empty × Debate invitation back
test('transcript empty: both names and the topic, no line control, back to the Pet screen', async ({ page }) => {
  await openDebate(page, debate('accepted', []));
  await expect(page.getByText('No lines yet. The pets are getting ready.').first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: TOPIC })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
});

// spec: add-debates › Debate transcript screen › loading
// spec: add-debates › Debate transcript screen › loading × read controls inactive
// spec: add-debates › Debate transcript screen › loading × Debate invitation back
test('transcript loading: says so, shows no receipt and keeps only the way back', async ({ page }) => {
  await openDebate(page, debate('completed', four()), { debateSharedDelayMs: 3_600_000 });
  await expect(page.getByText('Loading debate…').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop debate' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Go home' })).toBeVisible();
  await page.getByRole('link', { name: 'Go home' }).click();
  await expect(page).toHaveURL(/\/$/);
});

// spec: add-debates › Debate transcript screen › error
// spec: add-debates › Debate transcript screen › error × Try again
// spec: add-debates › Debate transcript screen › error × Debate invitation back
test('transcript error: says it could not load, Try again reads it once more', async ({ page }) => {
  await openDebate(page, fail(503, 'unavailable'));
  await expect(page.getByText('Could not load this debate. Try again.').first()).toBeVisible();
  await setWorker(page, { debateRead: debate('completed', four()) });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Debate complete').first()).toBeVisible();
});

// spec: add-debates › Debate transcript screen › deleted shared link
// spec: add-debates › Debate transcript screen › deleted shared link × Go home
// spec: add-debates › Debate transcript screen › deleted shared link × Debate invitation back
test('transcript deleted: says it is no longer available, Go home leaves and there is no retry', async ({ page }) => {
  await openDebate(page, fail(404, 'not_found'), {}, null);
  await expect(page.getByText('This debate is no longer available.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await page.getByRole('main').getByRole('link', { name: 'Go home' }).click();
  await expect(page).toHaveURL(/\/$/);
});

// spec: add-debates › Debate transcript and deletion data › clear before first line
test('after a memory clear a visitor finds no transcript and no words at the link', async ({ page }) => {
  await openDebate(page, fail(404, 'not_found'), { debateCleared: { id: ID, status: 'cleared', endReason: 'memory_clear' } }, null);
  await expect(page.getByText('This debate is no longer available.').first()).toBeVisible();
  await expect(page.getByText(TOPIC)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(0);
  expect((await calls(page)).filter((c) => c === 'worker:debateCleared')).toHaveLength(0);
});

// spec: add-debates › Debate transcript and deletion data › clear during a line
test('after a memory clear the signed-in owner is told the debate ended, with no words', async ({ page }) => {
  await openDebate(page, fail(404, 'not_found'), { debateCleared: { id: ID, status: 'cleared', endReason: 'memory_clear' } });
  await expect(page.getByText('Debate ended after memory was cleared.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(0);
});

// spec: add-debates › Debate transcript screen › signed-out
// spec: add-debates › Debate transcript screen › signed-out × Sign in return with fragment
// spec: add-debates › Debate transcript screen › signed-out × Debate invitation back
// spec: add-debates › Debate consent and access data › visitor reads published link × sign-out
test('transcript signed-out: topic, lines and Check this line without private data, Sign in keeps the fragment', async ({ page }) => {
  await openDebate(page, debate('completed', four()), {}, null);
  await expect(page.getByText('Debate complete').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Stop debate' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(async () => (await calls(page)).includes('privy:login')).toBe(true);
  expect(new URL(page.url()).hash).toBe(`#${CODE}`);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

// spec: add-debates › Debate transcript screen › asleep
// spec: add-debates › Debate transcript screen › asleep × Debate invitation back to Feed {name}
// spec: add-debates › Debate transcript screen › asleep × existing Pet feed after back
test('transcript asleep: paid lines stay, the end is named and Pixel can be fed on its Pet screen', async ({ page }) => {
  await openDebate(page, debate('unavailable', four().slice(0, 2), { endReason: 'asleep' }), { pets: { '9': { ...PIXEL, fullness: ASLEEP_FULLNESS }, '5': NORI } });
  await expect(page.getByText('Pixel fell asleep. This debate has ended.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(2);
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByRole('button', { name: 'Feed Pixel' }).first()).toBeVisible();
});

// spec: add-debates › Debate turn flow › started
// spec: add-debates › Debate turn flow › owner stops
test('an owner sees Stop debate between lines and the stopped debate keeps its paid lines', async ({ page }) => {
  await openDebate(page, debate('running', four().slice(0, 1)));
  await expect(page.getByRole('button', { name: 'Stop debate' })).toBeVisible();
  await setWorker(page, { debateRead: debate('stopped', four().slice(0, 2)) });
  await page.getByRole('button', { name: 'Stop debate' }).click();
  await expect(page.getByText('Stopped by an owner').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(2);
  expect(await countOf(page, 'worker:debateStop')).toBe(1);
});

// spec: add-debates › Debate turn flow › receipt pending × tab hidden and back
// spec: add-debates › Debate turn flow › receipt pending
test('a line waits as Receipt pending and becomes checkable when the tab looks again', async ({ page }) => {
  const pending: DebateLineRead = { ...settledLine(1), status: 'receipt_pending', receiptTxHash: null, priceYocto: null, nearUsdRate: null };
  await openDebate(page, debate('running', [settledLine(0), pending]));
  await expect(page.getByText('Receipt pending')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(1);
  await setWorker(page, { debateRead: debate('running', four().slice(0, 2)) });
  await lookAgain(page);
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(2);
  await expect(page.getByText('Receipt pending')).toHaveCount(0);
});

// spec: add-debates › Debate turn flow › settled line × sign-out retains public check
// spec: add-debates › Debate turn flow › settled line × reload
// spec: add-debates › Debate receipt disclosure data › visitor checks line × sign-out/gift/reload
// spec: add-debates › Debate consent and access data › visitor reads published link × gift/reload/hidden-back
// spec: add-debates › Debate consent and access data › visitor reads published link × session expiry
// spec: add-debates › Debate consent and access data › visitor reads published link × copy/open fragment
// spec: add-debates › Debate consent and access data › visitor reads published link × site data erased
test('a visitor keeps reading and checking after the session ends, a gift, a reload and erased site data', async ({ page }) => {
  await openDebate(page, debate('running', four().slice(0, 2)));
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(2);
  await setWorker(page, { sessionExpired: true, owned: [] });
  await lookAgain(page);
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(2);
  await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
  await reloadHolding(page);
  await expect(page.getByRole('link', { name: 'Check this line' })).toHaveCount(2);
  expect(new URL(page.url()).hash).toBe(`#${CODE}`);
});

// spec: add-debates › Debate receipt disclosure data › visitor checks line
// spec: add-debates › Debate playtest data › receipt opened
test('Check this line compares the exact bytes and signature with the chain receipt', async ({ page }) => {
  const proof = proofFor(1);
  await openDebate(page, debate('completed', four(true)), {}, null, { outcomes: { [TX]: proof.outcome } });
  await page.getByRole('link', { name: 'Check this line' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/debate/verify/1#${CODE}$`));
  await expect(page.getByText('The signature and the receipt here are real.')).toBeVisible();
  await expect(page.getByText('Request and reply match the receipt on NEAR')).toBeVisible();
  await expect(page.getByText("Signed by this key — this page doesn't say whose key it is.")).toBeVisible();
});

// spec: add-debates › Debate playtest data › receipt opened
test('opening a receipt link sends the opaque receipt event once, never the code', async ({ page }) => {
  await openDebate(page, debate('completed', four(true)), {}, null);
  await page.getByRole('link', { name: 'Check this line' }).first().click();
  await expect.poll(async () => (await calls(page)).filter((c) => c === 'worker:debateOpen:debate_receipt_opened').length).toBe(1);
  expect((await calls(page)).join('\n')).not.toContain(CODE);
});
