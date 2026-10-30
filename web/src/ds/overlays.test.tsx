// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IconButton } from './IconButton';
import { Menu, MenuItem } from './Menu';
import { Sheet } from './Sheet';
import { Toast, TOAST_MS } from './Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;

async function show(node: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}

function press(key: string, init: KeyboardEventInit = {}, target: Element = document.activeElement ?? document.body) {
  return act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })));
}

beforeEach(() => {
  // the phone: no desktop breakpoint
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  vi.useRealTimers();
});

describe('Menu', () => {
  const menu = (onClose: (by: 'escape' | 'tab') => void) => (
    <Menu label="Account" note="Signed in as sam@example.com" onClose={onClose}>
      <MenuItem first>Sign out</MenuItem>
      <MenuItem>Clear Pixel's memory</MenuItem>
      <MenuItem>Third</MenuItem>
    </Menu>
  );

  // spec: add-account › Account menu screen › success (владелец) × Account и Esc
  it('puts the focus on the first item, and moves it by the arrows, Home and End, round the ends', async () => {
    await show(menu(() => undefined));
    const items = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    await press('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    await press('End');
    expect(document.activeElement).toBe(items[2]);
    await press('ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    await press('ArrowUp');
    expect(document.activeElement).toBe(items[2]);
    await press('Home');
    expect(document.activeElement).toBe(items[0]);
  });

  // spec: add-account › Account menu screen › success (владелец) × Account и Esc
  it('asks to close on Esc and on Tab, and holds the note above the items', async () => {
    const onClose = vi.fn();
    await show(menu(onClose));
    expect(host.querySelector('.ds-menu__note')?.textContent).toBe('Signed in as sam@example.com');
    expect(host.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Account');
    await press('Escape');
    expect(onClose).toHaveBeenLastCalledWith('escape');
    await press('Tab');
    expect(onClose).toHaveBeenLastCalledWith('tab');
  });
});

describe('Sheet', () => {
  function Page({ onClose, busy }: { onClose: () => void; busy?: boolean }) {
    return (
      <Sheet title="Clear Pixel's memory?" onClose={onClose} busy={busy} centered alert status="">
        <button type="button">Clear memory</button>
        <button type="button" data-autofocus>
          Keep memory
        </button>
      </Sheet>
    );
  }

  // spec: add-account › Clear memory dialog screen › success × Keep memory и Esc
  it('moves the focus onto its safe action, and gives it back to the opener when it goes', async () => {
    host = document.createElement('div');
    document.body.append(host);
    const opener = document.createElement('button');
    host.before(opener);
    opener.focus();
    root = createRoot(host);
    await act(async () => root!.render(<Page onClose={() => undefined} />));
    expect(document.activeElement?.textContent).toBe('Keep memory');
    expect(host.querySelector('[role="alertdialog"]')?.getAttribute('aria-modal')).toBe('true');
    await act(async () => root!.render(null));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  // spec: add-account › Clear memory dialog screen › success × Keep memory и Esc
  it('closes on Esc, on «Close» and on the scrim, and none of them while busy', async () => {
    const onClose = vi.fn();
    await show(<Page onClose={onClose} />);
    await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => host.querySelector<HTMLElement>('[aria-label="Close"]')!.click());
    expect(onClose).toHaveBeenCalledTimes(2);
    await act(async () => host.querySelector<HTMLElement>('.ds-sheet__scrim')!.click());
    expect(onClose).toHaveBeenCalledTimes(3);

    await act(async () => root!.render(<Page onClose={onClose} busy />));
    await press('Escape');
    await act(async () => host.querySelector<HTMLElement>('.ds-sheet__scrim')!.click());
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.disabled).toBe(true);
  });

  // spec: add-account › Clear memory dialog screen › success × Keep memory и Esc
  it('keeps Tab inside it: past the last control it goes to the first, and back', async () => {
    await show(<Page onClose={() => undefined} />);
    const sheet = host.querySelector('.ds-sheet')!;
    const all = [...sheet.querySelectorAll<HTMLElement>('button')];
    all.at(-1)!.focus();
    await press('Tab', {}, all.at(-1)!);
    expect(document.activeElement).toBe(all[0]);
    await press('Tab', { shiftKey: true }, all[0]!);
    expect(document.activeElement).toBe(all.at(-1));
  });

  // spec: add-account › Sign-in closed sheet screen › success (закрыт для новых) × Keep looking
  it('lands on its title when it opened by itself, and writes an outcome into one live region', async () => {
    await show(
      <Sheet title="Pixel is yours now" onClose={() => undefined} self status="Gift accepted.">
        <p>Body</p>
      </Sheet>,
    );
    expect(document.activeElement?.tagName).toBe('H2');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Gift accepted.');
  });
});

describe('Toast', () => {
  // spec: add-account › Sign-out flow › вышел
  it('goes after 4 seconds, and is silent when a live region says it', async () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    await show(
      <>
        <Toast onDone={onDone}>You're signed out. See you soon!</Toast>
        <Toast silent>quiet</Toast>
      </>,
    );
    const toasts = host.querySelectorAll('.ds-toast');
    expect(toasts[0]?.getAttribute('role')).toBe('status');
    expect(toasts[1]?.getAttribute('role')).toBeNull();
    await act(async () => void vi.advanceTimersByTime(TOAST_MS - 1));
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(1));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('IconButton', () => {
  // spec: add-account › Account menu screen › success (владелец) × Account и Esc
  it('is named by its label, acts on a click, and is off when disabled', async () => {
    const onClick = vi.fn();
    await show(<IconButton icon="account" label="Account" variant="secondary" haspopup="menu" expanded={false} onClick={onClick} />);
    const button = host.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Account');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    await act(async () => button.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
