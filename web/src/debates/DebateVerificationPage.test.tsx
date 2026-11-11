// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkerError } from '../seams/worker-types';
import { DebateVerificationPage } from './DebateVerificationPage';

const mocks = vi.hoisted(() => ({ readShared: vi.fn(), verifyDebateLine: vi.fn() }));
vi.mock('./share', () => ({ readShared: mocks.readShared }));
vi.mock('./proof', () => ({ verifyDebateLine: mocks.verifyDebateLine }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const code = 'b'.repeat(32);
const read = { id: 'a'.repeat(64), firstPet: { tokenId: '9', name: 'Pixel' },
  lines: [{ order: 1, speakerPet: '9', status: 'settled', requestBytes: 'e30=', responseBytes: 'e30=',
    signedCall: 'e30=', receiptTxHash: 'c'.repeat(64), priceYocto: '1' }] };
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); vi.clearAllMocks(); });

// spec: add-debates › Debate transcript and deletion data › clear after publication × hidden and back
it.each(['visibilitychange', 'pageshow'])('replaces an open proof with unavailable after %s', async (eventName) => {
  mocks.readShared.mockResolvedValue(read);
  mocks.verifyDebateLine.mockResolvedValue({ kind: 'too-old' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<DebateVerificationPage code={code} order={1} />));
  await settle();
  expect(host.textContent).toContain('Too old to check here.');
  mocks.readShared.mockRejectedValue(new WorkerError(404, 'not_found'));
  const event = new Event(eventName);
  if (eventName === 'pageshow') Object.defineProperty(event, 'persisted', { value: true });
  await act(async () => (eventName === 'pageshow' ? window : document).dispatchEvent(event));
  await settle();
  expect(host.textContent).toContain('This debate is no longer available.');
  expect(host.textContent).not.toContain('Too old to check here.');
});
