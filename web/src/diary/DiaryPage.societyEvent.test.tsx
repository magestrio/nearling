// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../seams/auth-context';
import { sampleDiary } from '../seams/diary.sample';
import type { OwnerView, usePetScreen } from '../screens/pet/usePetScreen';
import { DiaryPage } from './DiaryPage';
import type { useDiary } from './useDiary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ seen: vi.fn() }));
vi.mock('../seams/worker', async (original) => ({
  ...(await original<typeof import('../seams/worker')>()),
  workerApi: { societyDiarySeen: mocks.seen },
}));
vi.mock('../pet/PetFigure', async (original) => ({ ...(await original<typeof import('../pet/PetFigure')>()), PetFigure: () => null }));
vi.mock('../signin/SignInOutcome', () => ({ useSignInLines: () => [], SignInLines: () => null }));

const pet = { viewer: 'owner', tokenId: '9', name: 'Pixel', fullness: { state: 'full', level: 1 },
  tired: false, paused: false, stage: 'adult', mood: 'happy', worn: null } as OwnerView;
const auth = { authenticated: true, sessionEnded: false, sessionLine: null,
  getIdentityToken: async () => 'identity-token' } as unknown as AuthApi;
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  vi.clearAllMocks();
});

// spec: add-pet-society › Society playtest data › social diary seen
it('opening a social diary sends one coded event without the line or counterpart', async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  const diary = sampleDiary();
  if (diary.entry.kind !== 'text') throw new Error('sample entry');
  diary.entry.socialLines = ['I think Biscuit and I are getting closer.'];
  const d = { load: { kind: 'ready', diary }, question: '', riddle: null, late: null, sending: false } as ReturnType<typeof useDiary>;
  const s = { asked: null, failure: null, busy: false } as ReturnType<typeof usePetScreen>;
  mocks.seen.mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const page = <AuthContext.Provider value={auth}><DiaryPage pet={pet} d={d} s={s} accent="mint" account={null} banner={null}
    bannerLine="" offline="" covered={false} layer={null} onFeed={() => undefined} /></AuthContext.Provider>;
  await act(async () => root!.render(page));
  expect(host.textContent).toContain('I think Biscuit and I are getting closer.');
  expect(mocks.seen).toHaveBeenCalledOnce();
  expect(mocks.seen.mock.calls[0]![0]).toBe('identity-token');
  expect(mocks.seen.mock.calls[0]![1]).toBe('9');
  const payload = mocks.seen.mock.calls[0]![2] as Record<string, unknown>;
  expect(Object.keys(payload).sort()).toEqual(['eventId', 'petId', 'playerId', 'tabId']);
  expect(JSON.stringify(payload)).not.toMatch(/Biscuit|getting closer|diary|\/pet\/9/);
  await act(async () => root!.render(page));
  expect(mocks.seen).toHaveBeenCalledOnce();
});
