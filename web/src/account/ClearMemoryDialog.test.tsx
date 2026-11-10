// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../seams/auth-context';
import { ClearMemoryDialog } from './ClearMemoryDialog';

function render(unsettledSharedJob: boolean) {
  return renderToStaticMarkup(
    <AuthContext.Provider value={{} as AuthApi}>
      <ClearMemoryDialog
        tokenId="9"
        name="Pixel"
        unsettledSharedJob={unsettledSharedJob}
        onClose={() => undefined}
        onDone={() => undefined}
        onRetry={() => undefined}
        onNotOwner={() => undefined}
        returnFocusTo={() => null}
      />
    </AuthContext.Provider>,
  );
}

// spec: add-account › Clear memory dialog screen › success
it('uses the exact H31 description of what is forgotten and retained', () => {
  const html = render(false);
  expect(html).toContain('Pixel will forget your chats, diary, skill with its data sources and code, and what it knows about you, its feeders and the pets it helped. Your published data sources leave the catalog. A backup may keep a copy up to 30 days; NEAR AI may keep what it received.');
  expect(html).toContain("Pixel&#x27;s name, character, growth, streak, outfits and food stay");
  // spec: add-pet-experience › Experience clear flow › clear warning
  expect(html).toContain('what&#x27;s on the chain about Pixel stays public forever');
  expect(html).toContain('Work notes and the public field will be erased. Paid work counts and receipts stay public forever.');
  expect(html.indexOf('Keep memory')).toBeLessThan(html.indexOf('Clear memory'));
});

it('renders the signed-close copy when the dialog is given an unsettled shared job', () => {
  const html = render(true);
  const forgotten = html.indexOf('Pixel will forget your chats');
  const warning = html.indexOf('Clearing memory will close this shared link. You&#x27;ll sign approval so unused food can return to Pixel.');
  const stays = html.indexOf('name, character, growth, streak');
  expect(forgotten).toBeGreaterThanOrEqual(0);
  expect(warning).toBeGreaterThan(forgotten);
  expect(stays).toBeGreaterThan(warning);
  expect(html.indexOf('Keep memory')).toBeLessThan(html.indexOf('Clear memory'));
});

// spec: add-pet-experience › Experience clear flow › clear warning
it('keeps the warning after both experience reads fail', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const fetchMock = vi.fn(async (_path: string) => Response.json({ code: 'unreachable' }, { status: 503 }));
  vi.stubGlobal('fetch', fetchMock);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(
      <AuthContext.Provider value={{ getIdentityToken: async () => 'token' } as AuthApi}>
        <ClearMemoryDialog tokenId="9" name="Pixel" onClose={() => undefined} onDone={() => undefined}
          onRetry={() => undefined} onNotOwner={() => undefined} returnFocusTo={() => null} />
      </AuthContext.Provider>,
    ));
    // spec: add-account › Clear memory dialog screen › success
    expect(document.activeElement?.textContent).toBe('Keep memory');
    expect(host.querySelector('button[data-autofocus]')?.textContent).toBe('Keep memory');
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => String(path).includes('/experience') || String(path).endsWith('/work'))).toHaveLength(2));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('Work notes and the public field will be erased. Paid work counts and receipts stay public forever.');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
