import { useCallback, useEffect, useRef, useState } from 'react';
import { Actions, Button, Centerpiece, Cluster, Header, Heading, Inert, Live, Note, Page, Sheet, Shell, Skeleton, Stack, Surface, Text, TextLink, Toast } from '../ds';
import { AccountControl } from '../account/AccountControl';
import { onClearOutcome } from '../account/clearMemory';
import { FORM_WORD } from '../errands/lines';
import { FeedLayer } from '../feeding/FeedLayer';
import { openFeed, useFeedRequest } from '../feeding/feedRequest';
import { PetFigure } from '../pet/PetFigure';
import { makePet } from '../pet/proto/generator.js';
import { go, petPath, verifyPath } from '../route';
import { useAuth } from '../seams/auth';
import { workerApi, WorkerError, toastHeld, type ErrandForm, type ExperienceNotes, type PetView } from '../seams/worker';
import { useSignIn } from '../signin/signIn';
import { queueAction } from '../screens/pet/parts';
import { wearProps } from '../wardrobe/catalogue';
import { acceptsNotes, publishableNotes } from './notesState';

type State = { kind: 'loading' | 'error' | 'signed-out' | 'lost' } | { kind: 'ready'; data: ExperienceNotes };

/** The notes never enter browser storage. Every read is checked again by the Worker against the chain owner. */
export function ExperienceNotesPage({ pet, tokenOf, reread }: { pet: PetView; tokenOf: () => Promise<string | null>; reread: () => void }) {
  const { tokenId, name } = pet;
  const auth = useAuth();
  const signIn = useSignIn();
  const owner = pet.viewer === 'owner' && auth.authenticated && !auth.sessionEnded;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [sheetNote, setSheetNote] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [lostToast, setLostToast] = useState(false);
  const serial = useRef(0);
  const previousNotes = useRef<ExperienceNotes | null>(null);
  const pendingRef = useRef(false);
  const publishedOutcome = useRef<HTMLDivElement>(null);
  const latest = useRef({ owner, tokenId });
  latest.current = { owner, tokenId };
  const feed = useFeedRequest();

  const read = useCallback(async () => {
    const turn = ++serial.current;
    const sheetWasOpen = sheetNote !== null;
    setState({ kind: 'loading' });
    setStatus('');
    try {
      const reply = await workerApi.experience(await tokenOf(), tokenId);
      if (turn !== serial.current || !latest.current.owner || !acceptsNotes(reply, latest.current.tokenId, null)) return;
      const before = previousNotes.current;
      if (before && before.generation === reply.generation && before.notes.length === 6 && reply.notes.length === 6
        && reply.notes.some((note) => !before.notes.some((old) => old.id === note.id))
        && before.notes.some((note) => !reply.notes.some((next) => next.id === note.id))) setStatus('Oldest note replaced');
      previousNotes.current = reply;
      setState({ kind: 'ready', data: reply });
    } catch (error) {
      if (turn !== serial.current || !latest.current.owner) return;
      if (error instanceof WorkerError && (error.status === 403 || error.code === 'stale_generation' || error.code === 'not_owner')) {
        setSheetNote(null);
        setState({ kind: 'lost' });
        setStatus(`${name} belongs to someone else now.`);
        setLostToast(sheetWasOpen);
        reread();
      } else if (error instanceof WorkerError && error.status === 401) {
        setSheetNote(null);
        setState({ kind: 'signed-out' });
        auth.endSession(false);
      } else setState({ kind: 'error' });
    }
  }, [tokenId, name, tokenOf, reread, auth, sheetNote]);

  useEffect(() => {
    if (owner) void read();
    else {
      ++serial.current;
      previousNotes.current = null;
      setSheetNote(null);
      setState({ kind: pet.viewer === 'visitor' || auth.sessionEnded ? 'signed-out' : 'lost' });
      if (pet.viewer === 'guest' && auth.freshSignIn) go(petPath(tokenId));
    }
    // The owner/session identity, not an unrelated rerender, starts a read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, tokenId, pet.viewer, pet.viewer === 'owner' ? pet.memoryEpoch : null, auth.nearAccountId]);

  useEffect(() => {
    const visible = () => {
      if (document.visibilityState !== 'visible') return;
      reread();
      if (latest.current.owner) void read();
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [read, reread]);

  useEffect(() => onClearOutcome((outcome) => {
    if (outcome.tokenId !== tokenId) return;
    setSheetNote(null);
    if (outcome.result === 'not_owner') { setState({ kind: 'lost' }); reread(); }
    else { reread(); void read(); }
  }), [tokenId, read, reread]);

  useEffect(() => {
    if (state.kind === 'lost') document.getElementById('experience-heading')?.focus();
  }, [state.kind]);

  const data = owner && state.kind === 'ready' ? state.data : null;
  const nextField = publishableNotes(data).find((note) => note.id !== data?.field?.noteId) ?? null;
  const candidate = publishableNotes(data).find((note) => note.id === sheetNote) ?? null;
  useEffect(() => { if (sheetNote && !candidate) setSheetNote(null); }, [sheetNote, candidate]);
  useEffect(() => { if (sheetNote === null) setSheetError(false); }, [sheetNote]);
  useEffect(() => {
    if (sheetNote === null && status === 'Field published') publishedOutcome.current?.focus();
  }, [sheetNote, status]);

  const lost = (fromSheet = false) => {
    setSheetNote(null);
    setState({ kind: 'lost' });
    setStatus(`${name} belongs to someone else now.`);
    setLostToast(fromSheet);
    reread();
  };
  const approve = async (noteId: string, approved: boolean) => {
    if (!data || pendingRef.current || !auth.needSession()) return;
    pendingRef.current = true;
    setPending(noteId);
    try {
      await workerApi.approveExperience(await tokenOf(), tokenId, noteId, approved, data.generation);
      if (!latest.current.owner) return;
      setState({ kind: 'ready', data: { ...data,
        notes: data.notes.map((note) => note.id === noteId ? { ...note, approved } : note),
        field: !approved && data.field?.noteId === noteId ? null : data.field,
      } });
      setStatus(approved ? 'Used in outside answers' : 'Private again');
    } catch (error) {
      if (error instanceof WorkerError && (error.status === 403 || error.code === 'stale_generation')) lost();
      else if (error instanceof WorkerError && error.status === 401) auth.endSession(false);
      else void read();
    } finally { pendingRef.current = false; setPending(null); }
  };
  const publish = async () => {
    if (!data || !candidate || pendingRef.current || !auth.needSession()) return;
    pendingRef.current = true;
    setPending('field');
    setSheetError(false);
    try {
      await workerApi.publishExperienceField(await tokenOf(), tokenId, candidate.id, data.generation);
      if (!latest.current.owner) return;
      setState({ kind: 'ready', data: { ...data, field: { noteId: candidate.id, wording: candidate.proposedField, sourceReportId: candidate.sourceReportId } } });
      setSheetNote(null);
      setStatus('Field published');
    } catch (error) {
      if (error instanceof WorkerError && (error.status === 403 || error.code === 'stale_generation')) lost(true);
      else if (error instanceof WorkerError && error.status === 401) auth.endSession(false);
      else setSheetError(true);
    } finally { pendingRef.current = false; setPending(null); }
  };

  const source = (id: string, at: number, form?: ErrandForm) => <TextLink href={verifyPath(tokenId, id)} tone="quiet" iconEnd="chevron">
    {`${form ? `${FORM_WORD[form]} · ` : ''}${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`}
  </TextLink>;
  const feedPet = () => openFeed({ tokenId, name, label: name, elsewhere: false });
  const sendErrand = () => { queueAction('errand'); go(petPath(tokenId)); };
  const aside = <Cluster gap={3} align="center">
    <PetFigure tokenId={tokenId} name={name} state={pet.fullness.state} stage={pet.stage} mood={pet.mood} size="sm" decorative still {...wearProps(pet.worn)} />
    <Heading level={1} id="experience-heading" tabIndex={-1}>Review experience</Heading>
  </Cluster>;
  const message = state.kind === 'loading' ? `Loading ${name}'s experience…` : state.kind === 'error' ? "Experience couldn't load. Try again." : state.kind === 'signed-out' ? `Sign in to review ${name}'s notes` : state.kind === 'lost' ? `${name} belongs to someone else now.` : '';
  const toastShown = lostToast && status === `${name} belongs to someone else now.`;
  const asleepOwner = pet.fullness.state === 'asleep' && owner && data;
  const sparse = asleepOwner ? <><Note tone="plain">{`${name} is asleep. Feed ${name} to send another errand.`}</Note><Button variant="secondary" onClick={feedPet}>{`Feed ${name}`}</Button></>
    : state.kind === 'error' ? <><Note tone="error">{message}</Note><Button variant="secondary" onClick={() => void read()}>Try again</Button></>
    : state.kind === 'signed-out' ? <><Note tone="plain">{message}</Note><Button onClick={() => signIn.begin('signin')}>Sign in</Button></>
    : state.kind === 'ready' && !data?.notes.length ? <><Note tone="plain">No work notes yet. A completed paid errand may leave one here.</Note><Button variant="secondary" onClick={sendErrand}>Send an errand</Button></>
    : null;
  const fieldCard = data?.field || nextField ? <Surface><Stack gap={3} align="flex-start">
    <Text variant="body-strong">{data?.field?.wording ?? nextField?.proposedField}</Text>
    {nextField ? <Button variant="secondary" haspopup="dialog" onClick={() => setSheetNote(nextField.id)}>Publish field</Button> : null}
  </Stack></Surface> : null;
  const notesList = data?.notes.length ? <Stack as="ol" gap={3}>{data.notes.map((note) => <Surface as="li" selected={note.approved} key={note.id}><Stack gap={3}>
    <Text>{note.text}</Text>
    {source(note.sourceReportId, note.at, note.sourceForm)}
    <Cluster gap={3} align="center" justify="space-between"><Text variant="small" tone="secondary">{note.approved ? 'Used in outside answers' : 'Private'}</Text>
      <Button variant="secondary" size="compact" pending={pending === note.id} onClick={() => void approve(note.id, !note.approved)}>{note.approved ? 'Stop using' : 'Use in outside answers'}<span className="ds-hidden">{` for ${note.text}`}</span></Button>
    </Cluster>
  </Stack></Surface>)}</Stack> : null;
  return <Shell accent={makePet(tokenId).hue} header={<Inert on={candidate || feed ? true : undefined}><Header
    start={<Button variant="ghost" size="compact" icon="back" href={petPath(tokenId)}>{`Back to ${name}`}</Button>}
    end={state.kind === 'signed-out' ? <Button variant="secondary" size="compact" onClick={() => signIn.begin('signin')}>Sign in</Button> : <AccountControl tokenId={tokenId} name={name} viewer={owner ? 'owner' : pet.viewer} />}
  /></Inert>}>
    <Inert on={candidate || feed ? true : undefined}><Page width="default">{sparse ? <>
      {status ? <Note tone={state.kind === 'lost' ? 'error' : 'plain'}>{status}</Note> : null}
      <Centerpiece compact><Stack gap={4} align="center">{aside}{sparse}</Stack></Centerpiece>
      {asleepOwner ? <Stack gap={5}>{fieldCard}{notesList}</Stack> : null}
      <Live>{status || message}</Live>
    </> : <Stack gap={5}>
      {toastShown ? <div style={{ height: 'calc(var(--size-target) + var(--space-3))' }} aria-hidden="true" /> : null}
      {aside}
      {status && !toastShown ? <div ref={publishedOutcome} tabIndex={status === 'Field published' ? -1 : undefined}><Note tone={state.kind === 'lost' ? 'error' : 'plain'}>{status}</Note></div> : null}
      {fieldCard}
      {notesList}
      {state.kind === 'loading' ? <Stack gap={3}><Note tone="status">{message}</Note><Skeleton shape="name" /><Skeleton shape="line" /><Skeleton shape="short" /></Stack> : null}
      <Live>{status || message}</Live>
    </Stack>}</Page></Inert>
    <FeedLayer pageFullness={pet.fullness} />
    {candidate ? <Sheet title="Publish field" centered onClose={() => setSheetNote(null)} status={sheetError ? "Field wasn't published. Check your connection and try again." : ''}
      foot={<Actions><Button variant="secondary" onClick={() => setSheetNote(null)}>Keep private</Button><Button pending={pending === 'field'} onClick={() => void publish()}>{sheetError ? 'Try again' : 'Publish field'}</Button></Actions>}>
      <Stack gap={4}><Text>This field is public. It describes documented work, not certified expertise.</Text><Text variant="body-strong">{candidate.proposedField}</Text>{source(candidate.sourceReportId, candidate.at, candidate.sourceForm)}
        {sheetError ? <Note tone="error">Field wasn't published. Check your connection and try again.</Note> : null}</Stack>
    </Sheet> : null}
    {toastShown ? <Toast silent onDone={toastHeld() ? undefined : () => setLostToast(false)}>{status}</Toast> : null}
  </Shell>;
}
