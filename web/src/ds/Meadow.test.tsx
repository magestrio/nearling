// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MEADOW_PETS } from '../screens/home/meadowPets';
import { resetMotionMemory } from '../pet/motion';
import { Meadow } from './Meadow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ webgl: true, drawFlat: vi.fn() }));
vi.mock('../pet/flat', () => ({ canUseWebGL: () => mocks.webgl, drawFlat: mocks.drawFlat }));
vi.mock('../pet/MeadowScene', () => ({ MeadowScene: ({ onLost }: { onLost: () => void }) => <canvas data-scene="meadow" onClick={onLost} /> }));

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  mocks.webgl = true;
  mocks.drawFlat.mockClear();
  localStorage.clear();
  resetMotionMemory();
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  class Observer { observe() {} disconnect() {} }
  globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  resetMotionMemory();
  vi.restoreAllMocks();
});

// spec: add-account › Home screen › signed-out
it('draws ten sample slots with no names or links, including a hungry pet and two sleeping pets', async () => {
  await act(async () => root.render(<Meadow pets={MEADOW_PETS} motion />));
  expect(host.querySelectorAll('.ds-meadow__pet')).toHaveLength(10);
  expect(host.querySelectorAll('.ds-meadow__pet--asleep')).toHaveLength(2);
  expect(host.querySelectorAll('.ds-meadow__pet--hungry')).toHaveLength(1);
  expect(host.querySelectorAll('.ds-meadow__zz .ds-icon')).toHaveLength(4);
  expect(host.querySelector('.ds-meadow__ground')?.getAttribute('aria-hidden')).toBe('true');
  expect(host.querySelectorAll('.ds-meadow a')).toHaveLength(0);
  expect(host.textContent).toBe('Pause motion');
});

// spec: add-account › Home screen › signed-out
it('shares the pause choice with the pet screens and leaves the sleepers still', async () => {
  await act(async () => root.render(<Meadow pets={MEADOW_PETS} motion />));
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.querySelector('.ds-meadow--paused')).not.toBeNull();
  expect(localStorage.getItem('nearling.motion')).toBe('paused');
  expect(host.textContent).toBe('Play motion');
});

// spec: add-account › Home screen › signed-out
it('keeps the sample pets as flat stills and removes the motion control when WebGL is unavailable', async () => {
  mocks.webgl = false;
  await act(async () => root.render(<Meadow pets={MEADOW_PETS} motion />));
  expect(host.querySelectorAll('.ds-meadow__flat')).toHaveLength(10);
  expect(host.querySelector('.ds-meadow--paused')).not.toBeNull();
  expect(host.querySelector('button')).toBeNull();
  expect(mocks.drawFlat).toHaveBeenCalledTimes(10);
});

// spec: add-account › Home screen › signed-out
it('uses one canvas for the crowd and falls back to stills if its context is lost', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 400 } as DOMRect);
  globalThis.ResizeObserver = class { constructor(private readonly changed: ResizeObserverCallback) {} observe() { this.changed([], this as unknown as ResizeObserver); } disconnect() {} } as unknown as typeof ResizeObserver;
  await act(async () => root.render(<Meadow pets={MEADOW_PETS} motion />));
  expect(host.querySelectorAll('.ds-meadow__ground canvas')).toHaveLength(1);
  await act(async () => host.querySelector<HTMLCanvasElement>('[data-scene="meadow"]')!.click());
  expect(host.querySelectorAll('.ds-meadow__flat')).toHaveLength(10);
  expect(host.querySelector('.ds-meadow__motion')).toBeNull();
});
