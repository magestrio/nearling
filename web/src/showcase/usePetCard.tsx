import { useEffect, useReducer, useRef, useState } from 'react';
import { Actions, Button, ChoiceList, Menu, MenuItem, Note, RailItem, Sheet, Stack } from '../ds';
import { WorkerError, workerApi, type CardKind, type CardSource, type Token } from '../seams/worker';
import { renderShowcaseCard, shareCardError, showcaseFacts } from './card';
import { cardState, emptyCard } from './cardState';
import { sendCardShared } from './shareEvent';
import { canShareFile } from '../errands/VerdictCard';
import './card.css';

type Line = { id: string; who: string; text: string; question?: boolean };
type Pet = { tokenId: string; name: string; stage: 'baby' | 'teen' | 'adult'; worn: string | null; fullness: { state: 'full' | 'hungry' | 'asleep' }; memoryEpoch: number };

/** Card selection and preview live only for this mounted owner page. */
export function usePetCard(pet: Pet, _lines: Line[], tokenOf: () => Promise<Token>, active: boolean) {
  const [draft, dispatch] = useReducer(cardState, emptyCard);
  const [menu, setMenu] = useState(false);
  const [message, setMessage] = useState('');
  const [choices, setChoices] = useState<Array<{ value: string; text: string }>>([]);
  const [showChoices, setShowChoices] = useState(false);
  const [shareFailure, setShareFailure] = useState(false);
  const [lostOwner, setLostOwner] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [shareReady, setShareReady] = useState(false);
  const [shareNowReady, setShareNowReady] = useState(false);
  const [validationEpoch, setValidationEpoch] = useState(0);
  const [erasedNotice, setErasedNotice] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<{ image: Blob; url: string } | null>(null);
  const flight = useRef(false);
  const request = useRef(0);
  const preview = useRef<HTMLDivElement>(null);
  const choicesRef = useRef<Array<{ value: string; text: string }>>([]);
  const focusAfterDraw = useRef(false);
  const lastVisual = useRef({ stage: pet.stage, worn: pet.worn, fullness: pet.fullness.state });
  const close = () => { const refresh = lostOwner; request.current += 1; dispatch({ type: 'reset' }); setMenu(false); setMessage(''); setChoices([]); choicesRef.current = []; setShowChoices(false); setShareFailure(false); setShareReady(false); setShareNowReady(false); setErasedNotice(false); setLostOwner(false); if (refresh) document.dispatchEvent(new Event('visibilitychange')); };

  // A gift, a memory clear, an ended session and a different pet invalidate every old source and image.
  useEffect(() => { close(); }, [active, pet.tokenId, pet.memoryEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { request.current += 1; }, []);

  // A check that says the selected thought is gone is the answer: drop it and load the next retained one, no second look at it.
  const dropErased = async (thoughtId?: string) => {
    const remaining = choicesRef.current.filter((line) => line.value !== thoughtId);
    choicesRef.current = remaining;
    if (remaining.length === 0) {
      close();
      setMessage(`That thought is no longer here. Choose another one. No thoughts to share yet. Talk with ${pet.name} to hear one.`);
      setMenu(true);
      return;
    }
    setChoices(remaining);
    setShowChoices(true);
    setErasedNotice(true);
    setShareReady(false);
    setShareNowReady(false);
    focusAfterDraw.current = true;
    dispatch({ type: 'erased' });
    if (remaining[0]) {
      dispatch({ type: 'open', kind: 'thought', thoughtId: remaining[0].value });
      await load('thought', remaining[0].value);
    }
  };
  const load = async (kind: CardKind, thoughtId?: string) => {
    const seq = ++request.current;
    try {
      const source = await workerApi.cardSource(await tokenOf(), pet.tokenId, { kind, ...(thoughtId ? { thoughtId } : {}) });
      if (seq === request.current) dispatch({ type: 'source', source });
    } catch (e) {
      if (seq !== request.current) return;
      if (e instanceof WorkerError && e.code === 'thought_erased') await dropErased(thoughtId);
      else if (e instanceof WorkerError && e.code === 'not_owner') close();
      else if (e instanceof WorkerError && e.code === 'growth_not_reached') { close(); setMessage(`${pet.name} hasn't reached a new stage yet.`); setMenu(true); }
      else if (e instanceof WorkerError && e.code === 'no_outfit') { close(); setMessage(`${pet.name} isn't wearing an outfit to share.`); setMenu(true); }
      else { close(); setMessage(shareCardError); setMenu(true); }
    }
  };
  const open = async (kind: CardKind) => {
    const seq = ++request.current;
    setMenu(false);
    setMessage('');
    if (kind === 'thought') {
      try {
        const token = await tokenOf();
        const available = await workerApi.cardLines(token, pet.tokenId);
        if (seq !== request.current) return;
        const retained = available.lines.filter((line) => line.text).map(({ id, text }) => ({ value: id, text }));
        if (retained.length === 0) { setMessage(`No thoughts to share yet. Talk with ${pet.name} to hear one.`); setMenu(true); return; }
        choicesRef.current = retained;
        setChoices(retained);
        setShowChoices(true);
        dispatch({ type: 'open', kind, thoughtId: retained[0]!.value });
        await load(kind, retained[0]!.value);
      } catch (e) {
        if (seq !== request.current) return;
        if (e instanceof WorkerError && e.code === 'not_owner') close();
        else { setMessage(shareCardError); setMenu(true); }
      }
      return;
    }
    dispatch({ type: 'open', kind });
    await load(kind);
  };

  // The Pet screen can update the outfit, growth or fullness while this sheet is open.
  // Each of those values is drawn into the image, so discard the old bitmap and check its source again.
  useEffect(() => {
    const previous = lastVisual.current;
    lastVisual.current = { stage: pet.stage, worn: pet.worn, fullness: pet.fullness.state };
    if (previous.stage === pet.stage && previous.worn === pet.worn && previous.fullness === pet.fullness.state) return;
    if (draft.phase !== 'ready' && draft.phase !== 'drawing' && draft.phase !== 'error') return;
    setShareReady(false);
    setShareNowReady(false);
    setPreviewUrl(null);
    dispatch({ type: 'open', kind: draft.kind, ...(draft.thoughtId ? { thoughtId: draft.thoughtId } : {}) });
    void load(draft.kind, draft.thoughtId ?? undefined);
  }, [pet.stage, pet.worn, pet.fullness.state]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (draft.phase !== 'drawing') return;
    const seq = request.current;
    renderShowcaseCard(draft.source, {
      stage: draft.source.kind === 'growth' ? draft.source.stage : pet.stage,
      state: pet.fullness.state,
      worn: draft.source.kind === 'outfit' ? draft.source.worn : pet.worn,
    }, preview.current ?? document.documentElement, window.location.origin)
      .then((image) => { if (seq === request.current) dispatch({ type: 'drawn', image }); }, () => { if (seq === request.current) dispatch({ type: 'draw_failed' }); });
  }, [draft, pet.stage, pet.fullness.state, pet.worn]);

  useEffect(() => {
    if (draft.phase !== 'ready') return;
    const url = URL.createObjectURL(draft.image);
    setPreviewUrl({ image: draft.image, url });
    return () => URL.revokeObjectURL(url);
  }, [draft.phase, draft.phase === 'ready' ? draft.image : null]);

  // A ready image is checked here for its controls, then checked again on every delivery tap.
  useEffect(() => {
    if (draft.phase !== 'ready') return;
    const seq = request.current;
    let cancelled = false;
    setShareReady(false);
    setShareNowReady(false);
    void (async () => {
      try {
        const token = await tokenOf();
        const fresh = await workerApi.cardSource(token, pet.tokenId, { kind: draft.kind, ...(draft.thoughtId ? { thoughtId: draft.thoughtId } : {}) });
        if (cancelled || seq !== request.current) return;
        if (JSON.stringify(fresh) !== JSON.stringify(draft.source)) {
          if (draft.kind === 'thought') await load('thought', draft.thoughtId ?? undefined);
          else { dispatch({ type: 'open', kind: draft.kind }); dispatch({ type: 'source', source: fresh }); }
          return;
        }
        setShareReady(true);
      } catch (error) {
        if (cancelled || seq !== request.current) return;
        if (error instanceof WorkerError && error.code === 'thought_erased') await dropErased(draft.thoughtId ?? undefined);
        else if (error instanceof WorkerError && error.code === 'not_owner') setLostOwner(true);
      }
    })();
    return () => { cancelled = true; };
  }, [draft.phase, draft.phase === 'ready' ? draft.image : null, validationEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (draft.phase !== 'ready') return;
    const recheck = () => {
      if (document.visibilityState === 'hidden') { setShareReady(false); setShareNowReady(false); return; }
      setShareNowReady(false);
      setValidationEpoch((now) => now + 1);
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    return () => { document.removeEventListener('visibilitychange', recheck); window.removeEventListener('focus', recheck); };
  }, [draft.phase]);

  useEffect(() => {
    if (!focusAfterDraw.current || (draft.phase !== 'ready' && draft.phase !== 'error')) return;
    focusAfterDraw.current = false;
    const label = draft.phase === 'ready' ? 'Save image' : 'Try again';
    const target = Array.from(preview.current?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent?.includes(label));
    target?.focus();
  }, [draft.phase]);

  useEffect(() => {
    if (!shareNowReady) return;
    Array.from(preview.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent?.trim() === 'Share now')?.focus();
  }, [shareNowReady]);

  const title = draft.phase === 'closed' ? '' : draft.kind === 'thought' ? 'Share a thought' : draft.kind === 'growth' ? 'Share growth' : 'Share outfit';
  const source: CardSource | null = draft.phase === 'drawing' || draft.phase === 'ready' || draft.phase === 'error' ? draft.source : null;
  const facts = source ? showcaseFacts(source, window.location.origin) : null;
  const choose = (thoughtId: string) => { focusAfterDraw.current = true; setShowChoices(false); setShareReady(false); setShareNowReady(false); dispatch({ type: 'open', kind: 'thought', thoughtId }); void load('thought', thoughtId); };
  const canShare = draft.phase === 'ready' && shareReady && !shareFailure && !lostOwner && canShareFile(draft.image, pet.name);
  const deliver = async (delivery: 'save' | 'share') => {
    if (draft.phase !== 'ready' || flight.current || lostOwner || (delivery === 'share' && !canShare)) return;
    flight.current = true;
    setDelivering(true);
    setShareFailure(false);
    const seq = request.current;
    const useShareNow = delivery === 'share' && shareNowReady;
    let activationFallback = false;
    const name = `${pet.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'pet'}-card.png`;
    try {
      const token = await tokenOf();
      const fresh = await workerApi.cardSource(token, pet.tokenId, { kind: draft.kind, ...(draft.thoughtId ? { thoughtId: draft.thoughtId } : {}) });
      if (seq !== request.current) return;
      if (JSON.stringify(fresh) !== JSON.stringify(draft.source)) {
        setShareNowReady(false);
        if (draft.kind === 'thought') await load('thought', draft.thoughtId ?? undefined);
        else { dispatch({ type: 'open', kind: draft.kind }); dispatch({ type: 'source', source: fresh }); }
        return;
      }
      if (delivery === 'share') {
        try {
          await navigator.share({ files: [new File([draft.image], name, { type: 'image/png' })], url: new URL(`/pet/${encodeURIComponent(pet.tokenId)}`, location.origin).toString() });
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          if (!useShareNow && error instanceof DOMException && error.name === 'NotAllowedError' && seq === request.current) {
            activationFallback = true;
            setShareReady(true);
            setShareNowReady(true);
            return;
          }
          if (seq === request.current) setShareFailure(true);
          return;
        }
      } else {
        const url = URL.createObjectURL(draft.image);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      if (seq === request.current) void sendCardShared(token, draft.kind, delivery).catch(() => undefined);
    } catch (error) {
      if (seq !== request.current) return;
      if (error instanceof WorkerError && error.code === 'not_owner') {
        setLostOwner(true);
      } else if (error instanceof WorkerError && error.code === 'thought_erased') {
        await dropErased(draft.thoughtId ?? undefined);
      } else if (delivery === 'share') setShareFailure(true);
    } finally {
      flight.current = false;
      setDelivering(false);
      if (delivery === 'share' && !activationFallback && seq === request.current) setValidationEpoch((now) => now + 1);
    }
  };
  const entry = <RailItem icon="share" label={`Share ${pet.name}`} haspopup={message ? undefined : 'menu'} expanded={menu || undefined}
    controls={message ? undefined : 'pet-share-menu'} describedby={message ? 'pet-share-menu-message' : undefined}
    onClick={() => { setMenu((was) => !was); setMessage(''); }} onClose={() => { setMenu(false); setMessage(''); }}
    menu={<Menu id="pet-share-menu" label={`Share ${pet.name}`} message={message || undefined} onClose={() => { setMenu(false); setMessage(''); }}>
      <MenuItem first onClick={() => void open('thought')}>Share a thought</MenuItem>
      <MenuItem onClick={() => void open('growth')}>Share growth</MenuItem>
      <MenuItem onClick={() => void open('outfit')}>Share outfit</MenuItem>
    </Menu>} />;
  const sheet = draft.phase === 'closed' ? null : <div className="ds-only" ref={preview}>
    <Sheet title={title} centered onClose={close} status={draft.phase === 'error' ? shareCardError : lostOwner ? `${pet.name} has a new owner. This card can't be shared from here.` : shareFailure ? "Couldn't share the card. Save the image and try from your browser." : erasedNotice ? 'That thought is no longer here. Choose another one.' : shareNowReady ? 'Share now' : draft.phase === 'selecting' ? draft.note : ''}
      foot={lostOwner ? <Note tone="error">{`${pet.name} has a new owner. This card can't be shared from here.`}</Note> : draft.phase === 'ready' ? <Stack gap={3}><Actions stackPhone><Button variant="secondary" icon="download" busy={delivering} onClick={() => void deliver('save')}>Save image</Button>{canShare ? <Button icon="share" busy={delivering} onClick={() => void deliver('share')}>{shareNowReady ? 'Share now' : 'Share'}</Button> : null}</Actions>{shareFailure ? <Note tone="error" silent>Couldn't share the card. Save the image and try from your browser.</Note> : null}</Stack> : undefined}>
      <Stack gap={4}>
        {draft.kind === 'thought' && (showChoices || draft.phase === 'selecting') ? <ChoiceList label="Share a thought" options={choices} value={draft.thoughtId ?? ''} note={erasedNotice ? 'That thought is no longer here. Choose another one.' : draft.phase === 'selecting' ? draft.note : undefined} onChange={(id) => choose(id)} onSelect={() => { setShowChoices(false); requestAnimationFrame(() => { Array.from(preview.current?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent?.includes('Save image'))?.focus(); }); }} /> : null}
        {draft.phase === 'error' ? <Stack gap={3}><Note tone="error" silent>{shareCardError}</Note><Button variant="secondary" size="compact" onClick={() => { focusAfterDraw.current = true; dispatch({ type: 'retry' }); }}>Try again</Button></Stack> : null}
        {draft.phase === 'ready' && source && facts && previewUrl?.image === draft.image ? <img className="showcase-card-preview" src={previewUrl.url}
          alt={`${facts.name} ${source.kind} card. ${facts.line ?? facts.stage ?? facts.outfit}. ${facts.link}`} /> : null}
      </Stack>
    </Sheet>
  </div>;
  return { entry, sheet, open: draft.phase !== 'closed', lostOwner, close };
}
