// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdapterSheet } from './AdapterSheet';
import { CodeSheet } from './CodeSheet';
import type { useAdapter } from './useAdapter';
import type { useCode } from './useCode';

vi.mock('../signin/SignInOutcome', () => ({ useSignInLines: () => [[]] }));
vi.mock('../errands/surfaces', () => ({ useMarkErrandSurface: () => undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

// spec: add-pet-errands › Skill code sheet screen › success
it('returns focus to the Pet nameplate when the centered code dialog closes', async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const sheet = {
      open, loaded: true, outcome: null, top: null, busy: null, functions: [], testsLeft: 1,
      fresh: false, code: '', fn: '', values: '', written: false, canSave: false, canTest: false,
      tooLong: false, stale: false, ticks: [], setCode: vi.fn(), setFn: vi.fn(), setValues: vi.fn(),
    } as unknown as ReturnType<typeof useCode>;
    return <><button className="ds-hud__nameplate" onClick={() => setOpen(true)}>Pixel</button>
      <CodeSheet name="Pixel" sheet={sheet} onClose={() => setOpen(false)} /></>;
  }
  await act(async () => root.render(<Harness />));
  const nameplate = host.querySelector<HTMLButtonElement>('.ds-hud__nameplate')!;
  nameplate.focus();
  await act(async () => nameplate.click());
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
  await act(async () => host.querySelector<HTMLButtonElement>('[role="dialog"] .ds-sheet__head button:last-child')!.click());
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(nameplate);
});

// spec: add-pet-errands › Adapter sheet screen › success
it('returns focus to the Pet nameplate on Close, while Back returns to the skill socket', async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const adapter = {
      open, source: null, tools: null, ticks: [], top: null, busy: null, variant: 'step',
      label: '', address: '', addressError: false, labelError: false, refused: false,
      published: null, revealed: false, setLabel: vi.fn(), setAddress: vi.fn(),
      back: () => setOpen(false), check: vi.fn(), tick: vi.fn(),
    } as unknown as ReturnType<typeof useAdapter>;
    return <><button className="ds-hud__nameplate">Pixel</button>
      <button className="skill-socket" onClick={() => setOpen(true)}>Add data</button>
      <AdapterSheet name="Pixel" tokenId="9" adapter={adapter} onClose={() => setOpen(false)} /></>;
  }
  await act(async () => root.render(<Harness />));
  const nameplate = host.querySelector<HTMLButtonElement>('.ds-hud__nameplate')!;
  const socket = host.querySelector<HTMLButtonElement>('.skill-socket')!;
  socket.focus();
  await act(async () => socket.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click());
  expect(document.activeElement).toBe(socket);
  await act(async () => socket.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  expect(document.activeElement).toBe(nameplate);
});
