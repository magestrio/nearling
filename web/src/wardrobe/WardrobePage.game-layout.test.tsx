// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerView } from '../screens/pet/usePetScreen';
import type { useWardrobe } from './useWardrobe';

vi.mock('../pet/PetFigure', async (original) => ({
  ...(await original<typeof import('../pet/PetFigure')>()),
  PetFigure: ({ outfit, still }: { outfit?: string; still?: boolean }) =>
    <div data-testid="pet-figure" data-outfit={outfit ?? 'none'} data-still={still ? 'true' : 'false'} />,
}));
vi.mock('../screens/pet/useWaking', () => ({ useWaking: () => false }));
vi.mock('../seams/auth', () => ({ useAuth: () => ({ sessionLine: false, needSession: () => true }) }));
vi.mock('../signin/SignInOutcome', () => ({ useSignInLines: () => [], SignInLines: () => null }));

import { NewOutfitNotice } from './NewOutfitNotice';
import { WardrobePage } from './WardrobePage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pet = {
  viewer: 'owner', tokenId: '9', name: 'Pixel', stage: 'adult', mood: 'happy',
  fullness: { state: 'full', level: 1 }, outfits: ['daisy-crown', 'thinking-cap', 'party-hat'],
  worn: 'thinking-cap', outfitPrice: { cents: 0.76, yocto: '1660000000000000000000' },
} as OwnerView;
const view = {
  owned: ['daisy-crown', 'thinking-cap', 'party-hat'], worn: 'thinking-cap',
  price: { cents: 0.76, yocto: '1660000000000000000000' },
  short: false, shopPaused: false, buying: null, outcome: null,
} as NonNullable<ReturnType<typeof useWardrobe>['view']>;
const wardrobe = {
  load: { kind: 'ready', view }, view, failed: null, tapped: null, bought: null,
  wearing: null, read: vi.fn(), dropFailed: vi.fn(), wear: vi.fn(), buy: vi.fn(), retryRead: vi.fn(),
} as unknown as ReturnType<typeof useWardrobe>;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe('Wardrobe on the game layout', () => {
  // spec: add-wardrobe › Wardrobe screen › success
  it('keeps the Wardrobe frame split and the worn pet while stage navigation opens its own page', async () => {
    await act(async () => root.render(<WardrobePage
      pet={pet} w={wardrobe} figure={{ lost: false, onLost: vi.fn(), hub: {} as never, motion: null }}
      accent="mint" account={null} banner={null} bannerLine="" offline="" covered={false} layer={null}
    />));
    expect(host.querySelector('.ds-split--start .ds-stage')).not.toBeNull();
    expect(host.querySelector('.ds-split__end .ds-item-grid')).not.toBeNull();
    expect(host.querySelector('[data-testid="pet-figure"]')?.getAttribute('data-outfit')).toBe('thinking-cap');
    expect(host.querySelector('.ds-split__end')?.textContent).toContain('Take off');
    expect(host.querySelector('.ds-split__end')?.textContent).toContain('Buy · 0.76¢');
    expect(host.querySelector('.ds-header__start a')?.getAttribute('href')).toBe('/pet/9');
  });

  // spec: add-wardrobe › New outfit notice screen › success
  it('shows the earned outfit in a centered Sheet with its title focused', async () => {
    const onWear = vi.fn();
    const onLater = vi.fn();
    await act(async () => root.render(<NewOutfitNotice pet={pet} slug="cozy-scarf" wearing={false} failed={false} onWear={onWear} onLater={onLater} />));
    expect(host.querySelector('.ds-sheet-layer--centered [role="dialog"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('New outfit!');
    expect(host.querySelector('[data-testid="pet-figure"]')?.getAttribute('data-outfit')).toBe('cozy-scarf');
    expect(host.querySelector('[data-testid="pet-figure"]')?.getAttribute('data-still')).toBe('true');
    expect(host.textContent).toContain('Pixel earned the Cozy scarf for a 3-day streak.');
    const wear = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Wear it');
    await act(async () => wear!.click());
    expect(onWear).toHaveBeenCalledOnce();
  });

  // spec: add-wardrobe › New outfit notice screen › error
  it('returns to the former outfit and focuses Later after Wear it fails', async () => {
    const onLater = vi.fn();
    const show = (failed: boolean) => <NewOutfitNotice
      pet={pet} slug="cozy-scarf" wearing={false} failed={failed} onWear={vi.fn()} onLater={onLater}
    />;
    await act(async () => root.render(show(false)));
    await act(async () => root.render(show(true)));
    expect(host.querySelector('[data-testid="pet-figure"]')?.getAttribute('data-outfit')).toBe('thinking-cap');
    expect(host.textContent).toContain("Couldn't put it on just now. The Cozy scarf is waiting in Pixel's wardrobe.");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Couldn't put it on just now.");
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Wear it')).toBe(false);
    expect(document.activeElement?.textContent).toBe('Later');
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(onLater).toHaveBeenCalledOnce();
  });
});
