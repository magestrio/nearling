// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DisclosureLine } from './DisclosureLine';
import { Egg } from './Egg';
import { Hotbar } from './Hotbar';
import { Hud } from './Hud';
import { Inert } from './layout';
import { PetCard } from './PetCard';
import { Sheet } from './Sheet';
import { Stage } from './Stage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
const frame = (callback: FrameRequestCallback) => { callback(0); return 1; };

async function show(node: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(node));
}
async function click(selector: string) {
  await act(async () => host.querySelector<HTMLElement>(selector)!.click());
}
async function key(target: Element, name: string) {
  await act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', frame);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

// spec: add-game-layout › Pet stage rule › owner entries
it('keeps the world, conversation and actions in DOM order and names the card opener', async () => {
  const open = vi.fn();
  await show(<><Hud name="Pixel" stage="Grown-up" condition="full" owner energy={7} onCard={open} />
    <Stage pet={<span>pet</span>} chat={<span>conversation</span>} hotbar={<span>actions</span>} /></>);
  const plate = host.querySelector<HTMLButtonElement>('.ds-hud__nameplate')!;
  expect(plate.getAttribute('aria-haspopup')).toBe('dialog');
  expect(plate.getAttribute('aria-label')).toBe("Pixel's card");
  await act(async () => plate.click());
  expect(open).toHaveBeenCalledOnce();
  expect([...host.querySelectorAll('.ds-stage__pet, .ds-stage__chat, .ds-stage__hotbar')].map((node) => node.textContent))
    .toEqual(['pet', 'conversation', 'actions']);
});

// spec: add-game-layout › Pet actions menu screen › success (awake owner)
it('opens More with named menu items, arrow navigation, Escape and restored focus', async () => {
  await show(<Hotbar items={[{ icon: 'feed', label: 'Feed Pixel', primary: true }, { icon: 'more', label: 'More', more: true }]}
    menu={[{ icon: 'watch', label: 'Watch something' }, { icon: 'share', label: 'Share Pixel' }, { icon: 'gift', label: 'Give Pixel away' }]} />);
  await click('.ds-hotbar__action[aria-haspopup="menu"]');
  const menu = host.querySelector<HTMLElement>('[role="menu"]')!;
  expect(menu.getAttribute('aria-label')).toBe('More');
  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual(['Watch something', 'Share Pixel', 'Give Pixel away']);
  expect(document.activeElement).toBe(items[0]);
  await key(items[0]!, 'ArrowDown');
  expect(document.activeElement).toBe(items[1]);
  await key(items[1]!, 'Escape');
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('[aria-haspopup="menu"]'));
});

// spec: add-game-layout › Pet actions menu screen › success (sharing choices)
it('says why a sharing choice is unavailable in place of the choices, and spends the line when the menu goes back or closes', async () => {
  const reset = vi.fn();
  const items = [{ icon: 'feed' as const, label: 'Feed Pixel', primary: true }, { icon: 'more' as const, label: 'More', more: true }];
  const share = [{ icon: 'share' as const, label: 'Share a thought' }, { icon: 'share' as const, label: 'Share growth' }];
  await show(<Hotbar items={items} menu={[{ icon: 'share', label: 'Share Pixel' }]} shareItems={share} onMenuReset={reset} />);
  await click('.ds-hotbar__action[aria-haspopup="menu"]');
  await click('[role="menuitem"]');
  expect([...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Back', 'Share a thought', 'Share growth']);
  await act(async () => root.render(<Hotbar items={items} menu={[{ icon: 'share', label: 'Share Pixel' }]} shareItems={share} menuMessage="Pixel isn't wearing an outfit to share." onMenuReset={reset} />));
  expect([...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Back']);
  expect(host.querySelector('.ds-action-menu__message')?.textContent).toBe("Pixel isn't wearing an outfit to share.");
  await click('[role="menuitem"]');
  expect(reset).toHaveBeenCalledOnce();
  await click('.ds-action-menu__close');
  expect(reset).toHaveBeenCalledTimes(2);
});

// spec: add-game-layout › Pet actions menu screen › success (sharing choices) × Share preview opens
it('keeps focus in a share preview when a pending menu autofocus frame runs', async () => {
  const pending = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    pending.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
  const bar = <Hotbar items={[{ icon: 'more', label: 'More', more: true }]}
    menu={[{ icon: 'share', label: 'Share Pixel' }]}
    shareItems={[{ icon: 'share', label: 'Share a thought' }]} />;
  await show(<>{bar}</>);
  await click('.ds-hotbar__action[aria-haspopup="menu"]');
  await click('[role="menuitem"]');
  await act(async () => root.render(<>{bar}<Sheet title="Share a thought" centered onClose={() => undefined}
    foot={<button type="button">Share</button>}>Preview</Sheet></>));
  const share = host.querySelector<HTMLButtonElement>('[role="dialog"] .ds-sheet__foot button')!;
  share.focus();
  await act(async () => { for (const callback of pending.values()) callback(0); pending.clear(); });
  expect(document.activeElement).toBe(share);
});

// spec: add-game-layout › Pet actions menu screen › success (sharing choices) × More closes
it('returns More to root after its trigger closes sharing or an error', async () => {
  const reset = vi.fn();
  const items = [{ icon: 'more' as const, label: 'More', more: true }];
  const menu = [{ icon: 'share' as const, label: 'Share Pixel' }];
  const shareItems = [{ icon: 'share' as const, label: 'Share a thought' }];
  await show(<Hotbar items={items} menu={menu} shareItems={shareItems} onMenuReset={reset} />);
  await click('.ds-hotbar__action[aria-haspopup="menu"]');
  await click('[role="menuitem"]');
  expect(host.textContent).toContain('Share a thought');
  await click('.ds-hotbar__action[aria-haspopup="menu"]');
  expect(reset).toHaveBeenCalledOnce();
  await click('.ds-hotbar__action[aria-haspopup="menu"]');
  expect(host.textContent).toContain('Share Pixel');
  await act(async () => root.render(<Hotbar items={items} menu={menu} shareItems={shareItems} menuMessage="Unavailable." onMenuReset={reset} />));
  await click('.ds-hotbar__action[aria-haspopup="menu"]');
  expect(reset).toHaveBeenCalledTimes(2);
  await click('.ds-hotbar__action[aria-haspopup="menu"]');
  expect(host.textContent).toContain('Share Pixel');
});

// spec: add-game-layout › Pet actions menu screen › success (sharing choices) × unavailable choice
it('announces an unavailable choice and focuses its reason when the chosen item disappears', async () => {
  const items = [{ icon: 'more' as const, label: 'More', more: true }];
  const menu = [{ icon: 'share' as const, label: 'Share Pixel' }];
  const shareItems = [{ icon: 'share' as const, label: 'Share a thought' }];
  await show(<Hotbar items={items} menu={menu} shareItems={shareItems} />);
  await click('.ds-hotbar__action[aria-haspopup="menu"]');
  await click('[role="menuitem"]');
  const choice = host.querySelector<HTMLElement>('[role="menuitem"]:nth-of-type(2)') ?? [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')][1]!;
  choice.focus();
  await act(async () => root.render(<Hotbar items={items} menu={menu} shareItems={shareItems} menuMessage="Unavailable." />));
  const status = host.querySelector<HTMLElement>('.ds-action-menu__message')!;
  expect(status.getAttribute('role')).toBe('status');
  expect(status.textContent).toBe('Unavailable.');
  expect(document.activeElement).toBe(status);
});

// spec: add-game-layout › Hatch notice rule › notice expanded
it('opens each disclosure independently without changing the other one', async () => {
  await show(<><DisclosureLine summary="Public forever." label="Read what's public">Full public notice</DisclosureLine>
    <DisclosureLine summary="Goes to NEAR AI." label="Read what goes to NEAR AI">Full AI notice</DisclosureLine></>);
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('.ds-disclosure-line__toggle')];
  expect(buttons.map((button) => button.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
  await act(async () => buttons[0]!.click());
  expect(buttons.map((button) => button.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
  expect(host.textContent).toContain('Full public notice');
  expect(host.textContent).not.toContain('Full AI notice');
  await act(async () => buttons[0]!.click());
  expect(host.textContent).not.toContain('Full public notice');
});

// spec: add-game-layout › Pet card screen › success (owner)
it('keeps the stage inert under a card and restores focus to its nameplate', async () => {
  await show(<><button type="button" className="nameplate">Pixel</button><Inert on><Stage pet="pet" /></Inert></>);
  const nameplate = host.querySelector<HTMLButtonElement>('.nameplate')!;
  nameplate.focus();
  await act(async () => root.render(<><button type="button" className="nameplate">Pixel</button><Inert on><Stage pet="pet" /></Inert>
    <PetCard name="Pixel" onClose={() => undefined} returnFocusTo={() => host.querySelector('.nameplate')} sections={[{ title: 'Work', content: <a href="/work">View work record</a> }]} /></>));
  expect(host.querySelector('[inert]')?.querySelector('.ds-stage')).not.toBeNull();
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBeNull();
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBeTruthy();
  await act(async () => root.render(<><button type="button" className="nameplate">Pixel</button><Inert on><Stage pet="pet" /></Inert></>));
  expect(document.activeElement).toBe(host.querySelector('.nameplate'));
});

// spec: add-game-layout › Pet card screen › success (owner) × Escape
it('leaves Escape to the top sheet when an underlying sheet is inert', async () => {
  const under = vi.fn();
  const over = vi.fn();
  await show(<><Inert on><Sheet title="Feed" onClose={under}><button>Feed</button></Sheet></Inert>
    <Sheet title="Pixel's card" onClose={over}><button>Work</button></Sheet></>);
  await key(document.activeElement!, 'Escape');
  expect(under).not.toHaveBeenCalled();
  expect(over).toHaveBeenCalledOnce();
});

// spec: add-game-layout › Hatch notice rule › AI notice folded
it('keeps the pending Egg accessible and its motion removable by the DS media rule', async () => {
  await show(<Egg cracking />);
  expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Hatching…');
  const css = readFileSync('src/ds/components.css', 'utf8');
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.ds-egg--cracking \.ds-egg__shell \{ animation: none;/);
  expect(css).toMatch(/\.ds-stage--game \.ds-stage__hotbar \{ position: sticky; inset-block-end: var\(--space-0\)/);
  // spec: add-hatch-again › Repeat birth flow › unknown outcome
  const layoutCss = readFileSync('src/ds/pet-layout.css', 'utf8');
  expect(layoutCss).toMatch(/\.ds-egg--cracking \.ds-egg__shell \{ animation: ds-egg-rock var\(--duration-medium\) var\(--easing-standard\) 15 alternate;/);
  expect(readFileSync('src/ds/tokens.css', 'utf8')).toMatch(/--duration-medium: 320ms/);
});
