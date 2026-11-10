import { useCallback, useEffect, useRef, useState } from 'react';
import { Actions, Block, Button, Facts, Heading, Mono, Note, Progress, Sheet, Stack, Surface, Text } from '../ds';
import { formatCents } from '../lib/price';
import { nearPrice } from '../watch/view';
import { nameOf } from '../wardrobe/catalogue';
import { WorkerError, workerApi, type WishRead, type WishTarget } from '../seams/worker';
import { POLL_WARDROBE_MS } from '../wardrobe/useWardrobe';

const DISCLOSURE = "Saved food and a bought outfit are public on NEAR forever. The wish's words stay private.";
const UNAVAILABLE = 'Wish unavailable. Try again.';

export function wishProgress(wish: WishTarget, price: { cents: number; yocto: string }) {
  const saved = BigInt(wish.reserveYocto);
  const total = BigInt(price.yocto);
  const fraction = total > 0n ? Number(saved * 10000n / total) / 10000 : 0;
  return {
    fraction,
    cents: `Saved ${formatCents(price.cents * fraction)} of ${formatCents(price.cents)}`,
    near: `${nearPrice(wish.reserveYocto).replace(/ NEAR$/, '')} of ${nearPrice(price.yocto)}`,
  };
}

/** The nested Wish surface from design/bundle/screens/will.js, placed over the Stage with DS 0.48. */
export function WishSheet({ name, price, read, error, busy, pending, onClose, onRetry, onCancel, onContinue }: {
  name: string;
  price: { cents: number; yocto: string };
  read: WishRead | null;
  error: boolean;
  busy: boolean;
  pending?: boolean;
  onClose: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const wish = read?.wish ?? null;
  const progress = wish ? wishProgress(wish, price) : null;
  const waiting = wish?.status === 'waiting_day';
  const inherited = wish?.status === 'paused';
  const foot = !error && wish ? <Stack gap={3}>
    <Block role="trust" icon="globe" quiet><Text variant="small">{DISCLOSURE}</Text></Block>
    {inherited ? <Actions stackPhone><Button variant="secondary" off={busy || pending} onClick={onCancel}>Cancel wish</Button><Button off={busy || pending} onClick={onContinue}>Continue wish</Button></Actions>
      : <Button variant="secondary" block off={busy || pending} onClick={onCancel}>Cancel wish</Button>}
  </Stack> : undefined;
  // the Pet card's «{name}'s wish» opens it and the card closes as it does: the focus goes back to the card's opener
  return <Sheet title={`${name}'s wish`} column foot={foot} busy={busy} onClose={onClose}
    returnFocusTo={() => document.querySelector<HTMLElement>('.ds-hud__nameplate')}
    status={error ? UNAVAILABLE : waiting ? 'Buying tomorrow' : inherited ? `${name} has a wish in progress` : ''}>
    {error || !wish ? <Stack gap={3}><Note tone="error" silent>{UNAVAILABLE}</Note><Button variant="secondary" block onClick={onRetry}>Try again</Button></Stack> :
      <Stack gap={4}>
        {inherited && read?.releaseStatus === 'failed' ? <Note tone="error">Wish cancellation failed. Try again.</Note> : null}
        {inherited ? <Note tone="plain">{`${name} has a wish in progress`}</Note> : null}
        <Surface><Stack gap={3}>
          <Heading level={3}>{nameOf(wish.item) ?? wish.item}</Heading>
          <Text>{wish.reason}</Text>
          <Mono>{`${nearPrice(price.yocto)} · ${formatCents(price.cents)}`}</Mono>
        </Stack></Surface>
        {waiting ? <Note tone="status" silent>Buying tomorrow</Note> : null}
        <Stack gap={2}>
          <Progress value={progress!.fraction}>{progress!.cents}</Progress>
          <Text variant="small" tone="secondary" tabular>{progress!.near}</Text>
          <Facts size="small" items={[{ label: 'Earned food only', value: '' }]} />
        </Stack>
      </Stack>}
  </Sheet>;
}

/** Fresh owner read on open, return from a hidden tab and each action. The private view is never cached in browser storage. */
export function useWishSheet(tokenId: string, name: string, price: { cents: number; yocto: string }, tokenOf: () => Promise<string | null>, onOwnerLost: () => void, onReleased: () => void) {
  const [phase, setPhase] = useState<'closed' | 'loading' | 'ready' | 'error'>('closed');
  const [read, setRead] = useState<WishRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingFlag, setPendingFlag] = useState(false);
  const seq = useRef(0);
  const pending = useRef(false);
  const pendingKind = useRef<'cancel' | 'continue' | null>(null);
  const close = useCallback(() => { seq.current++; pending.current = false; pendingKind.current = null; setPendingFlag(false); setRead(null); setPhase('closed'); setBusy(false); }, []);
  const refresh = useCallback(async () => {
    const order = ++seq.current;
    try {
      const result = await workerApi.wish(await tokenOf(), tokenId);
      if (order !== seq.current) return;
      if (!result.wish) { pending.current = false; close(); onReleased(); return; }
      setRead(result);
      if (pendingKind.current === 'continue' && result.wish.status === 'active') {
        pending.current = false;
        pendingKind.current = null;
        setPendingFlag(false);
        onReleased();
      } else if (result.releaseStatus === 'failed') {
        pending.current = false;
        pendingKind.current = null;
        setPendingFlag(false);
      } else if (result.releaseStatus === 'unknown' && pendingKind.current !== 'continue') {
        pending.current = true;
        pendingKind.current = 'cancel';
        setPendingFlag(true);
      }
      setPhase('ready');
    } catch (e) {
      if (order !== seq.current) return;
      setRead(null);
      if (e instanceof WorkerError && (e.status === 401 || e.status === 403)) { close(); onOwnerLost(); return; }
      setPhase('error');
    }
  }, [tokenId, tokenOf, close, onOwnerLost, onReleased]);
  const open = useCallback(() => { setPhase('loading'); void refresh(); }, [refresh]);
  const cancel = useCallback(async () => {
    if (busy || pending.current || phase !== 'ready') return;
    pending.current = true;
    pendingKind.current = 'cancel';
    setRead((current) => current?.releaseStatus === 'failed' ? { ...current, releaseStatus: null } : current);
    setBusy(true);
    try {
      const result = await workerApi.cancelWish(await tokenOf(), tokenId);
      if (result.status === 'released') { close(); onReleased(); return; }
      setPendingFlag(true);
      await refresh();
    } catch (e) {
      pending.current = false;
      pendingKind.current = null;
      if (e instanceof WorkerError && (e.status === 401 || e.status === 403)) { close(); onOwnerLost(); return; }
      setPhase('error');
    } finally { setBusy(false); }
  }, [busy, phase, tokenId, tokenOf, close, onReleased, onOwnerLost, refresh]);
  const resumeWish = useCallback(async () => {
    if (busy || pending.current || phase !== 'ready' || read?.wish?.status !== 'paused') return;
    pending.current = true;
    pendingKind.current = 'continue';
    setBusy(true);
    try {
      const result = await workerApi.continueWish(await tokenOf(), tokenId);
      if (!('status' in result) || result.status === 'pending') setPendingFlag(true);
      await refresh();
    } catch (e) {
      pending.current = false;
      pendingKind.current = null;
      if (e instanceof WorkerError && (e.status === 401 || e.status === 403)) { close(); onOwnerLost(); return; }
      setPhase('error');
    } finally { setBusy(false); }
  }, [busy, phase, read?.wish?.status, tokenOf, tokenId, refresh, close, onOwnerLost]);
  useEffect(() => {
    if (phase === 'closed') return;
    const resume = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [phase, refresh]);
  useEffect(() => {
    if (!pendingFlag || phase === 'closed') return;
    const timer = window.setInterval(() => void refresh(), POLL_WARDROBE_MS);
    return () => window.clearInterval(timer);
  }, [pendingFlag, phase, refresh]);
  useEffect(() => close, [close, tokenId]);
  return { phase, read, busy, open, close, refresh, cancel, node: phase === 'ready' || phase === 'error'
    ? <WishSheet name={name} price={price} read={read} error={phase === 'error'} busy={busy} pending={pendingFlag} onClose={close} onRetry={() => void refresh()} onCancel={() => void cancel()} onContinue={() => void resumeWish()} /> : null };
}
