// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AdviceDock } from './AdviceDock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

// spec: add-pet-society › Society hire flow › player advice refused × phone Dock
it('reserves the actual capped dock height as its contents change', async () => {
  let height = 180;
  let notify!: ResizeObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { notify = callback; }
    observe() {}
    disconnect() { disconnect(); }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AdviceDock><textarea aria-label="Question" /><button>Ask another pet</button></AdviceDock>));
  const spacer = host.querySelector<HTMLElement>('.advice-phone-dock-space');
  expect(spacer?.style.height).toBe('180px');
  height = 225;
  await act(async () => notify([], {} as ResizeObserver));
  expect(spacer?.style.height).toBe('225px');
  await act(async () => root.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
  host.remove();
  vi.restoreAllMocks();
});
