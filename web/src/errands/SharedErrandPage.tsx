import { useCallback, useEffect, useRef, useState } from 'react';
import { AccountControl } from '../account/AccountControl';
import { Button, Centerpiece, Header, Heading, Message, MotionToggle, Note, Page, PetPlate, PetStage, Progress, Shell, Skeleton, Stack, Text, TextField } from '../ds';
import { FeedLayer } from '../feeding/FeedLayer';
import { openFeed } from '../feeding/feedRequest';
import { onFlight } from '../feeding/feedFlight';
import { formatCents } from '../lib/price';
import { PetFigure } from '../pet/PetFigure';
import { canUseWebGL } from '../pet/flat';
import { useMotionPaused } from '../pet/motion';
import { makePet } from '../pet/proto/generator.js';
import { petPath, verifyPath } from '../route';
import { useAuth } from '../seams/auth';
import { workerApi, WorkerError, type PetView, type SharedErrand } from '../seams/worker';
import { useSignIn } from '../signin/signIn';
import { thisBrowser } from '../signin/inApp';
import { takePendingAction } from '../screens/pet/parts';
import { centsAtRate } from '../verification/checkMachine';
import { peekPrepared, takePrepared } from './preparedShare';
import { closeApproval } from './sharedApproval';

const LOAD_ERROR = "We couldn't load this errand right now. Try again.";
const CLOSE_ERROR = "We couldn't close this job. Try again.";
type CloseStep = 'idle' | 'confirm' | 'pending' | 'failed';

/** Approximate US cents shown in the shared frames. The immutable allowance is the full three-search 2¢ ceiling. */
function progress(funded: string, needed: string): { value: number; words: string } {
  const have = BigInt(funded);
  const total = BigInt(needed);
  const value = total > 0n ? Math.min(1, Number(have * 10000n / total) / 10000) : 0;
  const cents = 2 * value;
  return { value, words: `${Number.isInteger(cents) ? `${cents}¢` : formatCents(cents)} of 2¢ food reserved for this errand` };
}

function billedWords(priceYocto: string, nearUsdRate: string | null, searches: number | null | undefined): { price: string; words: string; searches: number } | null {
  const hundredths = centsAtRate(priceYocto, nearUsdRate);
  if (hundredths === null) return null;
  const price = hundredths >= 1 && hundredths <= 9 ? `0.0${hundredths}¢` : formatCents(hundredths / 100);
  return { price, searches: searches ?? 0, words: searches && searches > 0 ? `${searches} ${searches === 1 ? 'search' : 'searches'} · ${price}` : price };
}

// spec: add-pet-errands › Shared errand screen › loading
// spec: add-pet-errands › Shared errand screen › error
// spec: add-pet-errands › Shared errand screen › empty
export function SharedErrandPage({ tokenId, code }: { tokenId: string; code: string }) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const signIn = useSignIn();
  const [view, setView] = useState<SharedErrand | null>(null);
  const [pet, setPet] = useState<PetView | null>(null);
  const [error, setError] = useState(false);
  const [closeStep, setCloseStep] = useState<CloseStep>('idle');
  const closeStepRef = useRef<CloseStep>('idle');
  const changeCloseStep = (step: CloseStep) => { closeStepRef.current = step; setCloseStep(step); };
  const [manual, setManual] = useState(false);
  const [notice, setNotice] = useState('');
  const [billed, setBilled] = useState<{ receiptId: string; price: string; words: string; searches: number } | null>(null);
  // the owner has just come from «Share a job for friends to fund»: said once, not on a reload or a later visit
  const [introduced] = useState(() => peekPrepared(code));
  useEffect(() => { takePrepared(code); }, [code]);
  const billingRead = useRef<string | null>(null);
  const [lost, setLost] = useState(false);
  const [paused, toggleMotion] = useMotionPaused();
  const alive = useRef(true);
  const lastFunding = useRef<'near' | 'snack'>('near');
  const read = useCallback(async () => {
    try {
      const token = authRef.current.authenticated ? await authRef.current.getIdentityToken() : null;
      const nextPet = await workerApi.pet(token, tokenId);
      if (alive.current) setPet(nextPet);
      const next = await workerApi.sharedErrand(token, tokenId, code);
      if (!alive.current) return;
      setView(next);
      if (next.state === 'empty' || next.viewer !== 'owner' || (next.state !== 'opening' && next.state !== 'funding' && !(next.state === 'failed' && next.receiptId == null))) changeCloseStep('idle');
      setPet(nextPet);
      setError(false);
      if (next.state !== 'empty' && (next.viewer === 'owner' || next.viewer === 'sponsor') && next.receiptId && billed?.receiptId !== next.receiptId && billingRead.current !== next.receiptId) {
        billingRead.current = next.receiptId;
        void workerApi.verificationThought(token, tokenId, next.receiptId).then((pointer) => {
          const words = billedWords(pointer.priceYocto, pointer.nearUsdRate, pointer.searches);
          if (alive.current && words) setBilled({ receiptId: next.receiptId!, ...words });
        }).catch(() => {}).finally(() => { billingRead.current = null; });
      }
    } catch (e) {
      if (e instanceof WorkerError && e.status === 401) {
        authRef.current.endSession(true, true);
        try {
          const [nextPet, next] = await Promise.all([workerApi.pet(null, tokenId), workerApi.sharedErrand(null, tokenId, code)]);
          if (alive.current) { setPet(nextPet); setView(next); changeCloseStep('idle'); setError(false); }
          return;
        } catch { /* public read failed too */ }
      }
      if (alive.current && closeStepRef.current !== 'pending') setError(true);
    }
  }, [auth.authenticated, tokenId, code, billed?.receiptId]);

  useEffect(() => { alive.current = true; void read(); return () => { alive.current = false; }; }, [read]);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) void read(); };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 5000);
    return () => { document.removeEventListener('visibilitychange', onVisible); clearInterval(timer); };
  }, [read]);
  useEffect(() => {
    const browser = thisBrowser();
    void workerApi.sharedErrandEvent(null, tokenId, code, { kind: 'opened', device: browser.phone ? 'phone' : 'desktop', inApp: browser.inApp ?? 'none' }).catch(() => {});
  }, [tokenId, code]);
  useEffect(() => onFlight((event) => {
    if (event.kind !== 'ended' || event.flight.tokenId !== tokenId) return;
    if (event.end.status === 'ok') lastFunding.current = event.flight.source;
    if (event.end.status === 'funding_closed') setNotice("Enough food is already reserved for this errand. Your NEAR wasn't spent.");
    if (event.end.status === 'ok' || event.end.status === 'funding_closed') void read();
  }), [read, tokenId]);

  // a run that failed without a paid call keeps its reserve for the owner's close, and offers no food to anyone
  const unpaidFailed = view !== null && view.state === 'failed' && view.receiptId == null;
  const waiting = view !== null && view.state !== 'empty' && (view.state === 'opening' || view.state === 'funding');
  const owner = view !== null && view.state !== 'empty' && (waiting || unpaidFailed) && view.viewer === 'owner';
  const funded = waiting && BigInt(view.funded) >= BigInt(view.needed);
  const feedFriend = waiting && !owner && view.viewer !== 'signed-out' && !funded;
  const openLinkedFeed = () => {
    if (!view || view.state === 'empty') return;
    openFeed({ tokenId, name: view.name, label: view.name, elsewhere: false, sharedCode: code, onDone: () => {
      setNotice(lastFunding.current === 'near' ? `You fed ${view.name}! Your NEAR is reserved for this errand.` : `You gave ${view.name} a free snack. The project paid for it; its food is reserved for this errand.`);
      void read();
    } });
  };
  useEffect(() => {
    if (!auth.ready || !auth.authenticated || view === null || (view.state !== 'empty' && view.viewer === 'signed-out')) return;
    const action = takePendingAction();
    if (action === 'feed' && feedFriend) openLinkedFeed();
  // A sign-in return consumes its one action only after the public link read resolves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.ready, view?.state, view && view.state !== 'empty' ? view.viewer : null]);

  const share = async () => {
    if (!view || view.state === 'empty') return;
    const url = new URL(window.location.pathname, window.location.origin).href;
    const message = `Help ${view.name} find out: ${view.job}`;
    try {
      if (navigator.share) await navigator.share({ text: message, url });
      else { await navigator.clipboard.writeText(`${message} ${url}`); setNotice('Link copied — send it to a friend.'); }
      const token = await auth.getIdentityToken();
      if (token) void workerApi.sharedErrandEvent(token, tokenId, code, { kind: 'shared' }).catch(() => {});
    } catch {
      try { await navigator.clipboard.writeText(`${message} ${url}`); setNotice('Link copied — send it to a friend.'); }
      catch { setManual(true); }
    }
  };
  const close = async () => {
    if (!auth.nearAccountId || closeStepRef.current === 'pending' || !owner || !view) return;
    changeCloseStep('pending');
    let submitted = false;
    try {
      const token = await auth.getIdentityToken();
      if (!token) throw new Error('session ended');
      const approval = await closeApproval(tokenId, auth.nearAccountId, auth.signNearHash);
      submitted = true;
      await workerApi.closeSharedErrand(token, tokenId, code, approval);
      await read();
    } catch (e) {
      if (e instanceof WorkerError && e.status === 401) auth.endSession(true, true);
      else {
        if (!submitted || (e instanceof WorkerError && e.code === 'close_refused')) changeCloseStep('failed');
        // A sent approval with no confirmed refusal may already have closed the chain job.
        void read();
      }
    }
  };

  const name = view?.name ?? pet?.name ?? '';
  const visit = <Button block href={petPath(tokenId)}>{`Visit ${name}`}</Button>;
  let body;
  let loadingObject;
  let actions;
  let status = '';
  if (error) {
    status = LOAD_ERROR;
    body = <Heading level={1} variant="title-2" id="shared-title">{LOAD_ERROR}</Heading>;
    actions = <Button block onClick={() => { setError(false); void read(); }}>Try again</Button>;
  } else if (view === null) {
    status = `Getting ${name}'s errand…`;
    loadingObject = <Stack gap={4} align="center"><Skeleton shape="pet" /><Skeleton shape="name" /></Stack>;
    body = <Note tone="status" id="shared-title">{status}</Note>;
  } else if (view.state === 'empty') {
    status = `This shared errand is no longer here. Food already given stays with ${name}.`;
    body = <Heading level={1} variant="title-2" id="shared-title">{status}</Heading>;
    actions = visit;
  } else {
    const amount = progress(view.funded, view.needed);
    const detail = waiting && !funded && view.fullness.state !== 'asleep' && closeStep !== 'pending'
      ? owner ? "Friends' food pays for this job" : view.viewer !== 'signed-out' ? "A NEAR meal uses your NEAR. A free snack uses the project's food." : null
      : null;
    body = <Stack gap={4}>
      <Heading level={1} id="shared-title">{`Help ${name} find out: ${view.job}`}</Heading>
      <Progress value={amount.value}>{amount.words}</Progress>
      {detail ? <Text>{detail}</Text> : null}
      {introduced && owner && waiting ? <Text>Anyone with this link can read your job. Only you and friends who feed it can read the report.</Text> : null}
      {notice ? <Note tone="status">{notice}</Note> : null}
    </Stack>;
    if (owner && closeStep === 'confirm') {
      status = `Close this job? Food already given will stay with ${name} for ordinary use.`;
      actions = <Stack gap={3}><Button block icon="share" onClick={() => void share()}>Share job</Button><Text>{status}</Text><Button block variant="secondary" onClick={() => void close()}>Confirm close</Button></Stack>;
    } else if (owner && closeStep === 'pending') {
      status = 'Closing job…';
      actions = <Button block variant="secondary" pending pendingLabel={status} onClick={() => {}}>Confirm close</Button>;
    } else if (owner && closeStep === 'failed') {
      status = CLOSE_ERROR;
      actions = <Stack gap={3}><Note tone="error" silent>{status}</Note><Button block variant="secondary" onClick={() => void close()}>Try again</Button></Stack>;
    } else if (waiting && funded && view.fullness.state === 'asleep') {
      status = `Enough food is reserved. ${name} is waking up; the job will start when ready.`;
      actions = <Text>{status}</Text>;
    } else if (waiting && funded) {
      status = 'Enough food is already reserved for this errand.';
      actions = <Stack gap={3}><Text>{status}</Text>{visit}</Stack>;
    } else if (owner) {
      const failed = view.state === 'failed';
      status = failed ? 'This job stopped before it spent any food. Its food is still reserved.' : "Friends' food pays for this job";
      actions = <Stack gap={2}>{failed ? <Text>{status}</Text> : <Button block icon="share" onClick={() => void share()}>Share job</Button>}<Button block variant="secondary" onClick={() => setCloseStep('confirm')}>Close job</Button></Stack>;
    } else if (unpaidFailed && view.viewer === 'sponsor') {
      status = `${name} couldn't finish this errand. Nothing was spent.`;
      actions = <Stack gap={3}><Text>{status}</Text>{visit}</Stack>;
    } else if (!waiting) {
      status = `This job is underway or finished. Visit ${name} to feed it normally.`;
      const paidNoReport = !view.report && view.receiptId != null && (view.state === 'reported' || view.state === 'failed');
      // its one job has run (a running one is only underway): the link cannot run it again
      const ran = view.state === 'reported' || view.state === 'failed';
      actions = <Stack gap={3}><Text>{status}</Text>{(view.viewer === 'sponsor' || view.viewer === 'owner') && (view.report || view.receiptId) ? <>{view.report ? <Message from="report" speaker={name} sources={view.sources?.map((source) => ({ label: source.label, href: source.url }))}>{view.report}</Message> : null}{billed && billed.receiptId === view.receiptId ? <>{paidNoReport ? <Text>{billed.searches > 0 ? `${name} came back without a report. Its searches used ${billed.price} of food.` : `${name} couldn't reach search. The try used ${billed.price} of food.`}</Text> : null}<Text variant="small">{billed.words}</Text></> : null}{view.receiptId ? <Button href={verifyPath(tokenId, view.receiptId)}>Check this thought</Button> : null}</> : null}{ran ? <Text>This shared job has already run.</Text> : null}{visit}</Stack>;
    } else if (view.viewer === 'signed-out') {
      actions = <Button block onClick={() => signIn.begin('feed')}>{`Sign in to feed ${name}`}</Button>;
    } else {
      status = view.fullness.state === 'asleep'
        ? `${name} is asleep. A meal or an available free snack can wake ${name}; this job will wait.`
        : "A NEAR meal uses your NEAR. A free snack uses the project's food.";
      actions = <Stack gap={3}>{view.fullness.state === 'asleep' ? <Text>{status}</Text> : null}<Button block icon="feed" price={`up to ≈ ${(2 - Number((2 * amount.value).toFixed(2))).toFixed(2)}¢`} haspopup="dialog" onClick={openLinkedFeed}>{`Feed ${name}`}</Button></Stack>;
    }
    if (manual) actions = <Stack gap={3}>{actions}<TextField label="Copy this link and send it to a friend:" readOnly multiline value={`${window.location.origin}${window.location.pathname} Help ${name} find out: ${view.job}`} /></Stack>;
  }
    const compact = error || (view !== null && (view.state === 'empty' || (!(waiting && funded && view.fullness.state === 'asleep') && closeStep !== 'pending')));
  // the 3D pet is sized by the stage's compact and owner classes, as the frames' still is by the centerpiece's compact cap (the
  // owner's phone cap): both follow `compact`
  const figure = view && view.state !== 'empty' && !error ? <PetStage compact={compact} owner={compact} pet={<PetFigure tokenId={tokenId} name={name} stage={pet?.stage ?? 'adult'} state={view.fullness.state} outfit={pet?.worn ?? undefined} size="hero" lost={lost} onLost={() => setLost(true)} />} motion={!lost && canUseWebGL() ? <MotionToggle paused={paused} onToggle={toggleMotion} /> : undefined} plate={<PetPlate name={name} fullness={view.fullness} />} /> : null;
  return <Shell accent={figure ? makePet(tokenId).hue : 'none'} fill header={auth.authenticated ? <Header end={<AccountControl tokenId={tokenId} name={name} viewer={view && view.state !== 'empty' && view.viewer === 'owner' ? 'owner' : 'guest'} />} /> : undefined}>
    <Page fill width={figure || loadingObject ? undefined : 'narrow'}><Centerpiece labelledBy="shared-title" text={figure || loadingObject ? body : undefined} actions={actions} status={status} compact={compact} immediate={error || view?.state === 'empty'}>{figure ?? loadingObject ?? body}</Centerpiece></Page>
    <FeedLayer pageFullness={view && view.state !== 'empty' ? view.fullness : undefined} />
  </Shell>;
}
