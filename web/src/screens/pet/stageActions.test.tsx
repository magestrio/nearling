// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer, Hotbar } from '../../ds';
import { guestStageActions, newestPetReply, ownerConversationDisabled, ownerStageActions, visiblePetReply } from './stageActions';
import { PetNotFound } from './PetScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const callbacks = () => ({ onFeed: vi.fn(), onErrand: vi.fn(), onWatch: vi.fn(), onGift: vi.fn() });
const roots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];
afterEach(async () => {
  for (const { root, host } of roots) { await act(async () => root.unmount()); host.remove(); }
  roots.length = 0;
});

// spec: add-game-layout › Pet stage rule › owner entries
it('keeps direct owner routes on the Stage and sends the existing actions to their handlers', () => {
  const handlers = callbacks();
  const { items, menu } = ownerStageActions({ tokenId: '9', name: 'Pixel', asleep: false, away: false,
    feedOpen: false, errandOpen: false, watch: false, ...handlers });
  expect(items.map((item) => item.label)).toEqual(['Feed Pixel', 'Today', 'Wardrobe', 'Send Pixel on an errand', 'More']);
  expect(items[1]?.href).toBe('/pet/9/diary');
  expect(items[2]?.href).toBe('/pet/9/wardrobe');
  expect(menu.map((item) => item.label)).toEqual(['Watch something', 'Share Pixel', 'Give Pixel away']);
  items[0]?.onClick?.(); items[3]?.onClick?.(); menu[0]?.onClick?.(); menu[2]?.onClick?.();
  expect(Object.values(handlers).map((handler) => handler.mock.calls.length)).toEqual([1, 1, 1, 1]);
});

// spec: add-game-layout › Pet stage rule › asleep owner entries
it('keeps Feed and More while sleep removes Today, Wardrobe, Errand and Give', async () => {
  const { items, menu } = ownerStageActions({ tokenId: '9', name: 'Pixel', asleep: true, away: false,
    feedOpen: false, errandOpen: false, watch: true, ...callbacks() });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push({ root, host });
  await act(async () => root.render(<Hotbar items={items} menu={menu} />));
  expect([...host.querySelectorAll('.ds-hotbar__action')].map((node) => node.textContent)).toEqual(['Feed Pixel', 'More']);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  expect([...host.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent)).toEqual(['Edit watch', 'Share Pixel']);
});

// spec: add-game-layout › Pet stage rule › guest entries
it('replaces owner actions with the single public Feed action after an owner-to-guest read', () => {
  const feed = vi.fn();
  const owner = ownerStageActions({ tokenId: '9', name: 'Pixel', asleep: false, away: false,
    feedOpen: false, errandOpen: false, watch: false, ...callbacks() });
  const guest = guestStageActions('Pixel', false, feed);
  expect(owner.items.some((item) => item.label === 'More')).toBe(true);
  expect(guest.map((item) => item.label)).toEqual(['Feed Pixel']);
  expect(guest.some((item) => item.label === 'More' || item.label === 'Wardrobe')).toBe(false);
  guest[0]?.onClick?.(); expect(feed).toHaveBeenCalledOnce();
});

// spec: add-game-layout › Pet stage rule › asleep owner entries × conversation
it('keeps the drafted conversation inactive when asleep, tired, paused or signed out', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push({ root, host });
  const send = vi.fn();
  for (const flags of [[true, false, false, false], [false, true, false, false],
    [false, false, true, false], [false, false, false, true]]) {
    await act(async () => root.render(<Composer value="Still here" onSend={send}
      disabled={ownerConversationDisabled(flags[0]!, flags[1]!, flags[2]!, flags[3]!)} />));
    const field = host.querySelector('textarea')!;
    expect(field.readOnly).toBe(true);
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(field.value).toBe('Still here');
  }
  expect(send).not.toHaveBeenCalled();
  expect(ownerConversationDisabled(false, false, false, false)).toBe(false);
});

// spec: add-game-layout › Pet stage rule › owner entries × newest reply
it('puts the pet\'s newest line of the open turn in the Bubble: its question to a worker too, never a report or a worker\'s line', () => {
  const earlier = { id: 'earlier', who: 'pet', text: 'Start with the chart.' };
  const you = { id: 'you', who: 'player', text: 'And if they ask why?' };
  const question = { id: 'question', who: 'pet', text: 'To worker: …', question: true };
  const worker = { id: 'worker', who: 'worker', text: 'Tell them what it changed.' };
  const reply = { id: 'reply', who: 'pet', text: 'I can help.' };
  const report = { id: 'report', who: 'pet', text: 'The Leonids peak.', report: { sources: [] } };
  const ready = { busy: false, failed: false, asleep: false, away: false };
  expect(newestPetReply([reply, question])).toBe(reply);
  expect(newestPetReply([question])).toBeUndefined();
  expect(visiblePetReply([earlier, you, question], ready)).toBe(question);
  expect(visiblePetReply([earlier, you, question, worker, reply], ready)).toBe(reply);
  expect(visiblePetReply([earlier, you, worker], ready)).toBeUndefined();
  expect(visiblePetReply([earlier, you, report], ready)).toBeUndefined();
  expect(visiblePetReply([earlier], ready)).toBe(earlier);
  expect(visiblePetReply([reply], { ...ready, busy: true })).toBeUndefined();
  expect(visiblePetReply([reply], { ...ready, failed: true })).toBeUndefined();
  expect(visiblePetReply([reply], { ...ready, asleep: true })).toBeUndefined();
  expect(visiblePetReply([reply], { ...ready, away: true })).toBeUndefined();
});

// spec: add-pet › Pet screen › error
it('keeps a broken pet link on the game Stage with its way home', () => {
  const html = renderToStaticMarkup(<PetNotFound />);
  expect(html).toContain('ds-stage--game');
  expect(html).toContain("We couldn&#x27;t find this pet. The link may be broken.");
  expect(html).toContain('Go home');
  expect(html).not.toContain('ds-split');
});
