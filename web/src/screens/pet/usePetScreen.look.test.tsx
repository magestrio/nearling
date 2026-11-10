// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../../seams/auth-context';
import { WorkerError, type PetState, type PetView } from '../../seams/worker-types';
import { FORMER_OWNER_LINE, usePetScreen } from './usePetScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ pet: vi.fn(), petState: vi.fn(), conversation: vi.fn() }));
vi.mock('../../seams/worker', async (original) => ({
  ...(await original<typeof import('../../seams/worker')>()),
  workerApi: { pet: mocks.pet, petState: mocks.petState, conversation: mocks.conversation },
}));

const OWNER = {
  viewer: 'owner',
  tokenId: '9',
  name: 'Pixel',
  stage: 'adult',
  fullness: { state: 'full', level: 1 },
  mood: 'happy',
  worn: 'thinking-cap',
  traits: [],
  energy: 7,
  tired: false,
  paused: false,
  hello: false,
  memoryEpoch: 0,
  wakes: 0,
  diaryUnread: false,
  pendingQuestion: false,
  pendingJob: null,
  ownedCount: 1,
  outfits: ['thinking-cap', 'daisy-crown'],
  notices: [],
  myFeed: null,
} as unknown as PetView;
const stateWith = (worn: string): PetState => ({ ...OWNER, viewer: undefined, worn, memoryEpoch: 0, wakes: 0, events: [], pendingJob: null }) as unknown as PetState;

const auth = {
  ready: true,
  authenticated: true,
  nearAccountId: 'a'.repeat(64),
  async getIdentityToken() {
    return 'identity-token';
  },
  sessionEnded: false,
  sessionLine: false,
  endSession() {},
  needSession: () => true,
} as unknown as AuthApi;

let root: Root | null = null;
let screen: ReturnType<typeof usePetScreen>;
function Probe() {
  screen = usePetScreen('9', null);
  return null;
}
const worn = () => (screen.page.kind === 'pet' && screen.page.pet.viewer === 'owner' ? screen.page.pet.worn : undefined);
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.pet.mockResolvedValue(OWNER);
  // the owner's page looks at the state once on load: the errand is in the state only (`Errand flow` › «tab closed while away»)
  mocks.petState.mockResolvedValue(stateWith('thinking-cap'));
  mocks.conversation.mockResolvedValue({ lines: [], more: false, before: null });
  window.history.replaceState(null, '', '/pet/9');
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe('look: a read the screen asks for', () => {
  // spec: add-game-layout › Pet stage rule › guest entries × owner-to-guest read
  it('replaces the owner view and drops the private conversation after ownership changes', async () => {
    await act(async () => {
      root = createRoot(document.createElement('div'));
      root.render(<AuthContext.Provider value={auth}><Probe /></AuthContext.Provider>);
    });
    await vi.waitFor(() => expect(screen.page.kind === 'pet' && screen.page.pet.viewer).toBe('owner'));
    await vi.waitFor(() => expect(mocks.petState).toHaveBeenCalledTimes(1));
    await act(async () => screen.setDraft('private draft'));
    mocks.pet.mockResolvedValueOnce({ ...OWNER, viewer: 'guest' });
    mocks.petState.mockRejectedValueOnce(new WorkerError(403, 'not_owner'));
    await act(async () => void screen.look());
    await vi.waitFor(() => expect(screen.page.kind === 'pet' && screen.page.pet.viewer).toBe('guest'));
    expect(screen.draft).toBe('');
    expect(screen.lines).toBeNull();
    expect(screen.notice).toBe(FORMER_OWNER_LINE);
  });

  // spec: add-game-layout › Pet card screen › error (owner changed) × sign-out
  it('does not announce a new owner when the owner simply signs out', async () => {
    await act(async () => {
      root = createRoot(document.createElement('div'));
      root.render(<AuthContext.Provider value={auth}><Probe /></AuthContext.Provider>);
    });
    await vi.waitFor(() => expect(screen.page.kind === 'pet' && screen.page.pet.viewer).toBe('owner'));
    mocks.pet.mockResolvedValueOnce({ ...OWNER, viewer: 'visitor' });
    const signedOut = { ...auth, authenticated: false, getIdentityToken: async () => null } as AuthApi;
    await act(async () => root!.render(<AuthContext.Provider value={signedOut}><Probe /></AuthContext.Provider>));
    await vi.waitFor(() => expect(screen.page.kind === 'pet' && screen.page.pet.viewer).toBe('visitor'));
    expect(screen.notice).not.toBe(FORMER_OWNER_LINE);
  });

  // spec: add-wardrobe › New outfit notice screen › success
  it('follows a poll that was already in flight, so the poll that began before the wear does not leave the old outfit', async () => {
    await act(async () => {
      root = createRoot(document.createElement('div'));
      root.render(
        <AuthContext.Provider value={auth}>
          <Probe />
        </AuthContext.Provider>,
      );
    });
    await vi.waitFor(() => expect(worn()).toBe('thinking-cap'));
    await vi.waitFor(() => expect(mocks.petState).toHaveBeenCalledTimes(1));
    mocks.petState.mockClear();
    const first = deferred<PetState>();
    const second = deferred<PetState>();
    mocks.petState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    // a poll is on its way ...
    await act(async () => void screen.look());
    expect(mocks.petState).toHaveBeenCalledTimes(1);
    // ... when «Wear it» lands and the notice asks for a look: it is not dropped
    await act(async () => void screen.look());
    expect(mocks.petState).toHaveBeenCalledTimes(1);
    // the first answer is from before the wear: the old outfit
    await act(async () => first.resolve(stateWith('thinking-cap')));
    await vi.waitFor(() => expect(mocks.petState).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve(stateWith('daisy-crown')));
    await vi.waitFor(() => expect(worn()).toBe('daisy-crown'));
    expect(mocks.petState).toHaveBeenCalledTimes(2);
  });

  // spec: add-wardrobe › New outfit notice screen › success
  it('with no poll in flight is one poll, as it was', async () => {
    await act(async () => {
      root = createRoot(document.createElement('div'));
      root.render(
        <AuthContext.Provider value={auth}>
          <Probe />
        </AuthContext.Provider>,
      );
    });
    await vi.waitFor(() => expect(worn()).toBe('thinking-cap'));
    await vi.waitFor(() => expect(mocks.petState).toHaveBeenCalledTimes(1));
    mocks.petState.mockClear();
    mocks.petState.mockResolvedValue(stateWith('daisy-crown'));
    await act(async () => void screen.look());
    await vi.waitFor(() => expect(worn()).toBe('daisy-crown'));
    expect(mocks.petState).toHaveBeenCalledTimes(1);
  });
});
