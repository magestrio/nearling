// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HomeScreen } from './HomeScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ view: { kind: 'signed-out' } as { kind: string; all?: boolean; until?: string }, begin: vi.fn(), tryAgain: vi.fn() }));
vi.mock('./useHome', () => ({ useHome: () => ({ view: mocks.view, tryAgain: mocks.tryAgain }) }));
vi.mock('../../signin/signIn', () => ({ useSignIn: () => ({ begin: mocks.begin }) }));
vi.mock('../../signin/SignInOutcome', () => ({ SignInOutcome: () => null }));
vi.mock('../../ds/Meadow', () => ({ Meadow: ({ pets }: { pets: unknown[] }) => <div data-meadow={pets.length} /> }));

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  mocks.view = { kind: 'signed-out' };
  mocks.begin.mockClear();
  mocks.tryAgain.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const show = () => act(async () => root.render(<HomeScreen />));

// spec: add-account › Home screen › signed-out
it('puts sign-in in the header and the hatch action above the meadow on desktop and in the phone dock', async () => {
  await show();
  expect(host.querySelector('.ds-header__end button')?.textContent).toBe('Sign in');
  expect(host.querySelector('h1')?.textContent).toBe('This pet pays for its own thoughts. When the money runs out, it falls asleep.');
  expect(host.querySelector('[data-meadow]')?.getAttribute('data-meadow')).toBe('10');
  expect(host.querySelector('.ds-only--desktop a')?.textContent).toBe('Hatch your pet');
  expect(host.querySelector('.ds-dock a')?.getAttribute('href')).toBe('/hatch');
  await act(async () => host.querySelector<HTMLButtonElement>('.ds-header__end button')!.click());
  expect(mocks.begin).toHaveBeenCalledWith('signin');
});

// spec: add-account › Home screen › signed-out (вход закрыт)
it('keeps the meadow and hire entry while sign-in closes, with the returning action only for former players', async () => {
  mocks.view = { kind: 'closed', all: false, until: '2026-12-01T00:00:00.000Z' };
  await show();
  expect(host.querySelector('.ds-header__end button')).toBeNull();
  expect(host.textContent).toContain("We're full for new players this month.");
  expect(host.querySelector('.ds-dock button')?.textContent).toBe('Played here before? Sign in');
  expect(host.querySelector('[data-meadow]')).not.toBeNull();
  mocks.view = { kind: 'closed', all: true, until: '2026-12-01T00:00:00.000Z' };
  await show();
  expect(host.textContent).toContain('Sign-in is closed for everyone until December 1.');
  expect(host.querySelector('.ds-dock button')).toBeNull();
  expect(host.querySelector('.ds-dock a')?.getAttribute('href')).toBe('/hire');
  expect(host.querySelector('.ds-dock a')?.textContent).toBe('Find a pet to ask');
});

// spec: add-account › Home screen › loading
it('leaves both entry controls inactive while the game is opening', async () => {
  mocks.view = { kind: 'loading' };
  await show();
  expect(host.textContent).toContain('Opening the game…');
  expect(host.querySelector<HTMLButtonElement>('.ds-header__end button')?.disabled).toBe(true);
  expect(host.querySelector('.ds-only--desktop button')?.getAttribute('disabled')).not.toBeNull();
});

// spec: add-account › Home screen › error
it('keeps the hook and inactive entries under the connection line until Try again', async () => {
  mocks.view = { kind: 'error' };
  await show();
  expect(host.querySelector('h1')?.textContent).toContain('This pet pays');
  expect(host.querySelector('.ds-banner')?.textContent).toContain("We can't reach the game right now.");
  expect(host.querySelector<HTMLButtonElement>('.ds-header__end button')?.disabled).toBe(true);
  expect(host.querySelector('.ds-only--desktop button')?.getAttribute('disabled')).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('.ds-banner button')!.click());
  expect(mocks.tryAgain).toHaveBeenCalledOnce();
});
