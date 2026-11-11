// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfileCard } from './ProfileCard';
import { useProfileCard } from './useProfileCard';
import { Hotbar } from '../../ds';
import { guestStageActions, ownerStageActions } from './stageActions';
import type { PetView } from '../../seams/worker';

vi.mock('../../pet/PetFigure', async (original) => ({
  ...(await original<typeof import('../../pet/PetFigure')>()),
  PetFigure: ({ name, outfit, wearing }: { name: string; outfit?: string; wearing?: string }) =>
    <span role="img" aria-label={`${name}${wearing ? `, wearing the ${wearing}` : ''}`} data-outfit={outfit ?? 'none'} />,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = {
  viewer: 'owner', tokenId: '9', name: 'Pixel', stage: 'adult', fullness: { state: 'full', level: 1 },
  skill: null, traits: ['clever', 'sociable'], energy: 7, hireMode: 'auto', wish: null,
  wishReserveYocto: '0', wishActive: false, outfitPrice: { cents: 0.76, yocto: '1660000000000000000000' },
  worn: null, outfits: [],
} as unknown as Extract<PetView, { viewer: 'owner' }>;
const guest = { ...owner, viewer: 'guest', skill: { label: 'weather' } } as unknown as Extract<PetView, { viewer: 'guest' }>;
let host: HTMLElement;
let root: Root;
const frame = (callback: FrameRequestCallback) => { callback(0); return 1; };
async function show(node: ReactNode) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(node));
}
function card(pet: PetView = owner, options: Partial<Parameters<typeof ProfileCard>[0]> = {}) {
  return <ProfileCard pet={pet} seal={{ kind: 'checked', hash: 'a'.repeat(64) }}
    onSealRetry={vi.fn()} onRetry={vi.fn()} onClose={vi.fn()} {...options} />;
}
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', frame);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

// spec: add-game-layout › Pet card screen › success (owner)
it('shows the owner profile and closes to the nameplate', async () => {
  const close = vi.fn();
  await show(<><button className="ds-hud__nameplate">Pixel</button>{card(owner, { onClose: close })}</>);
  expect(host.textContent).toContain("Pixel's card");
  expect(host.textContent).toContain('Grown-up');
  expect(host.textContent).toContain('Energy');
  expect(host.textContent).toContain('Work');
  expect(host.textContent).toContain('Friends');
  expect(host.textContent).toContain('Wish');
  expect(host.querySelector('.ds-pet-card__portrait [role="img"]')?.getAttribute('aria-label')).toContain('Pixel');
  // the DS Pet card draws «Close» as a text button (components.js › PetCard: `closeText`)
  const closeButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Close')!;
  await act(async () => closeButton.click());
  expect(close).toHaveBeenCalledOnce();
});

// spec: add-game-layout › Pet card screen › success (Seal)
it('explains a checked Seal and links to public verification', async () => {
  await show(card());
  expect(host.textContent).toContain('This mark checks that Pixel has the character sealed at birth. Game updates may change how we check it.');
  expect(host.querySelector<HTMLAnchorElement>('a[href="/pet/9/verify"]')?.textContent).toContain("Check it's really Pixel");
});

// spec: add-game-layout › Pet card screen › success (Work)
it('keeps work record, experience, skill and hiring in Work', async () => {
  const skill = vi.fn(); const mode = vi.fn();
  await show(card(owner, { onSkill: skill, onMode: mode }));
  expect(host.querySelector('a[href="/pet/9/work"]')?.textContent).toContain('View work record');
  expect(host.textContent).toContain('Review experience');
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Teach Pixel a skill'))!.click());
  expect(skill).toHaveBeenCalledOnce();
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent === 'Ask me first')!.click());
  expect(mode).toHaveBeenCalledWith('manual');
});

// spec: add-game-layout › Pet card screen › success (Friends)
it('opens the existing Relationships route', async () => {
  await show(card());
  expect(host.querySelector('a[href="/pet/9/relationships"]')?.textContent).toContain('Relationships');
});

// spec: add-debates › Debate transcript and deletion data › gift after paid line
it('shows a retained Past debates link in the new owner’s Friends section', async () => {
  await show(card(owner, { pastDebateCode: 'b'.repeat(32) }));
  const friends = [...host.querySelectorAll('section')].find((node) => node.textContent?.includes('Friends')) ?? host;
  expect(friends.querySelector<HTMLAnchorElement>('a[href="/debate#' + 'b'.repeat(32) + '"]')?.textContent).toBe('Past debates');
});

// spec: add-game-layout › Pet card screen › success (Wish)
it('shows the active wish, its reserve and opens the existing Wish sheet', async () => {
  const wish = vi.fn();
  await show(card({ ...owner, wish: { item: 'smart-glasses', reason: 'See better.', status: 'active', reserveYocto: '660000000000000000000' } } as PetView, { onWish: wish }));
  expect(host.textContent).toContain('Saved 0.30¢ of 0.76¢');
  expect(host.textContent).toContain('0.00066 of 0.00166 NEAR');
  const link = [...host.querySelectorAll('a')].find((item) => item.textContent === "Pixel's wish")!;
  expect(link.classList.contains('ds-link--standalone')).toBe(true);
  await act(async () => link.click());
  expect(wish).toHaveBeenCalledOnce();
});

// spec: add-game-layout › Pet card screen › success (before first wish)
it('shows the quiet no-wish line without an opening action', async () => {
  await show(card());
  expect(host.textContent).toContain('No wish yet for Pixel.');
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === "Pixel's wish")).toBe(false);
  expect([...host.querySelectorAll('a')].some((link) => link.textContent === "Pixel's wish")).toBe(false);
});

// spec: add-game-layout › Pet card screen › success (before first wish)
it('says every outfit is owned, or that the owner bought the wished outfit first, in the Wish section', async () => {
  const all = ['smart-glasses', 'bow-tie', 'headphones', 'daisy-crown', 'thinking-cap', 'party-hat', 'cozy-scarf'];
  await show(card({ ...owner, outfits: all } as unknown as PetView));
  expect(host.textContent).toContain('Pixel has every outfit for now.');
  expect(host.textContent).not.toContain('No wish yet for Pixel.');
  await act(async () => root.unmount());
  host.remove();
  await show(card(owner, { boughtByOwner: 'smart-glasses' }));
  expect(host.textContent).toContain('Pixel already has Smart glasses.');
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === "Pixel's wish")).toBe(false);
  expect([...host.querySelectorAll('a')].some((link) => link.textContent === "Pixel's wish")).toBe(false);
});

// spec: add-game-layout › Pet card screen › success (asleep owner)
it('keeps owner details readable but removes editing and hiring and offers Feed', async () => {
  const feed = vi.fn();
  await show(card({ ...owner, fullness: { state: 'asleep', level: 0 } } as PetView, { onFeed: feed }));
  expect(host.textContent).toContain('Energy');
  expect(host.textContent).toContain('Friends');
  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  expect(host.textContent).not.toContain('Teach Pixel a skill');
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Feed Pixel'))!.click());
  expect(feed).toHaveBeenCalledOnce();
});

// spec: add-game-layout › Pet card screen › success (guest)
it('shows only the public profile to guest and visitor', async () => {
  await show(card(guest));
  expect(host.querySelector('.ds-pet-card__portrait [role="img"]')?.getAttribute('aria-label')).toContain('Pixel');
  expect(host.textContent).toContain('Full');
  expect(host.textContent).toContain('Good at weather');
  expect(host.textContent).toContain('View work record');
  for (const privateWord of ['Energy', 'Friends', 'Wish', 'Relationships', 'Review experience', 'Auto']) {
    expect(host.textContent).not.toContain(privateWord);
  }
});

// spec: add-game-layout › Pet card screen › success (owner) × wardrobe change
it('updates the card portrait to the newly worn outfit', async () => {
  await show(card());
  expect(host.querySelector('.ds-pet-card__portrait [data-outfit]')?.getAttribute('data-outfit')).toBe('none');
  await act(async () => root.render(card({ ...owner, worn: 'thinking-cap' } as PetView)));
  expect(host.querySelector('.ds-pet-card__portrait [data-outfit]')?.getAttribute('data-outfit')).toBe('thinking-cap');
});

// spec: add-game-layout › Pet card screen › error
it('shows only the read error and retry, and no owner fields', async () => {
  const retry = vi.fn();
  await show(card(owner, { error: true, onRetry: retry }));
  expect(host.textContent).toContain("Couldn't open Pixel's card. Try again.");
  expect(host.textContent).not.toContain('Work');
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!.click());
  expect(retry).toHaveBeenCalledOnce();
});

function Harness({ read, mismatch, active = true, current = owner }: { read: () => Promise<PetView>; mismatch: (pet: PetView) => void; active?: boolean; current?: PetView }) {
  result = useProfileCard(read, 'owner', mismatch, active, current);
  return <span>{result.phase}</span>;
}
let result: ReturnType<typeof useProfileCard>;

// spec: add-game-layout › Pet card screen › error (owner changed)
it('closes owner details immediately when a fresh read reports a new owner', async () => {
  const mismatch = vi.fn();
  await show(<Harness read={async () => guest} mismatch={mismatch} />);
  await act(async () => { await result.open(); });
  expect(result.phase).toBe('closed');
  expect(result.pet).toBeNull();
  expect(mismatch).toHaveBeenCalledWith(guest);
});

// spec: add-game-layout › Pet card screen › error × stale read
it('rejects a delayed read after close and after a newer retry', async () => {
  let resolveFirst!: (pet: PetView) => void;
  const first = new Promise<PetView>((resolve) => { resolveFirst = resolve; });
  const read = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(owner);
  await show(<Harness read={read} mismatch={vi.fn()} />);
  await act(async () => { void result.open(); });
  await act(async () => { await result.open(); });
  expect(result.phase).toBe('ready');
  await act(async () => { resolveFirst(guest); await first; });
  expect(result.phase).toBe('ready');
  await act(async () => result.close());
  expect(result.pet).toBeNull();
});

// spec: add-game-layout › Pet card screen › error × session expiry
it('erases an open owner card when the session ends', async () => {
  const read = vi.fn().mockResolvedValue(owner);
  const mismatch = vi.fn();
  await show(<Harness read={read} mismatch={mismatch} />);
  await act(async () => { await result.open(); });
  await act(async () => root.render(<Harness read={read} mismatch={mismatch} active={false} />));
  expect(result.phase).toBe('closed');
  expect(result.pet).toBeNull();
});

// spec: add-game-layout › Pet card screen › success (owner) × confirmed feed
// spec: add-game-layout › Pet card screen › success (Wish) × wish update
it('keeps a card open and replaces its first read with later authoritative pet refreshes', async () => {
  const first = { ...owner, energy: 3 } as PetView;
  const refreshed = { ...owner, energy: 9, wish: { item: 'bow-tie', reason: 'Look smart.', status: 'active', reserveYocto: '1' } } as PetView;
  const read = vi.fn().mockResolvedValue(first);
  const mismatch = vi.fn();
  await show(<Harness read={read} mismatch={mismatch} current={owner} />);
  await act(async () => { await result.open(); });
  expect(result.pet).toBe(first);
  await act(async () => root.render(<Harness read={read} mismatch={mismatch} current={refreshed} />));
  expect(result.phase).toBe('ready');
  expect(result.pet).toBe(refreshed);
  expect(read).toHaveBeenCalledOnce();
});

// spec: add-game-layout › Pet card screen › error (owner changed) × confirmed transfer
it('closes an open owner card when a later authoritative refresh changes owner', async () => {
  const read = vi.fn().mockResolvedValue(owner);
  const mismatch = vi.fn();
  await show(<Harness read={read} mismatch={mismatch} current={owner} />);
  await act(async () => { await result.open(); });
  await act(async () => root.render(<Harness read={read} mismatch={mismatch} current={guest} />));
  expect(result.phase).toBe('closed');
  expect(result.pet).toBeNull();
  expect(mismatch).toHaveBeenCalledWith(guest);
});

const stageActions = (asleep = false) => ownerStageActions({ tokenId: '9', name: 'Pixel', asleep, away: false,
  feedOpen: false, errandOpen: false, watch: false, onFeed: vi.fn(), onErrand: vi.fn(), onWatch: vi.fn(), onGift: vi.fn() });
async function openMore() {
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
}

// spec: add-game-layout › Pet actions menu screen › success (awake owner)
it('opens Watch, Share and Give from the owner Hotbar', async () => {
  const actions = stageActions();
  await show(<Hotbar {...actions} />);
  await openMore();
  expect([...host.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent)).toEqual(['Watch something', 'Share Pixel', 'Give Pixel away']);
  expect(host.textContent).toContain('Close');
});

// spec: add-game-layout › Pet actions menu screen › success (sharing choices)
it('opens sharing choices and Back restores the More root', async () => {
  const actions = stageActions();
  const thought = vi.fn();
  await show(<Hotbar {...actions} shareItems={[
    { icon: 'share', label: 'Share a thought', onClick: thought },
    { icon: 'share', label: 'Share growth', onClick: vi.fn() },
    { icon: 'share', label: 'Share outfit', onClick: vi.fn() },
  ]} />);
  await openMore();
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.includes('Share Pixel'))!.click());
  expect(host.textContent).toContain('Share a thought');
  expect(host.textContent).toContain('Share growth');
  expect(host.textContent).toContain('Share outfit');
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === 'Share a thought')!.click());
  expect(thought).toHaveBeenCalledOnce();
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === 'Back')!.click());
  expect(host.textContent).toContain('Watch something');
});

// spec: add-game-layout › Pet actions menu screen › success (asleep owner)
it('keeps Watch and Share but removes Give for an asleep owner', async () => {
  await show(<Hotbar {...stageActions(true)} />);
  await openMore();
  expect(host.textContent).toContain('Watch something');
  expect(host.textContent).toContain('Share Pixel');
  expect(host.textContent).not.toContain('Give Pixel away');
});

// spec: add-game-layout › Pet actions menu screen › error × session expiry
it('drops the menu when the owner session stops, before another action can be picked', async () => {
  const actions = stageActions();
  await show(<Hotbar {...actions} active />);
  await openMore();
  await act(async () => root.render(<Hotbar {...actions} active={false} />));
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.disabled).toBe(true);
});

// spec: add-game-layout › Pet actions menu screen › error
it('replaces an open owner menu with guest actions after an ownership read', async () => {
  await show(<Hotbar key="owner" {...stageActions()} />);
  await openMore();
  expect(host.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => root.render(<Hotbar key="guest" items={guestStageActions('Pixel', false, vi.fn())} />));
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(host.textContent).toContain('Feed Pixel');
  expect(host.textContent).not.toContain('More');
  expect(host.textContent).not.toContain('Give Pixel away');
});
