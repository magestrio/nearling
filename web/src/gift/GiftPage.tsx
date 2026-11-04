import { useCallback, useEffect, useRef, useState } from 'react';
import { AccountControl } from '../account/AccountControl';
import { Button, Center, Centerpiece, Header, Heading, MotionToggle, Note, Page, PetPlate, PetStage, Shell, Skeleton, Stack, Text } from '../ds';
import { formatCents } from '../lib/price';
import { makePet } from '../pet/proto/generator.js';
import { canUseWebGL } from '../pet/flat';
import { useMotionPaused } from '../pet/motion';
import { PetFigure } from '../pet/PetFigure';
import { petPath } from '../route';
import { HatchNotices } from '../screens/hatch/HatchScreen';
import { peekPendingAction, takePendingAction } from '../screens/pet/parts';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi, type PetView, type PublicGift } from '../seams/worker';
import { SignInOutcome } from '../signin/SignInOutcome';
import { useSignIn } from '../signin/signIn';
import { wearProps } from '../wardrobe/catalogue';
import { receiverState } from './receiverState';

type View = { kind: 'loading' } | { kind: 'error' } | { kind: 'connection'; busy: boolean } | { kind: 'gift'; gift: PublicGift; pet: PetView; offline?: 'busy' | 'unreachable' };
const DEAD = "This gift link doesn't work anymore. Ask your friend for a new one.";
const OFFLINE = "We can't reach the game right now. Try again in a moment.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';

/** A code read remains public. Identity is included only when a game session already exists. */
export function GiftPage({ code }: { code: string }) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const signIn = useSignIn();
  const [view, setView] = useState<View>(code ? { kind: 'loading' } : { kind: 'error' });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [accepting, setAccepting] = useState(false);
  const [hatched, setHatched] = useState<boolean | null>(null);
  const [paused, toggleMotion] = useMotionPaused();
  const [lost, setLost] = useState(false);
  const pending = useRef(false);
  const readNumber = useRef(0);
  const previousStatus = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!code) { setView({ kind: 'error' }); return; }
    const number = ++readNumber.current;
    const session = authRef.current;
    try {
      const token = session.authenticated && !session.sessionEnded ? await session.getIdentityToken() : null;
      if (session.authenticated && token === null) { session.endSession(viewRef.current.kind === 'gift'); return; }
      const gift = await workerApi.publicGift(token, code);
      // The public pet view supplies the stage and outfit that the guest's pet figure uses.
      const pet = await workerApi.pet(token, gift.tokenId);
      if (number !== readNumber.current) return;
      setView({ kind: 'gift', gift, pet });
      if (gift.status === 'accepted' && gift.viewer === 'receiver' && token) {
        void workerApi.me(token).then((me) => setHatched(me.hatched !== null)).catch(() => {});
      }
    } catch (error) {
      if (number !== readNumber.current) return;
      if (error instanceof WorkerError && error.status === 401) session.endSession(viewRef.current.kind === 'gift');
      else if (error instanceof WorkerError && error.status === 404) setView({ kind: 'error' });
      else setView((previous) => previous.kind === 'gift'
        ? { ...previous, offline: error instanceof WorkerError && error.status === 429 ? 'busy' : 'unreachable' }
        : { kind: 'connection', busy: error instanceof WorkerError && error.status === 429 });
    }
  }, [code]);

  useEffect(() => {
    if (!auth.ready || !code || auth.sessionEnded) return;
    setView((previous) => previous.kind === 'gift' ? previous : { kind: 'loading' });
    void load();
  }, [auth.ready, auth.authenticated, auth.sessionEnded, code, load]);

  // An accepted receiver watches the same link while the giver transfers it. A tab restored from the background
  // reads it immediately; the timer never spends on a hidden page.
  useEffect(() => {
    if (view.kind !== 'gift' || view.gift.status === 'transferred' || auth.sessionEnded) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 3000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [view.kind === 'gift' ? `${view.gift.tokenId}:${view.gift.status}:${view.gift.viewer}` : view.kind, auth.sessionEnded, load]);

  const accept = useCallback(async () => {
    if (pending.current || !authRef.current.needSession()) return;
    pending.current = true;
    setAccepting(true);
    try {
      const token = await authRef.current.getIdentityToken();
      if (!token) { authRef.current.endSession(true, true); return; }
      await workerApi.acceptGift(token, code);
      await load();
    } catch (error) {
      if (error instanceof WorkerError && error.status === 401) authRef.current.endSession(true, true);
      else await load(); // A competing acceptance or transfer is decided by the current code read.
    } finally { pending.current = false; setAccepting(false); }
  }, [code, load]);

  // `ReturnToPlace` carries this action through Google's `/` redirect. Only that tap accepts automatically;
  // opening a link with an existing session leaves the decision to its button.
  useEffect(() => {
    if (view.kind !== 'gift' || !auth.authenticated || peekPendingAction() !== 'giftAccept') return;
    takePendingAction();
    if (view.gift.status === 'waiting' && view.gift.viewer !== 'giver') void accept();
  }, [view, auth.authenticated, accept]);

  const status = view.kind === 'gift' ? receiverState(view.gift, auth.authenticated) : null;
  useEffect(() => {
    if (status === previousStatus.current) return;
    previousStatus.current = status;
    if (status === 'received') document.getElementById('gift-title')?.focus();
    if (status === 'accepted') document.getElementById('gift-accepted-line')?.focus();
  }, [status]);

  const header = auth.authenticated ? <Header end={<AccountControl />} /> : null;
  if (view.kind === 'error' || view.kind === 'connection') {
    const message = view.kind === 'error' ? DEAD : view.busy ? BUSY : OFFLINE;
    return <Shell accent="none" fill header={header}><Page fill width="narrow"><Center>
      <Heading level={1} variant="title-2" align="center">{message}</Heading>
      {view.kind === 'error' ? <Button href="/">Go home</Button> : <Button onClick={() => void load()}>Try again</Button>}
    </Center></Page></Shell>;
  }

  if (view.kind === 'loading') return <Shell accent="none" fill header={header}><Page fill>
    <Centerpiece labelledBy="gift-title" text={<Note id="gift-title" tone="status">Opening your gift…</Note>}
      actions={<Button block disabled>Accept your gift</Button>}>
      <Stack gap={4} align="center"><Skeleton shape="pet" /><Skeleton shape="name" /></Stack>
    </Centerpiece>
  </Page></Shell>;

  const { gift, pet } = view;
  const { name, tokenId, fullness } = gift;
  const giver = status === 'giver';
  const received = status === 'received';
  const accepted = status === 'accepted';
  const signedOutHeld = status === 'signed-out-held';
  const showWords = !giver && !accepted && !received && !signedOutHeld;
  const fullLine = `Once your friend hands ${name} over, you'll be ${name}'s owner — that's public forever, even if this game shuts down. ${name}'s owner will see your first name from Google.`;
  const asleepLine = `${name} is asleep right now. Once ${name} is yours, a meal will wake ${name} up.`;
  const max = gift.errand?.maxCents;
  const price = max === undefined ? null : Number.isInteger(max) ? `${max}¢` : formatCents(max);
  const errandLine = price !== null ? `${name} is finishing an errand started by the current owner. It may use up to ≈ ${price} of ${name}'s food after you accept.` : null;
  const acceptedText = `You accepted ${name}! Now ${name}'s owner hands ${name} over — ${name} will show up here when they do.`;
  const offlineLine = view.offline === 'busy' ? BUSY : `Can't reach ${name} right now. Nothing's lost — try again in a moment.`;
  const figure = <PetStage
    pet={<PetFigure tokenId={tokenId} name={name} state={fullness.state} stage={pet.stage} mood={pet.mood} size="hero" lost={lost} onLost={() => setLost(true)} {...wearProps(pet.worn)} />}
    motion={lost || !canUseWebGL() ? null : <MotionToggle paused={paused} onToggle={toggleMotion} />}
    plate={<PetPlate name={name} level={0} fullness={{ state: fullness.state, level: fullness.state === 'hungry' ? fullness.level : undefined }} />}
  />;
  let words = null;
  if (giver) words = <Heading level={1} variant="title-3" id="gift-title">{`This is your gift link for ${name}. Send it to the friend you're giving ${name} to.`}</Heading>;
  else if (received) words = <Heading level={1} id="gift-title" tabIndex={-1}>{name} is yours!</Heading>;
  else if (showWords || accepted) words = <Stack gap={4}>
    <Heading level={1} id="gift-title">{name} is a gift for you!</Heading>
    <Text>{fullLine}</Text><HatchNotices name={name} />
  </Stack>;
  let actions;
  if (giver) actions = <Button block href={petPath(tokenId)}>Go to {name}</Button>;
  else if (received) actions = <Button block href={petPath(tokenId)}>Go to {name}</Button>;
  else if (accepted) actions = <Stack gap={3}>
    <Text id="gift-accepted-line" tabIndex={-1}>{acceptedText}</Text>
    <Button block variant="secondary" href={petPath(tokenId)}>Visit {name}</Button>
    {hatched === false ? <Button block variant="secondary" href={`/hatch?from=${tokenId}`}>Get your own pet</Button> : null}
  </Stack>;
  else if (signedOutHeld) actions = <Stack gap={3}><Button block onClick={() => signIn.begin('signin')}>Sign in with Google to see your gift</Button><SignInOutcome /></Stack>;
  else actions = <Stack gap={3}>
    {fullness.state === 'asleep' ? <Text>{asleepLine}</Text> : null}
    {errandLine ? <Text>{errandLine}</Text> : null}
    {auth.authenticated ? <Button block disabled={accepting} onClick={() => void accept()}>Accept {name}</Button>
      : <Button block onClick={() => signIn.begin('giftAccept')}>Sign in with Google to accept {name}</Button>}
    <SignInOutcome action="giftAccept" />
  </Stack>;

  if (view.offline) actions = <Stack gap={3}><Note tone="error">{offlineLine}</Note><Button block variant="secondary" onClick={() => void load()}>Try again</Button></Stack>;

  return <Shell accent={makePet(tokenId).hue} fill header={header}><Page fill width={words ? undefined : 'narrow'}>
    <Centerpiece labelledBy="gift-title" text={words} actions={actions} status={view.offline ? offlineLine : accepted ? acceptedText : received ? `${name} is yours!` : ''}>
      {figure}
    </Centerpiece>
  </Page></Shell>;
}
