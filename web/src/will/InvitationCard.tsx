import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Cluster, Heading, Note, Stack, Surface, Text } from '../ds';
import { formatCents } from '../lib/price';
import { go, petPath } from '../route';
import { useAuth } from '../seams/auth';
import { workerApi, WorkerError, type WorkInvitation } from '../seams/worker';

// spec: add-pet-will › Work invitation card screen › success
// spec: add-pet-will › Work invitation card screen › several valid invitations
export function InvitationCard({ card, onAsk, onDismiss, onRetry, error, ended, busy }: {
  card: WorkInvitation; onAsk: () => void; onDismiss: () => void; onRetry?: () => void;
  error?: boolean; ended?: boolean; busy?: boolean;
}) {
  const nameId = `invitation-${card.id}`;
  return <Surface><Stack gap={2}>
    {ended ? <><Note tone="error">This invitation has ended.</Note>
      <Button variant="secondary" href="/hire">Find another pet</Button></> : <>
      <Heading level={2} variant="title-3">Work invitation</Heading>
      <Text id={nameId} variant="body-strong">{card.name}</Text>
      {card.label ? <Text variant="small" tone="secondary">{card.label}</Text> : null}
      <Text variant="small" tone="secondary">{formatCents(card.price.cents)}</Text>
      {error ? <Note tone="error">Could not update this invitation. Try again.</Note> : null}
      <Cluster gap={2}>
        <Button size="compact" variant="secondary" busy={busy} onClick={onAsk}>{`Ask ${card.name}`}</Button>
        <Button size="compact" variant="ghost" nameWith={nameId} busy={busy} onClick={onDismiss}>Dismiss</Button>
      </Cluster>
      {error ? <Button size="compact" variant="secondary" busy={busy} onClick={onRetry}>Try again</Button> : null}
    </>}
  </Stack></Surface>;
}

/** The cards are private to the current owner; every re-read replaces the set returned by the Worker. */
export function useInvitations(tokenId: string, owner: boolean, tokenOf: () => Promise<string | null>, ownerLost: () => void) {
  const auth = useAuth();
  const [cards, setCards] = useState<WorkInvitation[]>([]);
  const [ended, setEnded] = useState<WorkInvitation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [readError, setReadError] = useState(false);
  const [actionErrors, setActionErrors] = useState<Record<string, 'ask' | 'dismiss'>>({});
  const readGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++readGeneration.current;
    if (!owner || !auth.authenticated || auth.sessionEnded) { setCards([]); setEnded(null); setReadError(false); setActionErrors({}); return; }
    try {
      const token = await tokenOf();
      if (!token) { if (generation === readGeneration.current) setReadError(true); return; }
      const answer = await workerApi.invitations(token, tokenId);
      if (generation === readGeneration.current) {
        setCards([...answer.invitations].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)));
        setReadError(false);
      }
    } catch (error) {
      if (generation === readGeneration.current && error instanceof WorkerError && (error.status === 401 || error.code === 'not_owner')) {
        setCards([]); setEnded(null); ownerLost();
      } else if (generation === readGeneration.current) setReadError(true);
    }
  }, [owner, auth.authenticated, auth.sessionEnded, tokenOf, tokenId, ownerLost]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { readGeneration.current += 1; }, []);
  useEffect(() => {
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    const interval = setInterval(visible, 10_000);
    return () => { document.removeEventListener('visibilitychange', visible); clearInterval(interval); };
  }, [load]);
  const act = async (card: WorkInvitation, kind: 'ask' | 'dismiss') => {
    if (busy || !owner || !auth.authenticated || auth.sessionEnded) return;
    if (card.expiresAt <= Date.now()) { setCards((rows) => rows.filter((row) => row.id !== card.id)); setEnded(card); return; }
    setBusy(card.id);
    setActionErrors((now) => { const next = { ...now }; delete next[card.id]; return next; });
    try {
      const token = await tokenOf();
      if (!token) { setActionErrors((now) => ({ ...now, [card.id]: kind })); return; }
      if (kind === 'ask') {
        const accepted = await workerApi.acceptInvitation(token, tokenId, card.id);
        setCards((rows) => rows.filter((row) => row.id !== card.id));
        go(petPath(accepted.workerId, tokenId));
      } else {
        await workerApi.dismissInvitation(token, tokenId, card.id);
        setCards((rows) => rows.filter((row) => row.id !== card.id));
      }
    } catch (error) {
      if (error instanceof WorkerError && error.code === 'invitation_ended') {
        setCards((rows) => rows.filter((row) => row.id !== card.id)); setEnded(card);
      } else if (error instanceof WorkerError && (error.status === 401 || error.code === 'not_owner')) {
        setCards([]); setEnded(null); ownerLost();
      } else setActionErrors((now) => ({ ...now, [card.id]: kind }));
    } finally { setBusy(null); }
  };
  return { cards, ended, busy, readError, actionErrors, retryRead: () => void load(),
    ask: (card: WorkInvitation) => void act(card, 'ask'), dismiss: (card: WorkInvitation) => void act(card, 'dismiss'),
    retryAction: (card: WorkInvitation) => void act(card, actionErrors[card.id] ?? 'ask') };
}
