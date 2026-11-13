// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PetView } from '../seams/worker-types';
import { WorkerError } from '../seams/worker-types';
import { useInvitationExperience } from './InvitationExperience';
import { saveDraft } from './draft';

const mocks = vi.hoisted(() => ({
  auth: { authenticated: true, sessionEnded: false, nearAccountId: 'owner.near', needSession: vi.fn(() => false) },
  api: {
    debatePartners: vi.fn(), pet: vi.fn(), debateEligibility: vi.fn(), debateIncoming: vi.fn(),
    debateRecords: vi.fn(), debateRead: vi.fn(), debateInvite: vi.fn(), debateDecision: vi.fn(),
  },
  signIn: vi.fn(),
}));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('../signin/signIn', () => ({ useSignIn: () => ({ begin: mocks.signIn }) }));
vi.mock('../seams/worker', async () => ({ workerApi: mocks.api, WorkerError: (await import('../seams/worker-types')).WorkerError }));
vi.mock('../pet/PetFigure', async (importOriginal) => ({ ...await importOriginal<typeof import('../pet/PetFigure')>(),
  PetFigure: ({ name }: { name: string }) => <span data-pet={name} /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pixel = { tokenId: '9', name: 'Pixel', memoryEpoch: 0, fullness: { state: 'full', level: 1 } } as Extract<PetView, { viewer: 'owner' }>;
const ownerLost = vi.fn();
const tokenOf = async () => 'token';
let host: HTMLElement;
let root: Root;

function Harness({ preselect, pet = pixel }: { preselect?: string; pet?: typeof pixel }) {
  const debate = useInvitationExperience({ pet, tokenOf, preselect, onOwnerLost: ownerLost });
  return <><button onClick={debate.open}>open</button>{debate.cards}{debate.status}{debate.sheet}
    {debate.pastDebateCode ? <span data-testid="past-code">{debate.pastDebateCode}</span> : null}</>;
}

async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  sessionStorage.clear();
  mocks.auth.authenticated = true;
  mocks.auth.sessionEnded = false;
  mocks.auth.nearAccountId = 'owner.near';
  mocks.api.debatePartners.mockResolvedValue({ partners: [{ tokenId: '5', name: 'Nori' }] });
  mocks.api.pet.mockResolvedValue({ tokenId: '5', name: 'Nori' });
  mocks.api.debateEligibility.mockResolvedValue({ eligible: true, firstPet: { tokenId: '9', name: 'Pixel' }, secondPet: { tokenId: '5', name: 'Nori' }, maxPerPetNear: '0.01', estimatePerPetCents: 0.15 });
  mocks.api.debateIncoming.mockResolvedValue({ ids: [] });
  mocks.api.debateRecords.mockResolvedValue({ records: [] });
  mocks.api.debateRead.mockResolvedValue({ id: 'a'.repeat(64), status: 'invited', topic: 'Rain?', firstPet: { tokenId: '9', name: 'Pixel' },
    secondPet: { tokenId: '5', name: 'Nori' }, openerPet: '9', maxPerPetNear: '0.01', estimatePerPetCents: 0.15 });
  mocks.api.debateInvite.mockResolvedValue({ id: 'a'.repeat(64), status: 'invited', expiresAt: Date.now() + 1000 });
  mocks.api.debateDecision.mockResolvedValue({ id: 'a'.repeat(64), status: 'accepted', code: 'b'.repeat(32) });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

// spec: add-debates › Debate invitation screen › success
// spec: add-debates › Debate invitation flow › invited
it('checks the selected pair and sends the exact edited topic and opener only after consent notice', async () => {
  await act(async () => root.render(<Harness preselect="5" />));
  await settle();
  await settle();
  expect(host.textContent).toContain('Start a debate');
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Close')).toBe(true);
  expect(host.textContent).toContain('About 0.15¢ per pet');
  expect(host.querySelector<HTMLInputElement>('input[type="text"]')?.placeholder).toBe('e.g. Is rain better than sunshine?');
  expect(host.querySelector<HTMLInputElement>('input[type="text"]')?.labels?.[0]?.textContent).toBe('Topic');
  expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Who speaks first');
  expect(host.textContent).toContain('Each pet can spend up to 0.01 NEAR on two lines.');
  expect(host.textContent).toContain('Write a topic in 140 characters or less.');
  const topic = host.querySelector<HTMLInputElement>('input[type="text"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(topic, 'Rain?');
    topic.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  const send = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send invitation')!;
  expect(send.disabled).toBe(false);
  await act(async () => send.click());
  expect(mocks.api.debateInvite).toHaveBeenCalledWith('token', { firstPet: '9', secondPet: '5', openerPet: '9', topic: 'Rain?' });
  expect(host.textContent).toContain('Invitation sent. Waiting for the other owner.');
});

// spec: add-debates › Debate invitation card screen › success
// spec: add-debates › Debate invitation flow › accepted
it('loads an incoming private card from its opaque id and accepts only on a tap', async () => {
  mocks.api.debateIncoming.mockResolvedValue({ ids: ['a'.repeat(64)] });
  await act(async () => root.render(<Harness />));
  await settle();
  expect(host.textContent).toContain('Rain?');
  expect(host.textContent).toContain('Debate invitation');
  expect(host.textContent).toContain('About 0.30¢ for both pets');
  expect(host.textContent).toContain('Anyone with the link may read the topic and lines.');
  expect(mocks.api.debateDecision).not.toHaveBeenCalled();
  const accept = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Accept debate')!;
  await act(async () => accept.click());
  expect(mocks.api.debateDecision).toHaveBeenCalledWith('token', 'a'.repeat(64), 'accept');
  expect(host.textContent).toContain('Debate accepted');
});

// spec: add-debates › Debate transcript and deletion data › gift after paid line
it('labels a retained record for a new owner as Past debates', async () => {
  mocks.api.debateRecords.mockResolvedValue({ records: [{ id: 'a'.repeat(64), status: 'gift', side: 'recipient', retained: true }] });
  mocks.api.debateRead.mockResolvedValue({ id: 'a'.repeat(64), status: 'gift', code: 'b'.repeat(32) });
  await act(async () => root.render(<Harness />));
  await settle();
  expect(host.textContent).toContain('Past debates');
  expect(host.querySelector('a[href="/debate#' + 'b'.repeat(32) + '"]')?.textContent).toBe('Past debates');
  expect(host.querySelector('[data-testid="past-code"]')?.textContent).toBe('b'.repeat(32));
});

// spec: add-debates › Debate transcript and deletion data › gift after paid line
it('keeps the retained Friends entry when a newer unrelated status arrives', async () => {
  mocks.api.debateRecords.mockResolvedValue({ records: [
    { id: 'c'.repeat(64), status: 'declined', side: 'proposer' },
    { id: 'a'.repeat(64), status: 'gift', side: 'recipient', retained: true },
  ] });
  mocks.api.debateRead.mockImplementation(async (_token: string, id: string) => ({ id, status: id === 'a'.repeat(64) ? 'gift' : 'declined',
    ...(id === 'a'.repeat(64) ? { code: 'b'.repeat(32) } : {}) }));
  await act(async () => root.render(<Harness />));
  await settle();
  expect(host.textContent).toContain('Invitation declined');
  expect(host.querySelector('[data-testid="past-code"]')?.textContent).toBe('b'.repeat(32));
});

// spec: add-debates › Debate invitation flow › expired × visibility return
it('replaces an older displayed status when the server has a newer debate record', async () => {
  mocks.api.debateRecords.mockResolvedValue({ records: [{ id: 'a'.repeat(64), status: 'declined', side: 'proposer' }] });
  await act(async () => root.render(<Harness />));
  await settle();
  expect(host.textContent).toContain('Invitation declined');
  mocks.api.debateRecords.mockResolvedValue({ records: [{ id: 'c'.repeat(64), status: 'expired', side: 'proposer' }] });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await settle();
  expect(host.textContent).toContain('Invitation expired');
  expect(host.textContent).not.toContain('Invitation declined');
});

// spec: add-debates › Debate invitation flow › accepted × visibility return
it('keeps a local accept result that happened after a status read began', async () => {
  mocks.api.debateIncoming.mockResolvedValue({ ids: ['a'.repeat(64)] });
  await act(async () => root.render(<Harness />));
  await settle();
  let finishDecision!: (value: { id: string; status: 'accepted'; code: string }) => void;
  mocks.api.debateDecision.mockReturnValueOnce(new Promise((resolve) => { finishDecision = resolve; }));
  const accept = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Accept debate')!;
  await act(async () => accept.click());
  let finish!: (value: { records: Array<{ id: string; status: 'declined'; side: 'proposer' }> }) => void;
  mocks.api.debateRecords.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => finishDecision({ id: 'a'.repeat(64), status: 'accepted', code: 'b'.repeat(32) }));
  expect(host.textContent).toContain('Debate accepted');
  await act(async () => finish({ records: [{ id: 'c'.repeat(64), status: 'declined', side: 'proposer' }] }));
  await settle();
  expect(host.textContent).toContain('Debate accepted');
  expect(host.textContent).not.toContain('Invitation declined');
});

// spec: add-debates › Debate invitation flow › invited
it('names the other pet while a pair invitation is already open', async () => {
  mocks.api.debateEligibility.mockRejectedValue(new WorkerError(409, 'open_pair_invitation'));
  await act(async () => root.render(<Harness preselect="5" />));
  await settle();
  expect(host.textContent).toContain("Waiting for Nori's owner to answer your last invitation.");
});

// spec: add-debates › Debate turn flow › active society refusal
it('names the pet whose society refusal blocked the pair', async () => {
  mocks.api.debateEligibility.mockRejectedValue(new WorkerError(409, 'society_refusal', { petId: '5' }));
  await act(async () => root.render(<Harness preselect="5" />));
  await settle();
  expect(host.textContent).toContain('Nori does not want to meet today.');
});

// spec: add-debates › Debate invitation screen › success
// spec: add-debates › Debate invitation card screen › success
it('uses the live estimate in both consent surfaces', async () => {
  mocks.api.debateEligibility.mockResolvedValue({ eligible: true, firstPet: { tokenId: '9', name: 'Pixel' },
    secondPet: { tokenId: '5', name: 'Nori' }, maxPerPetNear: '0.01', estimatePerPetCents: 0.19 });
  mocks.api.debateIncoming.mockResolvedValue({ ids: ['a'.repeat(64)] });
  mocks.api.debateRead.mockResolvedValue({ id: 'a'.repeat(64), status: 'invited', topic: 'Rain?',
    firstPet: { tokenId: '9', name: 'Pixel' }, secondPet: { tokenId: '5', name: 'Nori' },
    openerPet: '9', estimatePerPetCents: 0.19 });
  await act(async () => root.render(<Harness preselect="5" />));
  await settle();
  await settle();
  expect(host.textContent).toContain('About 0.19¢ per pet');
  expect(host.textContent).toContain('About 0.38¢ for both pets');
  expect(host.textContent).not.toContain('About 0.15¢');
});

// spec: add-debates › Debate invitation card screen › loading
it('keeps acceptance disabled before the incoming status is checked', async () => {
  mocks.api.debateIncoming.mockReturnValue(new Promise(() => undefined));
  await act(async () => root.render(<Harness />));
  const accept = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Accept debate')!;
  expect(host.textContent).toContain('Checking invitation…');
  expect(accept.disabled).toBe(true);
  expect(mocks.api.debateDecision).not.toHaveBeenCalled();
});

// spec: D-166 › failed invitation read with no known invitation
it('shows no invitation card when both lists fail before any invitation was known', async () => {
  mocks.api.debateIncoming.mockRejectedValue(new WorkerError(503, 'chain_unreachable'));
  mocks.api.debateRecords.mockRejectedValue(new WorkerError(503, 'chain_unreachable'));
  await act(async () => root.render(<Harness />));
  await settle();
  expect(host.textContent).not.toContain('Debate invitation');
  expect(host.textContent).not.toContain('Could not check this invitation');
});

// spec: D-166 › failed invitation read after a known invitation
it('keeps the retry card when a previously known invitation cannot be checked', async () => {
  mocks.api.debateIncoming.mockResolvedValue({ ids: ['a'.repeat(64)] });
  await act(async () => root.render(<Harness />));
  await settle();
  expect(host.textContent).toContain('Rain?');
  mocks.api.debateIncoming.mockRejectedValue(new WorkerError(503, 'chain_unreachable'));
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await settle();
  expect(host.textContent).toContain('Could not check this invitation');
});

// Bug: every 10-second refresh put «Checking invitation…» into the conversation for the length of the read, so the
// chat jumped every 10 seconds with no invitation at all.
it('shows the checking card on the first read only, never on the 10-second refresh', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(host.textContent).not.toContain('Checking invitation…');
    mocks.api.debateIncoming.mockReturnValue(new Promise(() => undefined));
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(mocks.api.debateIncoming).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('Checking invitation…');
  } finally { vi.useRealTimers(); }
});

// spec: add-debates › Debate invitation card screen › signed-out
it('hides the private card and offers sign-in when the pet opens with an expired session', async () => {
  // a page opened with an expired session is a visitor's: the session keeper reports it signed out
  mocks.auth.authenticated = false;
  mocks.auth.sessionEnded = true;
  await act(async () => root.render(<Harness />));
  expect(host.textContent).toContain('Sign in to see your invitations.');
  expect(host.textContent).not.toContain('Rain?');
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Sign in')!.click());
  expect(mocks.signIn).toHaveBeenCalledWith('signin');
});

// spec: add-account › Session expiry flow › session ended, no tap yet
it('keeps the incoming card as it stood when the session ends under the open page; Accept asks for the session and sends nothing', async () => {
  mocks.api.debateIncoming.mockResolvedValue({ ids: ['a'.repeat(64)] });
  await act(async () => root.render(<Harness />));
  await settle();
  expect(host.textContent).toContain('Rain?');
  mocks.auth.sessionEnded = true;
  await act(async () => root.render(<Harness />));
  await settle();
  expect(host.textContent).toContain('Rain?');
  expect(host.textContent).not.toContain('Sign in to see your invitations.');
  const accept = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Accept debate')!;
  await act(async () => accept.click());
  expect(mocks.auth.needSession).toHaveBeenCalled();
  expect(mocks.api.debateDecision).not.toHaveBeenCalled();
});

// spec: add-debates › Debate invitation screen › signed-out
it('restores an unsent topic in the same tab without sending after session expiry', async () => {
  saveDraft({ accountId: 'owner.near', tokenId: '9', epoch: 0, selectedPet: '5', topic: 'Rain?', openerPet: '9', open: true });
  mocks.auth.sessionEnded = true;
  await act(async () => root.render(<Harness />));
  await settle();
  expect(host.textContent).toContain('Sign in to invite these pets.');
  expect(host.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Rain?');
  expect(mocks.api.debateInvite).not.toHaveBeenCalled();
});

// spec: add-debates › Debate invitation screen › signed-out × gift
it('does not show the former owner’s draft to a new signed-in owner of the same pet', async () => {
  saveDraft({ accountId: 'former.near', tokenId: '9', epoch: 0, selectedPet: '5', topic: 'Private rain?', openerPet: '9', open: true });
  mocks.auth.nearAccountId = 'new-owner.near';
  await act(async () => root.render(<Harness />));
  await settle();
  expect(host.textContent).not.toContain('Private rain?');
  await act(async () => host.querySelector('button')!.click());
  await settle();
  expect(host.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('');
});

// spec: add-debates › Debate invitation card screen › asleep
it('uses a plain message for an asleep invitation card', async () => {
  mocks.api.debateIncoming.mockResolvedValue({ ids: ['a'.repeat(64)] });
  await act(async () => root.render(<Harness pet={{ ...pixel, fullness: { state: 'asleep', level: 0 } }} />));
  await settle();
  expect(host.textContent).toContain('Pixel is asleep. Feed Pixel before accepting.');
  expect(host.querySelector('.ds-debate-invitation .ds-note--status')).toBeNull();
});
