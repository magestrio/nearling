import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyField, Note, Sheet, Text } from '../ds';
import { TOAST_MS } from '../ds/Toast';
import { useAuth } from '../seams/auth';
import { WorkerError, toastHeld, workerApi } from '../seams/worker';
import { track } from '../track';
import { Failure } from './Failure';
import { closeAddNear, showFeedToast, useAddNearRequest, type AddNearRequest } from './feedRequest';

// Add NEAR sheet (`Add NEAR sheet screen`, built from design/bundle/screens/feed.js): the address of the player's game wallet, where
// they send NEAR from another wallet or an exchange — the game sells none. It is a step inside Feed sheet, or a sheet of its own
// when another surface opens it (`openAddNear`, the Gift sheet of `add-gift`). While it is open the server is asked for the balance
// every `WATCH_MS`; NEAR that comes is «Your NEAR is here!» for 4 s, then the sheet it was opened from again.
export const WATCH_MS = 5000;

export const SEND = 'Send NEAR to this address from another wallet or an exchange.';
export const STAYS =
  'NEAR you add here stays in this game — it feeds pets and pays the small network fees. The game has no way to send it back out, so add only what you plan to use.';
export const WAITING = 'Waiting for your NEAR…';
export const ARRIVED = 'Your NEAR is here!';
export const COPIED = 'Address copied.';
export const BY_HAND = 'Select the address and copy it by hand.';
const NO_ADDRESS = "We couldn't show your address right now. Try again in a moment.";

type View = { kind: 'reading' } | { kind: 'failed' } | { kind: 'ready'; address: string } | { kind: 'arrived'; address: string };

/** The words the sheet's live region says for the step. NEAR that came is said first: the words of a copy stand only while the
 *  step waits, or «Your NEAR is here!» would never be announced. */
export function addNearStatus(view: View, copy: 'copied' | 'by-hand' | null): string {
  if (view.kind === 'arrived') return ARRIVED;
  if (view.kind !== 'ready') return '';
  if (copy === 'copied') return COPIED;
  if (copy === 'by-hand') return BY_HAND;
  return WAITING;
}

/** The body of the step. `onStatus` hands the sheet the words of each outcome for its live region; `onArrived` is called 4 s after
 *  NEAR came; `onClose` closes the whole sheet when the session ended under the tap. */
export function AddNearBody({
  from,
  onStatus,
  onArrived,
  onClose,
}: {
  from: AddNearRequest['from'];
  onStatus: (text: string) => void;
  onArrived: () => void;
  onClose: () => void;
}) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [view, setView] = useState<View>({ kind: 'reading' });
  const [copy, setCopy] = useState<'copied' | 'by-hand' | null>(null);
  const reading = useRef(false);
  const alive = useRef(true);
  const arrived = view.kind === 'arrived';
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    track('add_near_opened', { from });
    return () => {
      alive.current = false;
    };
  }, [from]);

  /** One read of the wallet. `byTap`: the player's own action asked for it (opening, «Try again»). */
  const read = useCallback(async (byTap: boolean) => {
    if (reading.current) return;
    reading.current = true;
    try {
      const a = authRef.current;
      const token = a.authenticated ? await a.getIdentityToken() : null;
      if (token === null) throw new WorkerError(401, 'signed_out');
      const wallet = await workerApi.wallet(token);
      if (!alive.current) return;
      // NEAR that came: the first answer to say so, and the sheet stays on it until it goes back
      setView((now) => (now.kind === 'arrived' ? now : { kind: wallet.funded ? 'arrived' : 'ready', address: wallet.address }));
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof WorkerError && e.status === 401) {
        authRef.current.endSession(true, byTap);
        if (byTap) closeRef.current();
        return;
      }
      setView((now) => (now.kind === 'reading' || now.kind === 'failed' ? { kind: 'failed' } : now));
    } finally {
      reading.current = false;
    }
  }, []);

  useEffect(() => {
    if (view.kind === 'reading') void read(true);
  }, [view.kind, read]);

  // The watch: not in a hidden tab, not once the session ended, not after NEAR came.
  const watching = view.kind === 'ready';
  const ended = auth.sessionEnded;
  useEffect(() => {
    if (!watching || ended) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) void read(false);
    }, WATCH_MS);
    const onVisible = () => {
      if (!document.hidden) void read(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [watching, ended, read]);

  // «Your NEAR is here!» stands 4 s, the Toast's time; then the sheet it came from, with the new amount.
  const goBack = useRef(onArrived);
  goBack.current = onArrived;
  useEffect(() => {
    // only the e2e mode's fakes hold it: a capture of the frame is taken seconds after the page loads, past the 4 s
    if (!arrived || toastHeld()) return undefined;
    const timer = setTimeout(() => goBack.current(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [arrived]);

  useEffect(() => {
    onStatus(addNearStatus(view, copy));
  }, [view, copy, onStatus]);

  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopy('copied');
      showFeedToast(COPIED);
    } catch {
      setCopy('by-hand');
      // the address is selected, so the player's own copy is one shortcut away
      const value = box.current?.querySelector('.ds-copy__value');
      if (value) window.getSelection()?.selectAllChildren(value);
    }
  };

  if (view.kind === 'reading') return null;
  if (view.kind === 'failed') {
    return (
      <Failure
        onRetry={() => {
          if (!authRef.current.needSession()) {
            closeRef.current();
            return;
          }
          setView({ kind: 'reading' });
        }}
      >
        {NO_ADDRESS}
      </Failure>
    );
  }
  return (
    <>
      <Text>{SEND}</Text>
      <div ref={box}>
        <CopyField mono label="NEAR address" value={view.address} onCopy={() => void copyAddress(view.address)} />
      </div>
      {copy === 'by-hand' ? <Note tone="plain" silent>{BY_HAND}</Note> : null}
      {arrived ? (
        <Note tone="plain" icon="check" silent>
          {ARRIVED}
        </Note>
      ) : (
        <>
          <Text>{STAYS}</Text>
          <Note tone="status" silent>
            {WAITING}
          </Note>
        </>
      )}
    </>
  );
}

/** Add NEAR on its own: opened by another surface, which gets `onBack` when the player goes back or NEAR arrived. */
export function AddNearSheet({ request }: { request: AddNearRequest }) {
  const [status, setStatus] = useState('');
  const back = () => {
    closeAddNear();
    request.onBack();
  };
  return (
    // «Close» and Esc leave the step as «Back» does: closed with nothing sent, it returns to where it was opened from
    // (`Add NEAR sheet screen` › «Закрытый без перевода, лист возвращает туда, откуда открыт»)
    <Sheet title="Add NEAR" onBack={back} onClose={back} status={status}>
      <AddNearBody from={request.from} onStatus={setStatus} onArrived={back} onClose={closeAddNear} />
    </Sheet>
  );
}

/** Where the standalone step stands, if one is open. */
export function AddNearLayer() {
  const request = useAddNearRequest();
  return request ? <AddNearSheet request={request} /> : null;
}
