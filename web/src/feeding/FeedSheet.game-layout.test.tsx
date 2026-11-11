// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Phase } from './feedMachine';
import type { FeedSheetData } from '../seams/worker-types';

const mocks = vi.hoisted(() => ({
  phase: null as Phase | null,
  back: vi.fn(),
}));
vi.mock('../seams/auth', () => ({ useAuth: () => ({ needSession: () => true }) }));
vi.mock('./useFeedSheet', () => ({ useFeedSheet: () => ({
  phase: mocks.phase,
  tap: vi.fn(), tryAgain: vi.fn(), addNear: vi.fn(), back: mocks.back, done: vi.fn(),
}) }));
vi.mock('./AddNearSheet', () => ({ AddNearBody: ({ onArrived }: { onArrived: () => void }) =>
  <button type="button" onClick={onArrived}>Simulate arrival</button> }));

import { FeedSheet } from './FeedSheet';
import { addressRequestNow, closeAddress, closePay, payRequestNow } from '../any-chain/request';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const portions = (short: boolean) => [
  { near: '0.01', cents: 5, missing: short ? '0.01' : null },
  { near: '0.05', cents: 23, missing: short ? '0.05' : null },
  { near: '0.2', cents: 92, missing: short ? '0.2' : null },
] as FeedSheetData['portions'];
const sheet = (short: boolean): FeedSheetData => ({
  chain: true,
  name: 'Pixel',
  viewer: 'owner',
  fullness: { state: 'hungry', level: 0.25 },
  wallet: { state: 'some', balance: '310000000000000000000000' },
  portions: portions(short),
  snack: { state: 'none' },
} as FeedSheetData);

let root: Root | null = null;
let host: HTMLElement;
beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
async function render() {
  await act(async () => root!.render(<FeedSheet request={{ tokenId: '9', name: 'Pixel', label: 'Pixel', elsewhere: false }} onClose={() => undefined} column />));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  mocks.phase = null;
  mocks.back.mockReset();
  closePay();
  closeAddress();
});

describe('Feed sheet on the game Stage', () => {
  // spec: add-any-chain-feed › Cross-chain identity rule › anonymous credit
  it('shows confirmed cross-chain food in Feed without payer identity or thanks', async () => {
    mocks.phase = { kind: 'open', sheet: { ...sheet(false), crossChainCredits: [{ id: 'a'.repeat(32),
      creditId: 7, wasAsleep: false, route: 'quote' }] } };
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await render();
    expect(host.textContent).toContain('From another chain');
    expect(host.textContent).not.toMatch(/payer|Maya/i);
  });
  // spec: add-any-chain-feed › Cross-chain quote flow › feed entry
  it('adds two chain entries after NEAR and snacks and routes each to its sheet request', async () => {
    mocks.phase = { kind: 'open', sheet: sheet(false) };
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await render();
    const labels = [...host.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toContain('Pay from another chain');
    expect(labels).toContain("Send USDC to Pixel's address");
    expect(labels.indexOf('Pay from another chain')).toBeGreaterThan(labels.findIndex((label) => label?.includes('free snack')));
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Pay from another chain')!.click());
    expect(payRequestNow()).toMatchObject({ tokenId: '9', name: 'Pixel' });
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === "Send USDC to Pixel's address")!.click());
    expect(addressRequestNow()).toMatchObject({ tokenId: '9', name: 'Pixel' });
  });
  // spec: add-feeding › Add NEAR sheet screen › NEAR пришёл
  it('returns focus to the Feed title when NEAR arrives and the Add NEAR action disappears', async () => {
    mocks.phase = { kind: 'addNear', from: sheet(true) };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('.ds-sheet__body button')!.click());
    expect(mocks.back).toHaveBeenCalledWith(true);
    mocks.phase = { kind: 'open', sheet: sheet(false) };
    await render();
    const title = host.querySelector<HTMLElement>('.ds-sheet__title')!;
    expect(title.textContent).toBe('Feed Pixel');
    expect(title.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(title);
    expect(host.querySelector('.ds-sheet-layer--column')).not.toBeNull();
  });

  // spec: add-feeding › Add NEAR sheet screen › success
  it('returns focus to Add NEAR on Back when the short portion is still shown', async () => {
    mocks.phase = { kind: 'addNear', from: sheet(true) };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click());
    expect(mocks.back).toHaveBeenCalledWith(false);
    mocks.phase = { kind: 'open', sheet: sheet(true) };
    await render();
    expect(document.activeElement?.textContent).toBe('Add NEAR');
  });

  // spec: add-pet-work › Advice flow › success (гость)
  it("uses the own pet accent for an own-pet Feed sheet over a friend's Stage", async () => {
    mocks.phase = { kind: 'open', sheet: sheet(false) };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<div data-accent="coral"><FeedSheet request={{ tokenId: '9', name: 'Pixel', label: 'your Pixel', elsewhere: true }} onClose={() => undefined} column /></div>));
    expect(host.querySelector('.ds-sheet__sub [data-accent]')?.getAttribute('data-accent')).toBe('mint');
  });
});
