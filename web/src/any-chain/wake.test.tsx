// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../seams/auth-context';
import { announceClear } from '../account/clearMemory';
import type { PetState, PetView } from '../seams/worker-types';
import { usePetScreen } from '../screens/pet/usePetScreen';
import { DepositEntries } from './DepositEntries';

const mocks = vi.hoisted(() => ({ pet: vi.fn(), petState: vi.fn(), conversation: vi.fn(), deposits: vi.fn() }));
vi.mock('../seams/worker', async (original) => ({
  ...(await original<typeof import('../seams/worker')>()),
  workerApi: { pet: mocks.pet, petState: mocks.petState, conversation: mocks.conversation,
    anyChainOwnerDeposits: mocks.deposits },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asleep = { viewer: 'owner', tokenId: '9', name: 'Pixel', stage: 'adult',
  fullness: { state: 'asleep', level: 0 }, mood: null, worn: null,
  traits: [], energy: 7, tired: false, paused: false, hello: false, memoryEpoch: 0,
  wakes: 0, diaryUnread: false, pendingQuestion: false, pendingJob: null,
  ownedCount: 1, outfits: [], notices: [], myFeed: null } as unknown as PetView;
const state = (changes: Partial<PetState> = {}) => ({ ...asleep, events: [], gift: null, ...changes }) as PetState;
const auth = { ready: true, authenticated: true, sessionEnded: false, nearAccountId: 'a'.repeat(64),
  getIdentityToken: async () => 'token', needSession: () => true, endSession: () => undefined } as unknown as AuthApi;
let host: HTMLElement;
let root: Root;
let screen: ReturnType<typeof usePetScreen>;
function Probe() { screen = usePetScreen('9', null); return null; }
beforeEach(() => {
  mocks.pet.mockResolvedValue(asleep);
  mocks.petState.mockResolvedValue(state());
  mocks.conversation.mockResolvedValue({ lines: [], more: false, before: null });
  mocks.deposits.mockResolvedValue({ deposits: [], credits: [] });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  window.history.replaceState(null, '', '/pet/9');
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

// spec: add-any-chain-feed › Cross-chain identity rule › anonymous wake
it('shows the approved wake line with no payer name or thanks', async () => {
  await act(async () => root.render(<AuthContext.Provider value={auth}><Probe /></AuthContext.Provider>));
  await vi.waitFor(() => expect(mocks.petState).toHaveBeenCalled());
  mocks.petState.mockResolvedValueOnce(state({ fullness: { state: 'full', level: 1 }, wakes: 1,
    events: ['woke'], wakeSource: 'cross_chain', friend: 'Maya' }));
  await act(async () => screen.look());
  expect(screen.lines?.map((line) => line.text)).toContain('Food came from another chain.');
  expect(JSON.stringify(screen.lines)).not.toMatch(/Maya|thank/i);
});

// spec: add-any-chain-feed › Cross-chain identity rule › anonymous credit
it('shows a confirmed quote meal as an anonymous event, without a named feeder', async () => {
  mocks.deposits.mockResolvedValueOnce({ deposits: [], credits: [{ id: 'a'.repeat(32), creditId: 7,
    wasAsleep: false, route: 'quote' }] });
  await act(async () => root.render(<AuthContext.Provider value={auth}>
    <DepositEntries tokenId="9" name="Pixel" tokenOf={async () => 'token'} />
  </AuthContext.Provider>));
  expect(host.textContent).toContain('From another chain');
  expect(host.textContent).not.toMatch(/Maya|thank/i);
});

// spec: add-any-chain-feed › Cross-chain retention data › memory cleared
it('keeps the server payment-record notice after memory clear', async () => {
  await act(async () => root.render(<AuthContext.Provider value={auth}><Probe /></AuthContext.Provider>));
  await vi.waitFor(() => expect(mocks.petState).toHaveBeenCalled());
  await act(async () => announceClear({ tokenId: '9', result: 'cleared', hadExperience: false,
    paymentRecordsNotice: 'Payment records stay for recovery. On-chain credits cannot be erased.' }));
  expect(screen.lines?.map((line) => line.text)).toContain('Payment records stay for recovery. On-chain credits cannot be erased.');
});
