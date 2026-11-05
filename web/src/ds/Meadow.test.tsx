// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MEADOW_PETS } from '../screens/home/meadowPets';
import { resetMotionMemory } from '../pet/motion';
import { Meadow } from './Meadow';
import { SAMPLE_SHOWCASE } from '../seams/showcase.sample';
import { meadowNumbers, meadowPets } from '../screens/home/showcase';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ webgl: true, drawFlat: vi.fn() }));
vi.mock('../pet/flat', () => ({ canUseWebGL: () => mocks.webgl, drawFlat: mocks.drawFlat }));
vi.mock('../pet/MeadowScene', () => ({ MeadowScene: ({ onLost, onMove }: { onLost: () => void; onMove?: (index: number, x: number) => void }) => <canvas data-scene="meadow" onClick={onLost} onDoubleClick={() => onMove?.(0, 0.6)} /> }));

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

// spec: add-account › Home screen › pet on the meadow
it('makes real pets named links in left-to-right keyboard order, with a tag and a whole target', async () => {
  await act(async () => root.render(<Meadow pets={meadowPets(SAMPLE_SHOWCASE)} label="Pets in the game" numbers={meadowNumbers(SAMPLE_SHOWCASE)} explore={<a href="/explorer">See it on the NEAR explorer</a>} motion />));
  const links = [...host.querySelectorAll<HTMLAnchorElement>('.ds-meadow__link')];
  expect(links).toHaveLength(10);
  expect(links.map((a) => a.getAttribute('aria-label'))).toEqual([
    'Juniper · full', 'Pip · full', 'Kiwi · full', 'Nori · full', 'Mochi · asleep — out of food',
    'Lumen · asleep — out of food', 'Pebble · full', 'Tofu · full', 'Ember · hungry', 'Waffle · full',
  ]);
  expect(links[0]?.querySelector('.ds-meadow__tag')?.textContent).toBe('Juniper · full');
  expect(links[0]?.getAttribute('href')).toBe('/pet/40');
  expect(host.querySelector('.ds-meadow__ground')?.getAttribute('role')).toBe('list');
  expect(host.querySelector('.ds-meadow__ground')?.getAttribute('aria-label')).toBe('Pets in the game');
  expect(host.querySelectorAll('.ds-meadow__pet--wide')).toHaveLength(5);
  expect(host.querySelector('.ds-meadow__stats')?.textContent).toContain('1,204 pets hatched');
});

// spec: add-account › Home screen › meadow loading
it('keeps empty number space while loading and leaves the explorer reachable', async () => {
  await act(async () => root.render(<Meadow pets={[]} numbers="loading" explore={<a href="/explorer">See it on the NEAR explorer</a>} motion />));
  expect(host.querySelector('.ds-meadow__stats--loading')?.getAttribute('aria-hidden')).toBe('true');
  expect(host.querySelectorAll('.ds-meadow__stat')).toHaveLength(3);
  expect(host.querySelector('.ds-meadow__motion')).toBeNull();
  expect(host.querySelector('.ds-meadow__explore a')).not.toBeNull();
});

// spec: add-account › Home screen › asleep
it('keeps sleepers linked and their two z still under a shared pause choice, including the phone icon control', async () => {
  await act(async () => root.render(<Meadow pets={meadowPets(SAMPLE_SHOWCASE)} motion />));
  const controls = host.querySelectorAll<HTMLButtonElement>('.ds-meadow__motion button');
  expect(controls).toHaveLength(2);
  expect(controls[1]?.getAttribute('aria-label')).toBe('Pause motion');
  await act(async () => controls[1]!.click());
  expect(host.querySelector('.ds-meadow--paused')).not.toBeNull();
  expect(host.querySelector('.ds-meadow__motion .ds-only--phone button')?.getAttribute('aria-label')).toBe('Play motion');
  expect(host.querySelectorAll('.ds-meadow__pet--asleep .ds-meadow__zz .ds-icon')).toHaveLength(4);
  expect(host.querySelector('.ds-meadow__pet--asleep .ds-meadow__link')).not.toBeNull();
});

// spec: add-account › Home screen › pet on the meadow
it('retains the named whole-pet links as stills when WebGL is lost', async () => {
  mocks.webgl = false;
  await act(async () => root.render(<Meadow pets={meadowPets(SAMPLE_SHOWCASE)} label="Pets in the game" motion />));
  expect(host.querySelectorAll('.ds-meadow__link')).toHaveLength(10);
  expect(host.querySelectorAll('.ds-meadow__link .ds-meadow__flat')).toHaveLength(10);
  expect(host.querySelector('.ds-meadow__motion')).toBeNull();
  expect(host.querySelector('.ds-meadow__pet--asleep .ds-meadow__link')?.getAttribute('aria-label')).toContain('asleep — out of food');
});

// spec: add-account › Home screen › pet on the meadow × moving target
it('moves the pet link target when its 3D pet hops', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 400 } as DOMRect);
  globalThis.ResizeObserver = class { constructor(private readonly changed: ResizeObserverCallback) {} observe() { this.changed([], this as unknown as ResizeObserver); } disconnect() {} } as unknown as typeof ResizeObserver;
  await act(async () => root.render(<Meadow pets={meadowPets(SAMPLE_SHOWCASE)} motion />));
  const target = host.querySelector<HTMLElement>('.ds-meadow__pet')!;
  expect(target.style.getPropertyValue('--x')).toBe('0.04');
  await act(async () => host.querySelector<HTMLCanvasElement>('[data-scene="meadow"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(target.style.getPropertyValue('--x')).toBe('0.6');
  expect(target.querySelector('.ds-meadow__link')).not.toBeNull();
});
