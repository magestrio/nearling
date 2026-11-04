import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccountControl } from '../account/AccountControl';
import { Button, Cluster, Grid, Header, Heading, Live, Note, Page, Shell, Skeleton, SkillBadge, Stack, Surface, Text, TextField } from '../ds';
import { resetTime } from '../lib/time';
import { PetFigure } from '../pet/PetFigure';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi } from '../seams/worker';
import type { HireBoard } from '../seams/worker-types';
import { useSignIn } from '../signin/signIn';
import { boardMatches } from './board';
import './hireBoard.css';

const FRESH = 'Availability may have changed. We check again before your question is sent.';
type BoardView = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; board: HireBoard; noHome: boolean };

function Picture({ tokenId, name, stage = 'adult', state = 'full', worn }: {
  tokenId: string; name: string; stage?: 'baby' | 'teen' | 'adult'; state?: 'full' | 'hungry' | 'asleep'; worn?: string | null;
}) {
  return <div className={state === 'asleep' ? 'hire-board-picture--asleep' : undefined} style={{ blockSize: 'var(--size-pet-md)', inlineSize: '100%', maxInlineSize: 'var(--size-pet-md)', marginInline: 'auto', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
    <PetFigure tokenId={tokenId} name={name} stage={stage} state={state} outfit={worn ?? undefined} size="md" decorative still lost />
  </div>;
}

function statusLine(pet: HireBoard['pets'][number]): string {
  switch (pet.status) {
    case 'asleep': return `${pet.name} is asleep`;
    case 'resting': return `${pet.name} is resting until ${resetTime(pet.until)}`;
    case 'paused': return `${pet.name} will be back soon`;
    case 'available': return `${pet.name} can help now`;
  }
}

function Card({ pet }: { pet: HireBoard['pets'][number] }) {
  return <Surface as="li"><Stack gap={3}>
    <Picture tokenId={pet.tokenId} name={pet.name} state={pet.status === 'asleep' ? 'asleep' : 'full'} />
    <Heading level={2} variant="title-3">{pet.name}</Heading>
    <SkillBadge name={pet.name} label={pet.label} />
    <Text variant="small" tone="secondary">{pet.yours ? 'Yours' : `${pet.price.cents}¢ to ask`}</Text>
    <Note tone="plain">{statusLine(pet)}</Note>
    <Button variant="secondary" href={`/pet/${pet.tokenId}`} block>{`Visit ${pet.name}`}</Button>
  </Stack></Surface>;
}

function Visit({ pet }: { pet: HireBoard['visits'][number] }) {
  return <Surface as="li"><Stack gap={3}>
    <Picture tokenId={pet.tokenId} name={pet.name} stage={pet.stage} state={pet.fullness} worn={pet.worn} />
    <Heading level={2} variant="title-3">{pet.name}</Heading>
    <Button variant="secondary" href={`/pet/${pet.tokenId}`} block>{`Visit ${pet.name}`}</Button>
  </Stack></Surface>;
}

export function HireBoardPage() {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const { begin } = useSignIn();
  const [view, setView] = useState<BoardView>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!auth.ready) return undefined;
    let current = true;
    setView({ kind: 'loading' });
    void (async () => {
      try {
        // a render the effect ran twice for (StrictMode) reads the board once: the first run is cleaned up before this resumes
        await Promise.resolve();
        if (!current) return;
        let token = authRef.current.authenticated ? await authRef.current.getIdentityToken() : null;
        if (!current) return;
        if (authRef.current.authenticated && token === null) {
          authRef.current.endSession(false);
          token = null;
        }
        let board: HireBoard;
        try { board = await workerApi.hireBoard(token); }
        catch (error) {
          if (!(error instanceof WorkerError) || error.status !== 401) throw error;
          authRef.current.endSession(false);
          board = await workerApi.hireBoard(null);
          token = null;
        }
        let noHome = false;
        if (board.pets.length === 0 && board.visits.length === 0 && token !== null) {
          try { noHome = (await workerApi.me(token)).ownedCount === 0; }
          catch (error) {
            if (error instanceof WorkerError && error.status === 401) authRef.current.endSession(false);
            else throw error;
          }
        }
        if (current) setView({ kind: 'ready', board, noHome });
      } catch {
        if (current) setView({ kind: 'error' });
      }
    })();
    return () => { current = false; };
  }, [auth.ready, auth.authenticated, retry]);

  const again = () => setRetry((n) => n + 1);
  const visitor = !auth.authenticated || auth.sessionEnded;
  const pets = view.kind === 'ready' ? view.board.pets : [];
  const filtered = boardMatches(pets, query);
  const noHome = view.kind === 'ready' && view.noHome;
  let body: ReactNode;
  let live = '';
  if (view.kind === 'loading') {
    live = 'Finding pets who can help…';
    body = <Stack gap={4}><Note tone="status">{live}</Note><Grid>{[0, 1, 2].map((i) => <Surface as="li" key={i}><Stack gap={3}><div style={{ blockSize: 'var(--size-pet-md)', maxInlineSize: 'var(--size-pet-md)', marginInline: 'auto' }}><Skeleton shape="pet" /></div><Skeleton shape="name" /><Skeleton shape="line" /></Stack></Surface>)}</Grid></Stack>;
  } else if (view.kind === 'error') {
    live = "We couldn't load the board right now. Try again in a moment.";
    body = <Stack gap={3}><Note tone="error" silent>{live}</Note><Cluster><Button variant="secondary" onClick={again}>Try again</Button></Cluster></Stack>;
  } else if (pets.length === 0) {
    const visits = view.board.visits;
    body = <Stack gap={visits.length ? 5 : 4}>
      <Text variant="lead">{visits.length ? 'No pets with skills are on the board yet. Meanwhile, you can visit these pets:' : 'No pets with skills are on the board yet.'}</Text>
      {visits.length ? <Grid>{visits.map((pet) => <Visit key={pet.tokenId} pet={pet} />)}</Grid> : null}
      <Cluster><Button variant={noHome ? 'secondary' : 'primary'} href={noHome ? undefined : '/'} onClick={noHome ? again : undefined}>{noHome ? 'Try again' : 'Go home'}</Button></Cluster>
    </Stack>;
  } else if (filtered.length === 0) {
    live = `No skill labels match “${query}”.`;
    body = <Stack gap={3}><Text>{live}</Text><Cluster><Button variant="secondary" onClick={() => setQuery('')}>Show all</Button></Cluster></Stack>;
  } else {
    body = <Grid>{filtered.map((pet) => <Card key={pet.tokenId} pet={pet} />)}</Grid>;
  }

  return <Shell header={<Header start={noHome ? null : <Button variant="ghost" size="compact" icon="back" href="/">Home</Button>}
    end={visitor ? <Button variant="secondary" size="compact" onClick={() => begin('signin')}>Sign in</Button> : <AccountControl />} />}>
    <Page><Stack gap={5}>
      <Heading level={1} id="hire-title">Find a pet to ask</Heading>
      {(view.kind === 'error' || (view.kind === 'ready' && pets.length > 0)) ? <TextField label="Search skills" value={query} onChange={setQuery} /> : null}
      {view.kind === 'ready' && filtered.length > 0 ? <Text variant="small" tone="secondary">{FRESH}</Text> : null}
      {visitor && view.kind === 'ready' && pets.length > 0 ? <Note tone="plain">Sign in to ask a pet.</Note> : null}
      {body}
      <Live>{live}</Live>
    </Stack></Page>
  </Shell>;
}
