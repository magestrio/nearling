// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ track: vi.fn(), render: vi.fn() }));
vi.mock('../track', () => ({ track: mocks.track }));
vi.mock('../pet/PetFigure', () => ({ PetFigure: () => null }));
vi.mock('./card', async () => ({ ...(await vi.importActual<typeof import('./card')>('./card')), renderCard: mocks.render }));

import { VerdictCard } from './VerdictCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST = { lineId: 'e1', claim: 'Octopuses have three hearts.', verdict: 'True' as const, sources: 2 };
const PET = { tokenId: '9', name: 'Pixel', stage: 'adult' as const, state: 'full' as const, worn: null };
let root: Root | null = null;
let host: HTMLElement;

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<VerdictCard request={REQUEST} pet={PET} />));
}
const button = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(name));
const shareMenu = vi.fn();

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  mocks.track.mockReset();
  mocks.render.mockReset();
  shareMenu.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:card');
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  Reflect.deleteProperty(navigator, 'share');
  Reflect.deleteProperty(navigator, 'canShare');
});

describe('the Verdict card sheet', () => {
  // spec: add-pet-errands › Errand events data › card shared
  it('sends report_shared on «Save image», once a tap, and nothing before it', async () => {
    mocks.render.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    await mount();
    expect(mocks.track).not.toHaveBeenCalled();
    await act(async () => button('Save image')!.click());
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith('report_shared');
    await act(async () => button('Save image')!.click());
    expect(mocks.track).toHaveBeenCalledTimes(2);
  });

  // spec: add-pet-errands › Errand events data › card shared
  it('sends report_shared on «Share» and gives the share menu the image and the pet\'s link', async () => {
    mocks.render.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: shareMenu, configurable: true });
    await mount();
    await act(async () => button('Share')!.click());
    expect(mocks.track).toHaveBeenCalledWith('report_shared');
    const handed = shareMenu.mock.calls[0]![0] as { files: File[]; url: string };
    expect(handed.files[0]!.type).toBe('image/png');
    expect(handed.files[0]!.name).toBe('Pixel-verdict.png');
    expect(handed.url).toMatch(/\/pet\/9$/);
  });

  // spec: add-pet-errands › Verdict card screen › success
  it('has no «Share» where the browser cannot share files, and a closed share menu changes nothing', async () => {
    mocks.render.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    await mount();
    expect(button('Share')).toBeUndefined();
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: vi.fn().mockRejectedValue(new DOMException('closed', 'AbortError')), configurable: true });
    await act(async () => root!.render(<VerdictCard request={{ ...REQUEST }} pet={PET} />));
    await act(async () => button('Share')!.click());
    expect(host.textContent).toContain('Save image');
  });

  // spec: add-pet-errands › Verdict card screen › error
  it('says «We couldn\'t make the card just now. Try again.» with «Try again» when the drawing fails, and draws again', async () => {
    mocks.render.mockRejectedValueOnce(new Error('no image')).mockResolvedValueOnce(new Blob(['png'], { type: 'image/png' }));
    await mount();
    expect(host.textContent).toContain("We couldn't make the card just now. Try again.");
    expect(button('Save image')).toBeUndefined();
    expect(mocks.track).not.toHaveBeenCalled();
    await act(async () => button('Try again')!.click());
    expect(button('Save image')).toBeDefined();
    expect(host.textContent).not.toContain("We couldn't make the card");
  });
});
