// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pet: vi.fn(), sharedErrand: vi.fn(), sharedErrandEvent: vi.fn(), closeSharedErrand: vi.fn(), closeApproval: vi.fn(),
  auth: { authenticated: true, ready: true, nearAccountId: 'owner.near', getIdentityToken: vi.fn(), endSession: vi.fn(), signNearHash: vi.fn() },
}));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('../seams/worker', async () => ({
  ...(await import('../seams/worker-types')),
  workerApi: { pet: mocks.pet, sharedErrand: mocks.sharedErrand, sharedErrandEvent: mocks.sharedErrandEvent, closeSharedErrand: mocks.closeSharedErrand },
}));
vi.mock('./sharedApproval', () => ({ closeApproval: mocks.closeApproval }));
vi.mock('../account/AccountControl', () => ({ AccountControl: () => null }));
vi.mock('../feeding/FeedLayer', () => ({ FeedLayer: () => null }));
vi.mock('../feeding/feedFlight', () => ({ onFlight: () => () => undefined }));
vi.mock('../pet/PetFigure', async (importOriginal) => ({ ...(await importOriginal<typeof import('../pet/PetFigure')>()), PetFigure: () => null }));
vi.mock('../pet/flat', () => ({ canUseWebGL: () => false }));
vi.mock('../pet/motion', () => ({ useMotionPaused: () => [true, () => undefined] }));
vi.mock('../signin/signIn', () => ({ useSignIn: () => ({ begin: () => undefined }) }));
vi.mock('../signin/inApp', () => ({ thisBrowser: () => ({ phone: false, inApp: null }) }));
vi.mock('../screens/pet/parts', () => ({ takePendingAction: () => null }));

import { SharedErrandPage } from './SharedErrandPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PET = { name: 'Pixel', stage: 'adult', worn: null, fullness: { state: 'full', level: 12 } };
const WAITING = {
  tokenId: '9', name: 'Pixel', state: 'funding', form: 'find', job: 'When does the next NEAR protocol upgrade ship?',
  viewer: 'visitor', funded: '1350000000000000000000', needed: '4330000000000000000000',
  chainState: 'Funding', fullness: PET.fullness,
};
let host: HTMLElement;
let root: Root | null = null;

async function show(viewer: 'visitor' | 'owner') {
  mocks.sharedErrand.mockResolvedValue({ ...WAITING, viewer });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<SharedErrandPage tokenId="9" code={'c'.repeat(64)} />));
}

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  mocks.pet.mockReset().mockResolvedValue(PET);
  mocks.sharedErrand.mockReset();
  mocks.sharedErrandEvent.mockReset().mockResolvedValue(undefined);
  mocks.closeSharedErrand.mockReset().mockResolvedValue({ ok: true });
  mocks.closeApproval.mockReset().mockResolvedValue({ public_key: 'owner.near', signature: 's' });
  mocks.auth.getIdentityToken.mockReset().mockResolvedValue('token');
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
});

describe('shared errand frame content', () => {
  // spec: add-pet-errands › Shared errand screen › success
  it('puts the meal disclosure beside the job and progress, with Feed in the action area', async () => {
    await show('visitor');
    const words = host.querySelector('.ds-centerpiece__text')!;
    const actions = host.querySelector('.ds-centerpiece__actions')!;
    expect(host.querySelector('.ds-centerpiece--compact')).not.toBeNull();
    expect(words.textContent).toContain('0.62¢ of 2¢ food reserved for this errand');
    expect(words.textContent).toContain("A NEAR meal uses your NEAR. A free snack uses the project's food.");
    expect(actions.textContent).not.toContain('A NEAR meal uses your NEAR.');
    expect(actions.textContent).toContain('Feed Pixel');
  });

  // spec: add-pet-errands › Shared errand screen › owner views a waiting job
  it('puts the owner funding line under progress and offers only share and close', async () => {
    await show('owner');
    const words = host.querySelector('.ds-centerpiece__text')!;
    const actions = host.querySelector('.ds-centerpiece__actions')!;
    expect(host.querySelector('.ds-centerpiece--compact')).not.toBeNull();
    expect(words.textContent).toContain("Friends' food pays for this job");
    expect(actions.textContent).not.toContain("Friends' food pays for this job");
    expect(actions.textContent).toContain('Share job');
    expect(actions.textContent).toContain('Close job');
    expect(actions.textContent).not.toContain('Feed Pixel');
  });
});

// spec: add-pet-errands › Shared errand screen › funding closed
it('drops close confirmation when a new read shows that funding started the job', async () => {
  await show('owner');
  await act(async () => host.querySelector<HTMLButtonElement>('.ds-centerpiece__actions button:last-child')!.click());
  expect(host.textContent).toContain('Confirm close');
  mocks.sharedErrand.mockResolvedValue({ ...WAITING, viewer: 'owner', state: 'running', chainState: 'Running' });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.textContent).toContain('This job is underway or finished.');
  expect(host.textContent).not.toContain('Confirm close');
  expect(mocks.closeSharedErrand).not.toHaveBeenCalled();
});

// spec: add-pet-errands › Friend-funded errand flow › owner confirms closing an unsettled job
it('keeps closing pending after an unknown outcome until a read confirms closure', async () => {
  await show('owner');
  mocks.closeSharedErrand.mockRejectedValue(new Error('timeout'));
  await act(async () => host.querySelector<HTMLButtonElement>('.ds-centerpiece__actions button:last-child')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('.ds-centerpiece__actions button:last-child')!.click());
  expect(host.textContent).toContain('Closing job…');
  expect(host.textContent).not.toContain("We couldn't close this job. Try again.");
  expect(mocks.closeApproval).toHaveBeenCalledTimes(1);
  mocks.sharedErrand.mockResolvedValue({ tokenId: '9', name: 'Pixel', state: 'empty' });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.textContent).toContain('This shared errand is no longer here.');
});

// spec: add-pet-errands › Shared errand screen › funded before start
it('keeps the newest full reserve when an older funding read finishes later', async () => {
  await show('visitor');
  let resolveOlder!: (value: typeof WAITING) => void;
  mocks.sharedErrand.mockImplementationOnce(() => new Promise<typeof WAITING>((resolve) => { resolveOlder = resolve; }))
    .mockResolvedValue({ ...WAITING, funded: WAITING.needed });

  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(host.textContent).toContain('Enough food is already reserved for this errand.');
  expect(host.querySelector('.ds-centerpiece__actions')?.textContent).not.toContain('Feed Pixel');

  await act(async () => { resolveOlder(WAITING); });
  expect(host.textContent).toContain('Enough food is already reserved for this errand.');
  expect(host.querySelector('.ds-centerpiece__actions')?.textContent).not.toContain('Feed Pixel');
});
