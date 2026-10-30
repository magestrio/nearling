// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMotionPaused, MOTION_KEY, resetMotionMemory, setMotionPaused, subscribeMotion } from './motion';

function systemWants(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({ matches: reduce && query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} }),
  );
}

beforeEach(() => {
  localStorage.clear();
  resetMotionMemory();
  systemWants(false);
});
afterEach(() => vi.unstubAllGlobals());

describe('Pet motion rule', () => {
  // spec: add-pet › Pet motion rule › пауза
  it('«Pause motion» stops the pet and the browser remembers it; «Play motion» starts it again', () => {
    expect(isMotionPaused()).toBe(false);
    setMotionPaused(true);
    expect(isMotionPaused()).toBe(true);
    expect(localStorage.getItem(MOTION_KEY)).toBe('paused');
    setMotionPaused(false);
    expect(isMotionPaused()).toBe(false);
    expect(localStorage.getItem(MOTION_KEY)).toBe('playing');
  });

  // spec: add-pet › Pet motion rule › система просит меньше движения
  it('stands from the first show when the system asks for less motion, until the viewer plays it', () => {
    systemWants(true);
    expect(isMotionPaused()).toBe(true);
    setMotionPaused(false);
    expect(isMotionPaused()).toBe(false);
    expect(localStorage.getItem(MOTION_KEY)).toBe('playing');
  });

  // spec: add-pet › Pet motion rule › система просит меньше движения
  it('the viewer\'s «Play motion» beats the system on the next visit too', () => {
    systemWants(true);
    localStorage.setItem(MOTION_KEY, 'playing');
    expect(isMotionPaused()).toBe(false);
  });

  // spec: add-pet › Pet motion rule › пауза × перезагрузка
  it('remembers a pause across a reload', () => {
    setMotionPaused(true);
    resetMotionMemory(); // a new page load: nothing in the tab's memory, the browser's storage stays
    expect(isMotionPaused()).toBe(true);
  });

  // spec: add-pet › Pet motion rule › пауза × стёрты данные сайта
  it('moves again when the site data is erased', () => {
    setMotionPaused(true);
    localStorage.clear();
    resetMotionMemory();
    expect(isMotionPaused()).toBe(false);
  });

  // spec: add-pet › Pet motion rule › пауза × другая вкладка переключила
  it('follows a toggle made in another tab through the storage event', () => {
    const seen = vi.fn(() => isMotionPaused());
    const stop = subscribeMotion(seen);
    localStorage.setItem(MOTION_KEY, 'paused'); // the other tab wrote it
    window.dispatchEvent(new StorageEvent('storage', { key: MOTION_KEY, newValue: 'paused' }));
    expect(seen).toHaveBeenCalled();
    expect(seen.mock.results.at(-1)?.value).toBe(true);
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }));
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    window.dispatchEvent(new StorageEvent('storage', { key: MOTION_KEY }));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  // spec: add-pet › Pet motion rule › пауза
  it('still toggles for the tab when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => setMotionPaused(true)).not.toThrow();
    expect(isMotionPaused()).toBe(true);
    vi.restoreAllMocks();
  });
});
