// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PetView, WorkRecord } from '../seams/worker-types';

const { workRecord, viewFunction, experienceRecordOpened } = vi.hoisted(() => ({
  workRecord: vi.fn(), viewFunction: vi.fn(), experienceRecordOpened: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../seams/worker', () => ({ workerApi: { workRecord, experienceRecordOpened } }));
vi.mock('../seams/rpc', () => ({ nearRpc: { viewFunction } }));
vi.mock('../seams/auth', () => ({ useAuth: () => ({ authenticated: false, sessionEnded: false, nearAccountId: null }) }));
vi.mock('../signin/signIn', () => ({ useSignIn: () => ({ begin: vi.fn() }) }));
vi.mock('../pet/PetFigure', async (importOriginal) => ({
  ...await importOriginal<typeof import('../pet/PetFigure')>(), PetFigure: () => null,
}));
vi.mock('../feeding/FeedLayer', () => ({ FeedLayer: () => null }));
vi.mock('../account/clearMemory', () => ({ onClearOutcome: () => () => {} }));
import { WorkRecordPage } from './WorkRecordPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pet: PetView = { viewer: 'visitor', tokenId: '9', name: 'Pixel', stage: 'adult',
  fullness: { state: 'full', level: 1 }, mood: 'calm', worn: null, skill: null };
const record = (completedErrands: number): WorkRecord => ({ tokenId: '9',
  counts: { paidHires: 3, completedErrands, countedSince: Date.UTC(2026, 10, 7) * 1_000_000 },
  field: null, receipts: [] });
const chain = (completedErrands: number) => ({ token_id: '9', paid_hires: 3, completed_errands: completedErrands,
  counted_since: Date.UTC(2026, 10, 7) * 1_000_000 });

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  workRecord.mockReset();
  viewFunction.mockReset();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// spec: add-pet-experience › Work record screen › success × accepted hire / completed errand / 00:00 UTC
it('keeps a slow timed read so its accepted work reaches the open record', async () => {
  let finishSlowRead!: (value: WorkRecord) => void;
  const slowRead = new Promise<WorkRecord>((resolve) => { finishSlowRead = resolve; });
  workRecord.mockResolvedValueOnce(record(5)).mockReturnValueOnce(slowRead).mockResolvedValue(record(7));
  viewFunction.mockResolvedValueOnce(chain(5)).mockResolvedValueOnce(chain(6)).mockResolvedValue(chain(7));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<WorkRecordPage pet={pet} />));
  expect(host.textContent).toContain('Completed errands:5');

  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(workRecord).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(workRecord).toHaveBeenCalledTimes(2);
  await act(async () => { finishSlowRead(record(6)); });
  expect(host.textContent).toContain('Completed errands:6');
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(workRecord).toHaveBeenCalledTimes(3);
  expect(host.textContent).toContain('Completed errands:7');
});
