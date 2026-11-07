import { useEffect, useState } from 'react';
import { AccountControl } from '../account/AccountControl';
import { Button, Centerpiece, Cluster, Header, Heading, IconButton, Live, Note, Page, Shell, Skeleton, Stack, Surface, Text } from '../ds';
import { FeedLayer } from '../feeding/FeedLayer';
import { onFed, openFeed } from '../feeding/feedRequest';
import { PetFigure } from '../pet/PetFigure';
import { makePet } from '../pet/proto/generator.js';
import { petPath } from '../route';
import { useAuth } from '../seams/auth';
import { workerApi, WorkerError, type PetView, type RelationshipSummary } from '../seams/worker';
import { useSignIn } from '../signin/signIn';
import { wearProps } from '../wardrobe/catalogue';

type State =
  | { kind: 'loading' | 'error' | 'signed-out' | 'lost'; pet: PetView | null }
  | { kind: 'ready'; pet: PetView; summary: RelationshipSummary; accountId: string | null };

export function relationshipLabel(row: RelationshipSummary['relationships'][number], now = Date.now()): string {
  if (row.breakUntil !== null && row.breakUntil > now) {
    const time = new Date(row.breakUntil).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    return `Taking a break until ${time}`;
  }
  return row.stance === 'liked' ? 'Likes' : row.stance === 'strained' ? 'Strained' : 'Getting to know';
}

/** Private rows exist only in this mounted screen and are discarded before every new ownership check. */
export function SocietyPage({ tokenId }: { tokenId: string }) {
  const auth = useAuth();
  const signIn = useSignIn();
  const [state, setState] = useState<State>({ kind: 'loading', pet: null });
  const [read, setRead] = useState(0);
  const { authenticated, ready, sessionEnded, nearAccountId, getIdentityToken } = auth;

  useEffect(() => {
    if (!ready) return;
    let current = true;
    setState((before) => ({ kind: 'loading', pet: before.pet }));
    const load = async () => {
      let pet: PetView | null = null;
      try {
        const token = authenticated && !sessionEnded ? await getIdentityToken() : null;
        if (!current) return;
        pet = await workerApi.pet(token, tokenId);
        if (!current) return;
        if (token === null) { setState({ kind: 'signed-out', pet }); return; }
        setState({ kind: 'loading', pet });
        const summary = await workerApi.relationships(token, tokenId);
        if (current && summary.tokenId === tokenId) setState({ kind: 'ready', pet, summary, accountId: nearAccountId });
      } catch (error) {
        if (!current) return;
        if (error instanceof WorkerError && error.status === 401) {
          setState({ kind: 'signed-out', pet });
          auth.endSession(false);
        } else if (error instanceof WorkerError && error.status === 403) setState({ kind: 'lost', pet });
        else setState({ kind: 'error', pet });
      }
    };
    if (document.visibilityState === 'visible') void load();
    return () => { current = false; };
  }, [tokenId, authenticated, ready, sessionEnded, nearAccountId, getIdentityToken, read]);

  useEffect(() => {
    const onVisibility = () => {
      setState((before) => ({ kind: 'loading', pet: before.pet }));
      setRead((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    let current = true;
    const stop = onFed((event) => {
      if (event.kind !== 'fed' || event.tokenId !== tokenId) return;
      void workerApi.pet(null, tokenId).then((freshPet) => {
        if (!current) return;
        setState((before) => before.kind === 'ready' && before.accountId === nearAccountId
          ? { ...before, pet: freshPet } : before);
      }).catch(() => {
        if (current) setRead((n) => n + 1);
      });
    });
    return () => { current = false; stop(); };
  }, [tokenId, nearAccountId]);

  const pet = state.pet;
  const name = pet?.name;
  const back = petPath(tokenId);
  const ownerActive = authenticated && !sessionEnded && ready && state.kind === 'ready' && state.accountId === nearAccountId;
  useEffect(() => {
    if (!ownerActive || state.kind !== 'ready') return;
    const nextExpiry = state.summary.relationships
      .map((row) => row.breakUntil)
      .filter((until): until is number => until !== null && until > Date.now())
      .sort((a, b) => a - b)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(() => {
      setState({ kind: 'loading', pet: state.pet });
      setRead((n) => n + 1);
    }, Math.min(nextExpiry - Date.now(), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [ownerActive, state]);
  const displayKind = state.kind === 'ready' && !ownerActive ? 'signed-out' : state.kind;
  const asleep = state.kind === 'ready' && pet?.fullness.state === 'asleep';
  const heading = <Cluster gap={3} align="center">
    {pet ? <PetFigure tokenId={tokenId} name={pet.name} state={asleep ? 'asleep' : pet.fullness.state} stage={pet.stage} mood={pet.mood} size="sm" decorative still {...wearProps(pet.worn)} /> : null}
    <Heading level={1}>Relationships</Heading>
  </Cluster>;
  const message = displayKind === 'loading' && name ? `Getting ${name}'s relationships…`
    : displayKind === 'error' ? "Couldn't load relationships. Try again."
      : displayKind === 'signed-out' && name ? `Sign in to see ${name}'s relationships`
        : displayKind === 'lost' ? 'This pet has a new owner.' : '';
  const rows = ownerActive && state.kind === 'ready' ? state.summary.relationships : [];
  const sparse = displayKind === 'error' || displayKind === 'signed-out' || (displayKind === 'ready' && rows.length === 0);
  const feed = () => { if (pet) openFeed({ tokenId, name: pet.name, label: pet.name, elsewhere: false }); };
  const body = state.kind === 'loading' ? <Stack gap={3}>
    {name ? <Note tone="status">{message}</Note> : null}
    <Skeleton shape="name" /><Skeleton shape="line" /><Skeleton shape="short" />
  </Stack> : displayKind === 'lost' ? <Stack gap={3}><Note tone="plain">{message}</Note>{name ? <Button variant="secondary" href={back}>{`Visit ${name}`}</Button> : null}</Stack> : state.kind === 'ready' ? <Stack gap={5}>
    {asleep && name ? <Stack gap={3}><Note tone="plain">{`${name} is asleep. Feed ${name} to ask a friend for help.`}</Note><Button haspopup="dialog" onClick={feed}>{`Feed ${name}`}</Button></Stack> : null}
    {rows.length ? <Stack as="ul" gap={3}>{rows.map((row) => <Surface as="li" key={row.tokenId}>
      <Text as="dl"><Cluster gap={3} align="center" justify="space-between"><Text as="dt" variant="body-strong">{row.name}</Text><Text as="dd" tone="secondary">{relationshipLabel(row)}</Text></Cluster></Text>
    </Surface>)}</Stack> : null}
  </Stack> : null;
  const action = displayKind === 'error' ? <Button variant="secondary" onClick={() => setRead((n) => n + 1)}>Try again</Button>
    : displayKind === 'signed-out' ? <Stack gap={3} align="center"><Button onClick={() => signIn.begin('signin')}>Sign in</Button>{name ? <IconButton href={back} variant="secondary" icon="back" label={`Back to ${name}`} /> : null}</Stack>
      : state.kind === 'ready' && !rows.length ? <Button href="/hire">Find a pet to ask</Button> : null;

  return <Shell accent={makePet(tokenId).hue} header={<Header
    start={name ? <Button variant="ghost" size="compact" icon="back" href={back}>{`Back to ${name}`}</Button> : null}
    end={displayKind === 'signed-out' ? null : name ? <AccountControl tokenId={tokenId} name={name} viewer={displayKind === 'ready' ? 'owner' : displayKind === 'lost' ? 'guest' : pet?.viewer ?? 'visitor'} /> : null}
  />}><Page width="default">{sparse ? <Centerpiece compact><Stack gap={4} align="center">{heading}<Stack gap={3} align="center">
    <Note tone={displayKind === 'error' ? 'error' : 'plain'}>{displayKind === 'ready' ? "No relationships yet. Feed a friend's pet or ask one for help." : message}</Note>{action}
  </Stack></Stack></Centerpiece> : <Stack gap={5}>{heading}{body}</Stack>}<Live>{message}</Live></Page>
    {pet && ownerActive ? <FeedLayer pageFullness={pet.fullness} /> : null}
  </Shell>;
}
