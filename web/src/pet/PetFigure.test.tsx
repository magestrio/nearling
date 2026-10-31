// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useContextLoss } from './PetFigure';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Watch({ canvas, onLost }: { canvas: HTMLCanvasElement; onLost: () => void }) {
  const watch = useContextLoss(onLost);
  watch(canvas);
  return null;
}

// spec: add-pet › Pet screen › WebGL недоступен
it('WebGL недоступен: a context lost on a standing figure tells the page; the loss R3F forces on an unmounted canvas does not', async () => {
  const canvas = document.createElement('canvas');
  const onLost = vi.fn();
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Watch canvas={canvas} onLost={onLost} />));

  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  expect(onLost).toHaveBeenCalledTimes(1);

  await act(async () => root.unmount());
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  expect(onLost).toHaveBeenCalledTimes(1);
});
