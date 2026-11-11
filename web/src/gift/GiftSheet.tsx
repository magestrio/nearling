import { useCallback, useEffect, useRef, useState } from 'react';
import { Block, Button, Cluster, Note, Sheet, Stack, Text, TextField } from '../ds';
import { openClearMemory } from '../account/clearMemory';
import { sharedJobOf } from '../errands/sharedApproval';
import { feedOpenNow, openAddNear, showFeedToast, useAddNearRequest } from '../feeding/feedRequest';
import { currentFlight } from '../feeding/feedFlight';
import { sha256Hex, toBase64 } from '../feeding/feedTx';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi, type GiftLink, type GiftOutcome } from '../seams/worker';
import { checkGiftTx } from './giftTx';
import { GiftGate, PendingGiftSend } from './giftMachine';
import { closeGift, giftOpenNow, markGiftGiven, openGift, useGiftRequest } from './giftRequest';
import { PetFigure } from '../pet/PetFigure';
import type { OutfitSlug, Stage } from '../seams/worker';

type Phase = 'opening' | 'error' | 'initial' | 'waiting' | 'cancelled' | 'accepted' | 'sending' | 'checking' | 'given' | 'failed' | 'gas' | 'short' | 'paused';
const LOADING_ERROR = "We couldn't open gifting right now. Try again in a moment.";
const ONLY = (name: string) => `Send this link only to your friend, not to a group chat — anyone who opens it can ask for ${name}. You still choose who gets ${name}.`;
const invite = (name: string) => `I'm giving you ${name}! Open this link to take ${name} home:`;
const linkUrl = (code: string) => new URL(`/gift/${code}`, window.location.origin).toString();
export function missingNear(yocto: string): string {
  const amount = BigInt(yocto);
  return (Number((amount + 10n ** 22n - 1n) / 10n ** 22n) / 100).toFixed(2);
}

export function GiftSheet({ tokenId, name, stage, worn, onGiven }: { tokenId: string; name: string; stage: Stage; worn: OutfitSlug | null; onGiven: () => void }) {
  const request = useGiftRequest();
  const addNear = useAddNearRequest();
  const auth = useAuth();
  const [phase, setPhase] = useState<Phase>(request?.given ? 'given' : 'opening');
  const [link, setLink] = useState<GiftLink>({ status: 'none' });
  const [hatched, setHatched] = useState(false);
  const [share, setShare] = useState<'manual' | 'copied' | null>(null);
  const [missing, setMissing] = useState('0.01');
  const [status, setStatus] = useState(request?.given ? `${name} is ${request.friend || 'a friend'}'s now. Thanks for taking such good care of ${name}!` : '');
  const gate = useRef(new GiftGate());
  const seen = useRef<string | null>(null);
  const started = useRef(0);
  const polling = useRef(false);
  const signed = useRef(new PendingGiftSend());
  const focusRoot = useRef<HTMLDivElement | null>(null);
  const previousPhase = useRef<Phase>(phase);
  const opener = useRef<HTMLElement | null>(null);
  const clearButton = useRef<HTMLElement | null>(null);
  const active = request?.tokenId === tokenId && addNear === null;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => { return () => { activeRef.current = false; }; }, []);
  const friend = link.acceptedName || request?.friend || 'a friend';
  const unnamed = friend === 'a friend';

  useEffect(() => {
    if (previousPhase.current === phase) return;
    previousPhase.current = phase;
    if (!active || (request?.self && phase === 'accepted')) return;
    const frame = requestAnimationFrame(() => {
      const root = focusRoot.current;
      const target = phase === 'waiting' ? root?.querySelector<HTMLElement>('[data-gift-share] button')
        : phase === 'sending' || phase === 'checking' ? root?.querySelector<HTMLElement>('[data-gift-give] button')
        : phase === 'initial' ? root?.querySelector<HTMLElement>('[data-gift-create] button')
        : phase === 'error' ? root?.querySelector<HTMLElement>('[data-gift-retry] button')
        : root?.querySelector<HTMLElement>('[data-gift-outcome]')
          ?? (phase === 'short' || phase === 'gas' ? root?.querySelector<HTMLElement>('[data-gift-add] button') : null);
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, phase, request?.self]);
  useEffect(() => {
    if (share !== 'manual') return;
    const field = focusRoot.current?.querySelector<HTMLTextAreaElement>('textarea[readonly]');
    field?.focus();
    field?.select();
  }, [share]);

  const token = useCallback(async () => {
    if (!auth.needSession()) return null;
    const value = await auth.getIdentityToken();
    if (value === null) auth.endSession(true, true);
    return value;
  }, [auth]);

  const load = useCallback(async () => {
    setPhase('opening'); setStatus(''); setShare(null);
    try {
      const t = await token();
      if (!t) return;
      const [fresh, me] = await Promise.all([workerApi.giftLink(t, tokenId), workerApi.me(t)]);
      setHatched(me.hatched?.tokenId === tokenId);
      setLink(fresh);
      if (fresh.status === 'accepted') {
        setPhase('accepted');
        setStatus(`${fresh.acceptedName || 'A friend'} wants to take ${name} home.`);
        seen.current = `${fresh.code}:${fresh.version}`;
      } else setPhase(fresh.status === 'waiting' ? 'waiting' : 'initial');
    } catch (error) {
      if (error instanceof WorkerError && error.status === 401) auth.endSession(true, true);
      else setPhase('error');
    }
  }, [auth, token, tokenId, name]);

  useEffect(() => { if (active && !request?.given) void load(); }, [active, load, request?.given]);
  useEffect(() => {
    if (request?.tokenId !== tokenId) return;
    return () => { gate.current.release(); signed.current.clear(); };
  }, [request?.tokenId, tokenId]);
  // The accepted link can arrive while this page is open or while the pet sleeps. A closed accepted sheet
  // stays closed until its version changes or the page is opened again.
  useEffect(() => {
    if (!auth.authenticated || auth.sessionEnded) return;
    let alive = true;
    const poll = async () => {
      if (document.hidden || feedOpenNow() || currentFlight() !== null || giftOpenNow()?.tokenId === tokenId) return;
      try {
        const t = await auth.getIdentityToken();
        if (!t) return;
        const fresh = await workerApi.giftLink(t, tokenId);
        const version = `${fresh.code}:${fresh.version}`;
        if (alive && fresh.status === 'accepted' && version !== seen.current) {
          seen.current = version;
          opener.current = null;
          setLink(fresh);
          openGift({ tokenId, name, self: true });
        }
      } catch { /* The Pet screen's own connection state handles a lost read. */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    const visible = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [auth, tokenId, name]);

  const close = () => { if (phase === 'sending' || phase === 'checking') return; closeGift(); };
  const create = async () => {
    if (!gate.current.take()) return;
    try {
      const t = await token(); if (!t) return;
      const fresh = await workerApi.createGift(t, tokenId);
      setShare(null); setLink(fresh); setPhase('waiting'); setStatus('Your gift link is ready.');
      if (fresh.code) void shareLink(fresh.code);
    } catch (error) {
      if (error instanceof WorkerError && error.status === 401) auth.endSession(true, true);
      else setPhase('error');
    } finally { gate.current.release(); }
  };
  const shareLink = async (code: string) => {
    const url = linkUrl(code);
    if (typeof navigator.share === 'function') {
      try { await navigator.share({ text: invite(name), url }); return; }
      catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(`${invite(name)} ${url}`);
      setShare('copied'); setStatus('Link copied — send it to a friend.'); showFeedToast('Link copied — send it to a friend.');
    } catch { setShare('manual'); setStatus('Copy this link and send it to a friend:'); }
  };
  const cancel = async () => {
    if (!gate.current.take()) return;
    try {
      const t = await token(); if (!t) return;
      await workerApi.cancelGift(t, tokenId);
      setLink({ status: 'none' }); setPhase('cancelled'); setStatus("Gift cancelled. That link won't work anymore.");
    } catch (error) {
      if (error instanceof WorkerError && error.status === 401) auth.endSession(true, true);
      else setPhase('error');
    } finally { gate.current.release(); }
  };
  const outcome = useCallback((result: GiftOutcome) => {
    if (result.status !== 'unknown') signed.current.clear();
    if (result.status === 'ok') { setPhase('given'); setStatus(`${name} is ${friend}'s now. Thanks for taking such good care of ${name}!`); markGiftGiven(tokenId, friend); gate.current.release(); onGiven(); }
    else if (result.status === 'failed') { setPhase('failed'); setStatus(`The gift didn't go through, so ${name} is still yours. Try again.`); gate.current.release(); }
    else if (result.status === 'gas_rejected' || result.status === 'no_near') {
      const amount = missingNear(result.missingYocto);
      setMissing(amount); setPhase(result.status === 'gas_rejected' ? 'gas' : 'short');
      setStatus(result.status === 'gas_rejected' ? `The gift didn't go through. Add ${amount} NEAR for the network fee — ${name} is still yours.` : `Handing ${name} over takes a tiny network fee. Add ${amount} NEAR to give ${name} to ${friend} — ${name} is still yours until then.`);
      gate.current.release();
    } else if (result.status === 'paused') { setPhase('paused'); setStatus(`Gifts are paused on our side while we top up. ${name} is still yours — check back soon!`); gate.current.release(); }
    else if (result.status === 'unknown') { const checking = Date.now() - started.current >= 10_000; setPhase(checking ? 'checking' : 'sending'); if (checking) setStatus('Still checking — this can take a moment.'); }
  }, [tokenId, name, friend, onGiven]);
  // A reload reconstructs an unfinished transfer from the Worker's stored hash.
  useEffect(() => {
    if (!active || phase !== 'accepted') return;
    let alive = true;
    void (async () => {
      try {
        const t = await auth.getIdentityToken(); if (!t) return;
        const result = await workerApi.giftOutcome(t, tokenId);
        if (alive) { started.current = Date.now() - 10_000; outcome(result); }
      } catch { /* No flight yet: the accepted friend is ready for the giver's first tap. */ }
    })();
    return () => { alive = false; };
  }, [active, phase, auth, tokenId, outcome]);
  useEffect(() => {
    if (phase !== 'sending' && phase !== 'checking') return;
    let alive = true;
    const ask = async () => {
      if (polling.current) return;
      polling.current = true;
      let t: string | null = null;
      try {
        t = await auth.getIdentityToken(); if (!t) return;
        const next = await workerApi.giftOutcome(t, tokenId);
        if (alive) outcome(next);
      } catch (error) {
        if (!alive) return;
        if (t) {
          try {
            const retried = await signed.current.resendOnNoFlight(error, (payload) => workerApi.sendGift(t!, tokenId, payload));
            if (alive && retried) { outcome(retried); return; }
          } catch (resendError) {
            if (!alive) return;
            if (resendError instanceof WorkerError && resendError.status === 409 && resendError.code === 'gift_unavailable') {
              try {
                const fresh = await workerApi.giftLink(t, tokenId);
                if (!alive) return;
                signed.current.clear();
                gate.current.release();
                setLink(fresh);
                setShare(null);
                if (fresh.status === 'accepted') {
                  seen.current = `${fresh.code}:${fresh.version}`;
                  setStatus(`${fresh.acceptedName || 'A friend'} wants to take ${name} home.`);
                  setPhase('accepted');
                } else if (fresh.status === 'none' || fresh.status === 'cancelled') {
                  setStatus("Gift cancelled. That link won't work anymore.");
                  setPhase('cancelled');
                } else {
                  setStatus('');
                  setPhase(fresh.status === 'waiting' ? 'waiting' : 'initial');
                }
                return;
              } catch { /* A failed link read cannot establish a definite outcome; keep checking. */ }
            }
            /* An unreachable resend keeps the same signed payload available for the next poll. */
          }
        }
        if (Date.now() - started.current >= 10_000) { setPhase('checking'); setStatus('Still checking — this can take a moment.'); }
      }
      finally { polling.current = false; }
    };
    const timer = setInterval(() => { if (!document.hidden) void ask(); }, 2500);
    const atTen = setTimeout(() => { if (alive) { setPhase('checking'); setStatus('Still checking — this can take a moment.'); } }, Math.max(0, 10_000 - (Date.now() - started.current)));
    return () => { alive = false; clearInterval(timer); clearTimeout(atTen); };
  }, [phase, auth, outcome, tokenId, name]);
  const give = async () => {
    if (!gate.current.take()) return;
    signed.current.clear();
    started.current = Date.now(); setPhase('sending'); setStatus(`Handing ${name} over…`);
    let sent = false;
    try {
      const t = await token(); if (!t) { gate.current.release(); return; }
      const result = await workerApi.prepareGift(t, tokenId);
      if (result.status !== 'ready') { outcome(result); return; }
      const checked = checkGiftTx(result.tx, { account: auth.nearAccountId!, tokenId, receiver: link.acceptedAccount! });
      if (!checked.ok || result.receiver !== link.acceptedAccount || result.acceptedName !== link.acceptedName) { setPhase('failed'); gate.current.release(); return; }
      const signature = await auth.signNearHash(await sha256Hex(checked.bytes));
      const payload = { tx: result.tx, signature: toBase64(signature) };
      signed.current.retain(payload);
      sent = true;
      outcome(await workerApi.sendGift(t, tokenId, payload));
    } catch (error) {
      if (error instanceof WorkerError && error.status === 401) auth.endSession(true, true);
      else if (sent) outcome({ status: 'unknown' });
      else { setPhase('failed'); gate.current.release(); }
    }
  };

  if (!active) return null;
  const accepted = ['accepted', 'sending', 'checking', 'given', 'failed', 'gas', 'short', 'paused'].includes(phase);
  const pending = phase === 'sending' || phase === 'checking';
  const clear = () => {
    clearButton.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void sharedJobOf(tokenId).then((pet) => {
      if (!activeRef.current) return;
      openClearMemory({ tokenId, name, unsettledSharedJob: Boolean(pet?.shared_job && pet.shared_job.state !== 'settled'), returnFocusTo: () => clearButton.current, onDone: () => openGift({ tokenId, name, returnFocusTo: request?.returnFocusTo }) });
    }).catch(() => {
      if (!activeRef.current) return;
      openClearMemory({ tokenId, name, returnFocusTo: () => clearButton.current, onDone: () => openGift({ tokenId, name, returnFocusTo: request?.returnFocusTo }) });
    });
  };
  const add = () => { closeGift(); openAddNear({ from: 'gift', onBack: () => openGift({ tokenId, name, returnFocusTo: request?.returnFocusTo }) }); };
  const start = <>
    <Text>{`${name} goes to them whole: its name, character, food, growth and traits, streak and freezes, outfits — and its chats, its memories, the advice it paid for and any skill you taught it. Its new owner can read them.`}</Text>
    <Block role="trust" icon="globe" quiet><Text variant="small">{`${name} won't be yours anymore — you can still visit and feed ${name}. Who gave ${name} to whom is public forever — even if this game shuts down.`}</Text></Block>
    {hatched ? <Text>{`If ${name} was your only pet, you can hatch a new one after the gift.`}</Text> : null}
    <Cluster gap={3} justify="space-between"><Text variant="small" tone="secondary">{`Want to keep your chats private? Clear ${name}'s memory first.`}</Text><Button variant="secondary" size="compact" onClick={clear}>Clear memory</Button></Cluster>
    <Text>{ONLY(name)}</Text><div data-gift-create><Button block icon="share" onClick={() => void create()}>Create gift link</Button></div>
  </>;
  const cancelLabel = unnamed ? 'Not sure? Cancel gift' : `Not ${friend}? Cancel gift`;
  return <Sheet title={`Give ${name} to a friend`} column self={request?.self} busy={pending} onClose={close} status={status} returnFocusTo={() => request?.self ? document.querySelector<HTMLElement>('h1') : request?.returnFocusTo?.() ?? opener.current}>
    <div ref={focusRoot}><Stack gap={4}>
      {phase === 'error' ? <Cluster gap={3} justify="space-between"><Note tone="error">{LOADING_ERROR}</Note><div data-gift-retry><Button variant="secondary" size="compact" onClick={() => void load()}>Try again</Button></div></Cluster> : null}
      {phase === 'initial' ? start : null}
      {phase === 'cancelled' ? <><div data-gift-outcome tabIndex={-1}><Note tone="plain" icon="check">{"Gift cancelled. That link won't work anymore."}</Note></div>{start}</> : null}
      {phase === 'waiting' ? <>
        <Text variant="lead">{`Your gift link is ready. ${name} stays yours until a friend accepts and you hand ${name} over.`}</Text>
        <Text>{ONLY(name)}</Text><div data-gift-share><Button block icon="share" onClick={() => link.code && void shareLink(link.code)}>Share gift link</Button></div>
        {share === 'manual' && link.code ? <TextField label="Copy this link and send it to a friend:" readOnly multiline value={`${invite(name)} ${linkUrl(link.code)}`} /> : null}
        <Button block variant="ghost" onClick={() => void cancel()}>Cancel gift</Button>
      </> : null}
      {accepted ? <>
        {phase === 'given' ? <Stack gap={4} align="center"><PetFigure tokenId={tokenId} name={name} stage={stage} outfit={worn ?? undefined} size="md" decorative lost /><div data-gift-outcome tabIndex={-1}><Text variant="lead" align="center">{`${name} is ${friend}'s now. Thanks for taking such good care of ${name}!`}</Text></div></Stack> : <>
          {phase === 'failed' ? <div data-gift-outcome tabIndex={-1}><Note tone="error">{`The gift didn't go through, so ${name} is still yours. Try again.`}</Note></div> : null}
          {phase === 'gas' ? <div data-gift-outcome tabIndex={-1}><Note tone="error">{`The gift didn't go through. Add ${missing} NEAR for the network fee — ${name} is still yours.`}</Note></div> : null}
          {phase === 'paused' ? <div data-gift-outcome tabIndex={-1}><Note tone="plain">{`Gifts are paused on our side while we top up. ${name} is still yours — check back soon!`}</Note></div> : null}
          <Text variant="lead">{`${unnamed ? 'A friend' : friend} wants to take ${name} home. Give ${name} to ${friend}?`}</Text>
          {unnamed ? <Text>{`We can't show this person's name — make sure it's your friend before you give ${name}.`}</Text> : null}
          {phase === 'short' ? <Text>{`Handing ${name} over takes a tiny network fee. Add ${missing} NEAR to give ${name} to ${friend} — ${name} is still yours until then.`}</Text> : null}
          {phase === 'short' || phase === 'gas' ? <div data-gift-add><Button block onClick={add}>Add NEAR</Button></div> : <div data-gift-give><Button block variant="danger" disabled={phase === 'paused'} pending={pending} pendingLabel={`Handing ${name} over…`} onClick={() => void give()}>{phase === 'failed' ? 'Try again' : `Give ${name} to ${friend}`}</Button></div>}
          {phase === 'checking' ? <div data-gift-outcome tabIndex={-1}><Note tone="status">Still checking — this can take a moment.</Note></div> : null}
          <Button block variant="ghost" disabled={pending} onClick={() => void cancel()}>{cancelLabel}</Button>
        </>}
      </> : null}
    </Stack></div>
  </Sheet>;
}
