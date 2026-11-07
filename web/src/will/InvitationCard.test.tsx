// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { InvitationCard, useInvitations } from './InvitationCard';
import { WorkerError } from '../seams/worker';

const mocks = vi.hoisted(() => ({ invitations: vi.fn(), dismiss: vi.fn(), accept: vi.fn() }));
vi.mock('../seams/worker', async (original) => ({
  ...(await original<typeof import('../seams/worker')>()),
  workerApi: { invitations: mocks.invitations, dismissInvitation: mocks.dismiss, acceptInvitation: mocks.accept },
}));
vi.mock('../seams/auth', () => ({ useAuth: () => ({ authenticated: true, sessionEnded: false }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const card = { id: 'a'.repeat(24), workerId: '2', name: 'Biscuit', label: 'Good at weather',
  price: { cents: 0.38, yocto: '830000000000000000000' }, createdAt: 2, expiresAt: 9 };
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

// spec: add-pet-will › Work invitation card screen › success
it('shows public worker details and distinct Ask and Dismiss controls', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const ask = vi.fn(); const dismiss = vi.fn();
  await act(async () => root.render(<InvitationCard card={card} onAsk={ask} onDismiss={dismiss} />));
  expect(host.textContent).toContain('Work invitation');
  expect(host.textContent).toContain('Good at weather');
  expect(host.textContent).toContain('0.38¢');
  expect(host.textContent).not.toContain('question');
  await act(async () => host.querySelectorAll('button')[0]?.click());
  await act(async () => host.querySelectorAll('button')[1]?.click());
  expect(ask).toHaveBeenCalledOnce(); expect(dismiss).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

// spec: add-pet-will › Work invitation card screen › error
it('ends without an action that can start a hire', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<InvitationCard card={card} ended onAsk={vi.fn()} onDismiss={vi.fn()} />));
  expect(host.textContent).toContain('This invitation has ended.');
  expect(host.textContent).toContain('Find another pet');
  expect(host.textContent).not.toContain('Ask Biscuit');
  await act(async () => root.unmount());
});

const tokenOf = async () => 'token';
const ownerLost = () => undefined;
function Invitations() {
  const invitations = useInvitations('9', true, tokenOf, ownerLost);
  return <div>
    {invitations.readError ? <><span role="alert">Work invitations unavailable. Try again.</span><button onClick={invitations.retryRead}>Retry read</button></> : null}
    {invitations.cards.map((item) => <InvitationCard key={item.id} card={item}
      error={Boolean(invitations.actionErrors[item.id])} onRetry={() => invitations.retryAction(item)}
      onAsk={() => invitations.ask(item)} onDismiss={() => invitations.dismiss(item)} />)}
  </div>;
}

// spec: add-pet-will › Work invitation card screen › success
it('announces a failed invitation read and retries without losing existing cards', async () => {
  const liveCard = { ...card, expiresAt: Date.UTC(2099, 0, 1) };
  mocks.invitations.mockResolvedValueOnce({ invitations: [liveCard] }).mockRejectedValueOnce(new WorkerError(503, 'chain_unreachable'))
    .mockResolvedValueOnce({ invitations: [liveCard] });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<Invitations />));
  expect(host.textContent).toContain('Ask Biscuit');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Work invitations unavailable');
  expect(host.textContent).toContain('Ask Biscuit');
  await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Retry read'))!.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => root.unmount());
});

// spec: add-pet-will › Work invitation card screen › success
it('keeps a card with an announced retry after a failed Dismiss action', async () => {
  const liveCard = { ...card, expiresAt: Date.UTC(2099, 0, 1) };
  mocks.invitations.mockResolvedValue({ invitations: [liveCard] });
  mocks.dismiss.mockRejectedValueOnce(new WorkerError(503, 'chain_unreachable')).mockResolvedValueOnce({ ok: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<Invitations />));
  await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Dismiss'))!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not update this invitation. Try again.');
  expect(host.textContent).toContain('Ask Biscuit');
  await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Try again'))!.click());
  expect(mocks.dismiss).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain('Ask Biscuit');
  await act(async () => root.unmount());
});
