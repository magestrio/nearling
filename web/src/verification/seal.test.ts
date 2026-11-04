// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NearRpc } from '../seams/rpc';
import type { VerificationIndex } from '../seams/worker-types';
import { Seal } from '../ds/Verification';
import { characterHash } from './record';
import { readSeal, useSeal } from './seal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ view: vi.fn(), transaction: vi.fn(), index: vi.fn() }));
vi.mock('../config', () => ({ config: { contractId: 'pets.testnet', serverAccountId: 'server.testnet' } }));
vi.mock('../seams/rpc', () => ({ nearRpc: { viewFunction: mocks.view, transaction: mocks.transaction } }));
vi.mock('../seams/worker', () => ({ workerApi: { verificationIndex: mocks.index } }));

const index: VerificationIndex = { tokenId: '9', worn: null, thoughts: [], transactions: [
  { kind: 'birth', ref: 'birth', txHash: 'birth-hash', at: 1 },
] };
const pet = { name: 'Pixel', character: 'Curious and dramatic.' };
const event = (hash: string) => ({ status: { SuccessValue: '' }, transaction: { receiver_id: 'pets.testnet' },
  receipts_outcome: [{ outcome: { logs: [`EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', event: 'pet_born', data: { token_id: '9', character_sha256: hash } })}`] } }] });
const rpc = (): NearRpc => ({ viewFunction: mocks.view, transaction: mocks.transaction } as unknown as NearRpc);

let root: Root | null = null;
let container: HTMLElement;
let state: ReturnType<typeof useSeal>;
function Probe({ keyValue = '' }: { keyValue?: string }) {
  state = useSeal('9', keyValue);
  return createElement('output', null, state.state.kind);
}

beforeEach(async () => {
  mocks.view.mockReset().mockResolvedValue(pet);
  mocks.transaction.mockReset().mockResolvedValue(event(await characterHash(pet.character)));
  mocks.index.mockReset().mockResolvedValue(index);
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
});

describe('Seal of character', () => {
  // spec: add-verification › Seal of character rule › character checked
  it('uses the same symmetric glyph for the chain hash in both sizes', async () => {
    const hash = await characterHash(pet.character);
    const result = await readSeal(rpc(), () => Promise.resolve(index), '9', 'pets.testnet', 'server.testnet');
    expect(result).toEqual({ kind: 'checked', hash });
    await act(async () => { root = createRoot(container); root.render(createElement('div', null,
      createElement(Seal, { hash }), createElement(Seal, { hash, size: 'sm' }))); });
    const marks = [...container.querySelectorAll('[role="img"]')];
    expect(marks).toHaveLength(2);
    const bits = Number.parseInt(hash.slice(0, 4), 16);
    const lit = Array.from({ length: 25 }, (_, n) => (bits >> (Math.floor(n / 5) * 3 + (n % 5 < 3 ? n % 5 : 4 - n % 5))) & 1)
      .reduce((sum, on) => sum + on, 0);
    expect(marks.map((mark) => [...mark.querySelectorAll('.ds-seal__cell--on')].length)).toEqual([lit, lit]);
    for (const mark of marks) {
      const cells = [...mark.querySelectorAll('.ds-seal__cell')];
      for (let row = 0; row < 5; row++) {
        expect(cells[row * 5]?.className).toBe(cells[row * 5 + 4]?.className);
        expect(cells[row * 5 + 1]?.className).toBe(cells[row * 5 + 3]?.className);
      }
    }
  });

  // spec: add-verification › Seal of character rule › character checked
  it('lights the first fifteen bits row by row and mirrors the two right columns', async () => {
    await act(async () => { root = createRoot(container); root.render(createElement(Seal, { hash: '9f2c' })); });
    const cells = [...container.querySelectorAll('.ds-seal__cell')];
    const rows = Array.from({ length: 5 }, (_, r) => cells.slice(r * 5, r * 5 + 5)
      .map((cell) => cell.classList.contains('ds-seal__cell--on') ? '1' : '0').join(''));
    expect(rows).toEqual(['00100', '10101', '00100', '11111', '10001']);
  });

  // spec: add-verification › Seal of character rule › character mismatch
  it('withholds the glyph when the known birth event differs', async () => {
    mocks.transaction.mockResolvedValue(event('f'.repeat(64)));
    expect(await readSeal(rpc(), () => Promise.resolve(index), '9', 'pets.testnet', 'server.testnet'))
      .toEqual({ kind: 'mismatch', hash: null });
  });

  // spec: add-verification › Seal of character rule › character checked
  it('keeps the on-chain Seal when only the server transaction index is unavailable', async () => {
    const hash = await characterHash(pet.character);
    expect(await readSeal(rpc(), () => Promise.reject(new Error('worker offline')), '9', 'pets.testnet', 'server.testnet'))
      .toEqual({ kind: 'checked', hash });
  });

  // spec: add-verification › Seal of character rule › check unavailable
  it('withholds the glyph after a failed chain read, then recovers on Try again', async () => {
    mocks.view.mockRejectedValueOnce(new Error('rpc offline'));
    await act(async () => { root = createRoot(container); root.render(createElement(Probe)); });
    await vi.waitFor(() => expect(state.state.kind).toBe('unavailable'));
    await act(async () => state.retry());
    await vi.waitFor(() => expect(state.state.kind).toBe('checked'));
    expect(mocks.view).toHaveBeenCalledTimes(2);
  });

  // spec: add-verification › Seal of character rule › character checked × pet navigation
  // spec: add-verification › Seal of character rule › character checked × sign-in/out
  // spec: add-verification › Seal of character rule › character mismatch × gift
  it('rereads on a changed page key and does not keep the former owner’s checked mark', async () => {
    await act(async () => { root = createRoot(container); root.render(createElement(Probe, { keyValue: 'owner' })); });
    await vi.waitFor(() => expect(state.state.kind).toBe('checked'));
    mocks.transaction.mockResolvedValue(event('f'.repeat(64)));
    await act(async () => root?.render(createElement(Probe, { keyValue: 'guest' })));
    await vi.waitFor(() => expect(state.state.kind).toBe('mismatch'));
  });
});
