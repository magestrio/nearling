// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { AdviceRead } from '../seams/worker-types';
import { AdviceColumn } from './AdviceColumn';

const mocks = vi.hoisted(() => ({ useAdvice: vi.fn() }));
vi.mock('./useAdvice', () => ({ useAdvice: mocks.useAdvice }));
vi.mock('../seams/auth', () => ({ useAuth: () => ({ sessionLine: null, needSession: () => true }) }));
vi.mock('../feeding/feedRequest', () => ({ useFeedRequest: () => null }));
vi.mock('../signin/SignInOutcome', () => ({ useSignInLines: () => [], SignInLines: () => null }));

afterEach(() => vi.clearAllMocks());

const read: AdviceRead = {
  price: { yocto: '380000000000000000000', cents: 0.38 }, skilled: false,
  screeningAvailable: true, screeningResetAt: null, workerAsleep: false, resting: null,
  payer: { tokenId: '9', name: 'Pixel', state: 'ok', until: null }, dropsAt: null,
  pending: null, last: null, paused: false,
};

// spec: add-game-layout › Pet stage rule › guest entries
it('keeps the live price and payer privacy note by the guest advice field after an answer', () => {
  mocks.useAdvice.mockReturnValue({
    read, blocker: null, draft: 'Can you help?', entries: [{ id: 'asked', kind: 'asked', text: 'Can you help?' }],
    busy: false, waiting: false, rose: false, characterRefused: false, screeningClosed: false,
    screeningFailed: false, setDraft: vi.fn(), ask: vi.fn(), retry: vi.fn(),
  });
  const markup = renderToStaticMarkup(<AdviceColumn tokenId="2" name="Biscuit" viewer="guest" asleep={false}
    advice={{ payer: { tokenId: '9', name: 'Pixel' }, tokenOf: async () => 'token', report: vi.fn(),
      payerChanged: vi.fn(), look: vi.fn(), onStatus: vi.fn(), covered: false, check: null,
      offline: '', carried: null, takeCarried: vi.fn() }} />);
  document.body.innerHTML = markup;
  const dock = document.querySelector('.ds-dock');
  expect(dock?.textContent).toContain('Your Pixel pays from its food.');
  expect(dock?.textContent).toContain('Biscuit\'s owner won\'t see your question or the answer.');
  expect(dock?.textContent).toContain('0.38¢');
  expect(document.querySelector('.ds-convo')?.textContent).not.toContain('Your Pixel pays');
  document.body.innerHTML = '';
});
