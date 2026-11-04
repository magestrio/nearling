// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { PetPlate } from './PetParts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// spec: add-verification › Seal of character rule › character checked
// spec: add-verification › Seal of character rule › character mismatch
it('places the Seal beside the name and keeps the plate action when the Seal is withheld', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(PetPlate, { name: 'Pixel', seal: '9f2c',
    action: createElement('button', null, 'Feed Pixel') })));
  expect(host.querySelector('.ds-plate__head')?.textContent).toContain('Pixel');
  expect(host.querySelector('[role="img"][aria-label="Seal of character"]')).not.toBeNull();
  expect(host.querySelector('button')?.textContent).toBe('Feed Pixel');
  await act(async () => root.render(createElement(PetPlate, { name: 'Pixel',
    action: createElement('button', null, 'Feed Pixel') })));
  expect(host.querySelector('[role="img"][aria-label="Seal of character"]')).toBeNull();
  expect(host.querySelector('button')?.textContent).toBe('Feed Pixel');
  await act(async () => root.unmount());
});
