// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ cardSource: vi.fn(), cardLines: vi.fn(), render: vi.fn(), event: vi.fn(), share: vi.fn() }));
vi.mock('../seams/worker', async () => ({
  ...(await import('../seams/worker-types')),
  workerApi: { cardSource: mocks.cardSource, cardLines: mocks.cardLines },
}));
vi.mock('./card', () => ({ renderShowcaseCard: mocks.render, shareCardError: "We couldn't make this card. Try again.", showcaseFacts: () => ({ name: 'Pixel', line: 'A thought.', link: 'http://localhost/pet/9' }) }));
vi.mock('./shareEvent', () => ({ sendCardShared: mocks.event }));
vi.mock('../errands/VerdictCard', () => ({ canShareFile: () => true }));

import { WorkerError } from '../seams/worker';
import { usePetCard } from './usePetCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const source = { tokenId: '9', name: 'Pixel', kind: 'thought' as const, thoughtId: 'first', line: 'A thought.' };
const pet = { tokenId: '9', name: 'Pixel', stage: 'baby' as const, worn: null, fullness: { state: 'full' as const }, memoryEpoch: 0 };
let host: HTMLElement;
let root: Root;
let currentPet: Parameters<typeof usePetCard>[0] = pet;
let active = true;

function Harness() {
  const card = usePetCard(currentPet, [], async () => 'token', active);
  return <>{card.entry}{card.sheet}</>;
}

const button = (name: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);
const click = async (target: Element | undefined) => {
  expect(target).toBeTruthy();
  await act(async () => target!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const openThought = async () => { await click(button('Share Pixel')); await click(button('Share a thought')); await settle(); expect(button('Share')).toBeTruthy(); };

beforeEach(async () => {
  currentPet = pet;
  active = true;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.cardLines.mockResolvedValue({ lines: [{ id: 'first', text: 'A thought.' }] });
  mocks.cardSource.mockResolvedValue(source);
  mocks.render.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  mocks.event.mockResolvedValue(undefined);
  mocks.share.mockResolvedValue(undefined);
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  Object.defineProperty(navigator, 'share', { configurable: true, value: mocks.share });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:card' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Pet card delivery', () => {
  // spec: add-showcase › Pet card sharing flow › share image
  it('checks the current source on Share and sends the exact preview when still eligible', async () => {
    await openThought();
    const before = mocks.cardSource.mock.calls.length;
    let checksAtShare = 0;
    mocks.share.mockImplementation(async () => { checksAtShare = mocks.cardSource.mock.calls.length; });
    await click(button('Share'));
    expect(checksAtShare).toBe(before + 1);
    expect(mocks.share).toHaveBeenCalledOnce();
    expect(mocks.share.mock.calls[0]![0].files[0]).toBeInstanceOf(File);
    expect(mocks.event).toHaveBeenCalledWith('token', 'thought', 'share');
  });

  // spec: add-showcase › Pet card sharing flow › ownership changed
  it('does not open native Share after a gift between readiness and the tap', async () => {
    await openThought();
    mocks.cardSource.mockRejectedValueOnce(new WorkerError(403, 'not_owner'));
    await click(button('Share'));
    expect(mocks.share).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Pixel has a new owner. This card can't be shared from here.");
  });

  // spec: add-showcase › Card eligibility rule › memory cleared
  it('does not send erased words after Share was enabled', async () => {
    await openThought();
    mocks.cardSource.mockRejectedValueOnce(new WorkerError(409, 'thought_erased'));
    await click(button('Share'));
    expect(mocks.share).not.toHaveBeenCalled();
    expect(host.textContent).toContain('No thoughts to share yet. Talk with Pixel to hear one.');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  // spec: add-showcase › Pet card sharing flow › share image
  it('offers Share now only after activation refusal and logs the completed retry', async () => {
    await openThought();
    const originalShare = button('Share');
    originalShare?.focus();
    mocks.share.mockRejectedValueOnce(new DOMException('activation expired', 'NotAllowedError'));
    await click(button('Share'));
    expect(button('Share now')).toBeTruthy();
    expect(button('Share now')).toBe(originalShare);
    expect(document.activeElement).toBe(originalShare);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Share now');
    expect(mocks.event).not.toHaveBeenCalled();
    await click(button('Share now'));
    expect(mocks.share).toHaveBeenCalledTimes(2);
    expect(mocks.event).toHaveBeenCalledWith('token', 'thought', 'share');
  });

  // spec: add-showcase › Card eligibility rule › memory cleared
  it('removes Share now when the ready card loses memory', async () => {
    await openThought();
    mocks.share.mockRejectedValueOnce(new DOMException('activation expired', 'NotAllowedError'));
    await click(button('Share'));
    expect(button('Share now')).toBeTruthy();
    currentPet = { ...pet, memoryEpoch: 1 };
    await act(async () => root.render(<Harness />));
    expect(button('Share now')).toBeUndefined();
    expect(mocks.share).toHaveBeenCalledTimes(1);
  });

  // spec: add-showcase › Pet card sharing flow › ownership changed
  it('removes Share now when ownership changes', async () => {
    await openThought();
    mocks.share.mockRejectedValueOnce(new DOMException('activation expired', 'NotAllowedError'));
    await click(button('Share'));
    expect(button('Share now')).toBeTruthy();
    active = false;
    await act(async () => root.render(<Harness />));
    expect(button('Share now')).toBeUndefined();
    expect(mocks.share).toHaveBeenCalledTimes(1);
  });

  // spec: add-showcase › Card eligibility rule › memory cleared
  it('invalidates Share now when focus returns from a tab that cleared memory', async () => {
    await openThought();
    mocks.share.mockRejectedValueOnce(new DOMException('activation expired', 'NotAllowedError'));
    await click(button('Share'));
    mocks.cardSource.mockRejectedValueOnce(new WorkerError(409, 'thought_erased'));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(button('Share now')).toBeUndefined();
    expect(host.textContent).toContain('No thoughts to share yet. Talk with Pixel to hear one.');
    expect(mocks.share).toHaveBeenCalledTimes(1);
  });

  // spec: add-showcase › Pet card source data › selected words erased
  it('rechecks the fallback tap so an erased thought never reaches native Share', async () => {
    await openThought();
    mocks.share.mockRejectedValueOnce(new DOMException('activation expired', 'NotAllowedError'));
    await click(button('Share'));
    expect(button('Share now')).toBeTruthy();
    mocks.cardSource.mockRejectedValueOnce(new WorkerError(409, 'thought_erased'));
    await click(button('Share now'));
    expect(mocks.share).toHaveBeenCalledTimes(1);
    expect(mocks.event).not.toHaveBeenCalled();
    expect(host.textContent).toContain('No thoughts to share yet. Talk with Pixel to hear one.');
  });

  // spec: add-showcase › Pet card sharing flow › no thought to choose
  it('closes the empty sheet when the last listed thought was erased before preview', async () => {
    mocks.cardSource.mockRejectedValueOnce(new WorkerError(409, 'thought_erased'));
    await click(button('Share Pixel'));
    await click(button('Share a thought'));
    await settle();
    expect(host.textContent).toContain('That thought is no longer here. Choose another one.');
    expect(host.textContent).toContain('No thoughts to share yet. Talk with Pixel to hear one.');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.render).not.toHaveBeenCalled();
  });

  // spec: add-showcase › Card eligibility rule › memory cleared
  it('shows the erased notice when the last ready thought disappears on delivery', async () => {
    await openThought();
    mocks.cardSource.mockRejectedValueOnce(new WorkerError(409, 'thought_erased'));
    await click(button('Share'));
    expect(host.textContent).toContain('That thought is no longer here. Choose another one.');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.share).not.toHaveBeenCalled();
  });

  // spec: add-showcase › Pet card source data › selected words erased × worn outfit change
  it('clears fallback readiness and redraws a thought preview when worn outfit changes', async () => {
    await openThought();
    mocks.share.mockRejectedValueOnce(new DOMException('activation expired', 'NotAllowedError'));
    await click(button('Share'));
    expect(button('Share now')).toBeTruthy();
    const draws = mocks.render.mock.calls.length;
    currentPet = { ...pet, worn: 'daisy-crown' };
    await act(async () => root.render(<Harness />));
    expect(button('Share now')).toBeUndefined();
    await settle();
    expect(mocks.render.mock.calls.length).toBeGreaterThan(draws);
    expect(mocks.render.mock.lastCall?.[1]).toMatchObject({ worn: 'daisy-crown' });
  });

  // spec: add-showcase › Pet card source data › selected words erased × growth stage change
  it('clears fallback readiness and redraws a thought preview when growth stage changes', async () => {
    await openThought();
    mocks.share.mockRejectedValueOnce(new DOMException('activation expired', 'NotAllowedError'));
    await click(button('Share'));
    expect(button('Share now')).toBeTruthy();
    const draws = mocks.render.mock.calls.length;
    currentPet = { ...pet, stage: 'teen' };
    await act(async () => root.render(<Harness />));
    expect(button('Share now')).toBeUndefined();
    await settle();
    expect(mocks.render.mock.calls.length).toBeGreaterThan(draws);
    expect(mocks.render.mock.lastCall?.[1]).toMatchObject({ stage: 'teen' });
  });
});
