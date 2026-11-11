// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { HatchDisclosureNotices } from './HatchScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// spec: add-game-layout › Hatch notice rule › public notice folded
// spec: add-game-layout › Hatch notice rule › AI notice folded
it('starts with both short lines and keeps the complete notices folded', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<HatchDisclosureNotices name="Pixel" sessionKey="alice" />));
  expect(host.textContent).toContain("Your pet's name, character and everything it does are public forever.");
  expect(host.textContent).toContain("Your words and your pet's memories about you and friends who feed it go to NEAR AI.");
  expect(host.textContent).not.toContain('Saved food and a bought outfit are public on NEAR forever.');
  expect([...host.querySelectorAll('[aria-expanded]')].map((node) => node.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
  await act(async () => root.unmount());
  host.remove();
});

// spec: add-game-layout › Hatch notice rule › notice expanded
it('shows the full public notice and receipt line without changing the AI notice or name', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<HatchDisclosureNotices name="Pixel" sessionKey="alice" />));
  const [publicButton, aiButton] = [...host.querySelectorAll<HTMLButtonElement>('.ds-disclosure-line__toggle')];
  await act(async () => publicButton!.click());
  expect(publicButton!.getAttribute('aria-expanded')).toBe('true');
  expect(aiButton!.getAttribute('aria-expanded')).toBe('false');
  expect(host.textContent).toContain('Your pet\'s name "Pixel", character');
  expect(host.textContent).toContain("Saved food and a bought outfit are public on NEAR forever. The wish's words stay private.");
  expect(host.textContent).toContain("A thought's receipt shows how long the reply was");
  await act(async () => aiButton!.click());
  expect(host.textContent).toContain("To write your pet's replies, we send NEAR AI");
  expect([...host.querySelectorAll('[aria-expanded]')].map((node) => node.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
  expect([...host.querySelectorAll('.ds-disclosure-line__toggle')].map((node) => node.textContent)).toEqual(['Hide details', 'Hide details']);
  await act(async () => publicButton!.click());
  expect(host.textContent).not.toContain('Your pet\'s name "Pixel", character');
  expect(host.textContent).toContain("To write your pet's replies, we send NEAR AI");
  expect([...host.querySelectorAll('[aria-expanded]')].map((node) => node.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
  await act(async () => root.unmount());
  host.remove();
});

// spec: add-game-layout › Hatch notice rule › notice expanded × name edit
// spec: add-game-layout › Hatch notice rule › notice expanded × session expiry
it('keeps the current cleaned name while open and folds both notices when the session changes', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<HatchDisclosureNotices name="Pixel" sessionKey="alice" />));
  for (const button of host.querySelectorAll<HTMLButtonElement>('.ds-disclosure-line__toggle')) {
    await act(async () => button.click());
  }
  await act(async () => root.render(<HatchDisclosureNotices name="Biscuit" sessionKey="alice" />));
  expect(host.textContent).toContain('Your pet\'s name "Biscuit", character');
  expect(host.textContent).not.toContain('Your pet\'s name "Pixel", character');
  expect([...host.querySelectorAll('[aria-expanded]')].map((node) => node.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
  await act(async () => root.render(<HatchDisclosureNotices name="Biscuit" sessionKey="signed-out" />));
  expect([...host.querySelectorAll('[aria-expanded]')].map((node) => node.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
  expect(host.textContent).not.toContain('Your pet\'s name "Biscuit", character');
  await act(async () => root.unmount());
  host.remove();
});

// spec: add-game-layout › Hatch notice rule › notice expanded × reload
it('starts folded after a page remount', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const first = createRoot(host);
  await act(async () => first.render(<HatchDisclosureNotices name="Pixel" sessionKey="alice" />));
  await act(async () => host.querySelector<HTMLButtonElement>('.ds-disclosure-line__toggle')!.click());
  expect(host.textContent).toContain('Your pet\'s name "Pixel", character');
  await act(async () => first.unmount());
  const second = createRoot(host);
  await act(async () => second.render(<HatchDisclosureNotices name="Pixel" sessionKey="alice" />));
  expect([...host.querySelectorAll('[aria-expanded]')].map((node) => node.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
  await act(async () => second.unmount());
  host.remove();
});
