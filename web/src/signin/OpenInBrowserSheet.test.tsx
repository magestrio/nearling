// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenInBrowserSheet } from './OpenInBrowserSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

// spec: add-account › Open in browser sheet screen › error
it('shows and selects the whole manual link in a read-only wrapping textarea after copying fails', async () => {
  await act(async () => root.render(<OpenInBrowserSheet inApp="x" place="/pet/2" onClose={() => undefined} returnFocusTo={() => null} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button.ds-button')!.click());
  const field = host.querySelector<HTMLTextAreaElement>('textarea.ds-field__input--multiline');
  expect(field?.readOnly).toBe(true);
  expect(field?.value).toContain('/pet/2?ib=x');
  expect(field?.selectionStart).toBe(0);
  expect(field?.selectionEnd).toBe(field?.value.length);
  expect(document.activeElement).toBe(field);
});
