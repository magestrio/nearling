// @vitest-environment jsdom
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HomeScreen } from './HomeScreen';
import { SAMPLE_SHOWCASE } from '../../seams/showcase.sample';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ view: { kind: 'signed-out' } as {
  kind: string; all?: boolean; until?: string; knownPets?: Array<{ tokenId: string; name: string; asleep: boolean }>;
  birth?: { open: boolean; reason?: string } }, begin: vi.fn(), openJudge: vi.fn(), tryAgain: vi.fn() }));
vi.mock('./useHome', () => ({ useHome: () => ({ view: mocks.view, tryAgain: mocks.tryAgain }) }));
vi.mock('../../signin/signIn', () => ({ useSignIn: () => ({ begin: mocks.begin, openJudge: mocks.openJudge }) }));
vi.mock('../../signin/SignInOutcome', () => ({ SignInOutcome: () => null }));
vi.mock('../../account/AccountControl', () => ({ AccountControl: () => <button type="button">Account</button> }));
vi.mock('./useShowcase', () => ({ useShowcase: () => ({ kind: 'ready', copy: SAMPLE_SHOWCASE }) }));
vi.mock('../../ds/Meadow', () => ({ Meadow: ({ pets, numbers, explore }: { pets: unknown[]; numbers?: unknown[] | string; explore: ReactNode }) => <div data-meadow={pets.length} data-numbers={Array.isArray(numbers) ? numbers.length : numbers}>{explore}</div> }));

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  mocks.view = { kind: 'signed-out' };
  mocks.begin.mockClear();
  mocks.openJudge.mockClear();
  mocks.tryAgain.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const show = () => act(async () => root.render(<HomeScreen />));

// spec: add-hatch-again › Petless Home screen › success
it('keeps the meadow and shows the known given-away pet beside active discovery routes', async () => {
  mocks.view = { kind: 'petless', knownPets: [{ tokenId: '9', name: 'Pixel', asleep: false }], birth: { open: true } };
  await show();
  expect(host.textContent).toContain('No pet of your own right now.');
  expect(host.querySelector('a[href="/pet/9"]')?.textContent).toBe('Visit Pixel');
  expect(host.querySelector('.ds-only--desktop a[href="/hatch"]')).not.toBeNull();
  expect(host.querySelector('.ds-dock a[href="/hire"]')).not.toBeNull();
  expect(host.querySelector('[data-meadow]')).not.toBeNull();
});

// spec: add-hatch-again › Petless Home screen › error
it('offers a fresh check and public board while ownership is unknown', async () => {
  mocks.view = { kind: 'petless-error' };
  await show();
  expect(host.textContent).toContain("We couldn't check your pets. Try again.");
  expect(host.querySelector('a[href="/hatch"]')).toBeNull();
  expect(host.querySelector('a[href="/hire"]')).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('.ds-only--desktop button')!.click());
  expect(mocks.tryAgain).toHaveBeenCalledTimes(1);
});

// spec: add-hatch-again › Petless Home screen › closed birth
it('keeps Hatch, board and known pet reachable while births are paused', async () => {
  mocks.view = { kind: 'petless', knownPets: [{ tokenId: '9', name: 'Pixel', asleep: false }], birth: { open: false, reason: 'budget' } };
  await show();
  expect(host.textContent).toContain('New pets are paused for now.');
  expect(host.querySelector('a[href="/hatch"]')).not.toBeNull();
  expect(host.querySelector('a[href="/hire"]')).not.toBeNull();
  expect(host.querySelector('a[href="/pet/9"]')).not.toBeNull();
});

// spec: add-account › Home screen › signed-out
it('puts sign-in in the header and the hatch action above the live meadow on desktop and in the phone dock', async () => {
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
  expect(host.querySelector('.home-closed-notice .ds-text')?.textContent).toBe('Sign-in is closed for everyone until December 1. You can still look around, and any pet you have is safe.');
  expect(host.querySelector('.ds-dock button')).toBeNull();
  expect(host.querySelector('.ds-dock a')?.getAttribute('href')).toBe('/hire');
  expect(host.querySelector('.ds-dock a')?.textContent).toBe('Find a pet to ask');
});

// spec: add-showcase › Home evidence flow › public totals
// spec: add-showcase › Public demo flow › README numbers link with a session
it('keeps public totals and the explorer link on Home for a signed-in numbers visitor', async () => {
  mocks.view = { kind: 'evidence' };
  await show();
  expect(host.querySelector('[data-meadow]')?.getAttribute('data-numbers')).toBe('5');
  expect(host.querySelector('[data-meadow] a')?.textContent).toBe('See it on the NEAR explorer');
  expect(host.textContent).not.toContain('Hatch your pet');
  expect(host.querySelector('.ds-dock')).toBeNull();
});

// spec: add-showcase › Judge admission flow › ordinary entry closed
it('opens judge admission from the closed Home below the returning action', async () => {
  mocks.view = { kind: 'closed', all: false, until: '2026-12-01T00:00:00.000Z' };
  await show();
  const link = [...host.querySelectorAll('a')].find((node) => node.textContent === 'Enter judge code');
  expect(link).toBeTruthy();
  await act(async () => link!.click());
  expect(mocks.openJudge).toHaveBeenCalledOnce();
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
