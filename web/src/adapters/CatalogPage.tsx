import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccountControl } from '../account/AccountControl';
import { Button, CatalogEntry, CatalogList, Cluster, Header, Heading, Inert, Note, Page, Shell, Skeleton, Stack, Text } from '../ds';
import { PetFigure } from '../pet/PetFigure';
import { makePet } from '../pet/proto/generator.js';
import { go, hatchPath, petPath, useLocation } from '../route';
import { useAuth } from '../seams/auth';
import { WorkerError } from '../seams/worker';
import type { CatalogEntryView } from '../seams/worker-types';
import { peekPendingAction, takePendingAction } from '../screens/pet/parts';
import { SignInOutcome } from '../signin/SignInOutcome';
import { takeReturnSheet } from '../signin/returnPlace';
import { useSignIn } from '../signin/signIn';
import { holdSkillArrival } from './arrival';
import { AdapterSheet } from './AdapterSheet';
import {
  backTo,
  BROWSE_ONLY,
  CATALOG_EMPTY,
  CATALOG_ERROR,
  CATALOG_LABEL,
  CATALOG_LOADING,
  CATALOG_TITLE,
  connectedLine,
  connectTo,
  FOURTH_SOURCE,
  GET_OWN_PET,
  GO_HOME,
  goTo,
  NO_PET_LINE,
  SIGNED_OUT_LINE,
} from './lines';
import { MAX_SOURCES, useCatalog, type CatalogRole } from './useCatalog';
import { useAdapter } from './useAdapter';

// Adapter catalog (`Adapter catalog screen`, `Catalog flow`) drawn from design/bundle/screens/catalog.js: a page of its own at
// `/adapters`, or `/adapters?pet=<token_id>` from a pet's Skill sheet. The header («Back to {name}» for the owner of that pet, «Account»
// for a signed-in player; empty for a visitor), the h1, the line for who is looking, then one column of entry cards — name, «from» the
// pet, the address, the tools' descriptions, and for the owner «Connect to {name}'s skill» at the foot. Loading, error and empty stand
// in the list's place. The connect sheet is Adapter sheet over the page (`catalog` variant). Each pet is drawn flat: a long list must
// not take a WebGL context for every card.

const COLLAPSE = 'catalog-full';

/** `Adapter catalog screen` › «success»: «Back to {name}» is a plain link; the page it leads to opens Skill sheet (`arrival.ts`). */
function BackLink({ tokenId, name }: { tokenId: string; name: string }) {
  return (
    <span
      onClick={(e) => {
        if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) holdSkillArrival(tokenId);
      }}
    >
      <Button variant="ghost" size="compact" icon="back" href={petPath(tokenId)}>
        {backTo(name)}
      </Button>
    </span>
  );
}

function lineFor(role: CatalogRole): ReactNode {
  if (role.kind === 'visitor') {
    return <Text>{SIGNED_OUT_LINE}</Text>;
  }
  if (role.kind === 'player') return <Text>{BROWSE_ONLY}</Text>;
  if (role.kind === 'no-pet') {
    return <Text>{NO_PET_LINE}</Text>;
  }
  return null;
}

export function CatalogPage({ pet }: { pet: string | null }) {
  const auth = useAuth();
  const { begin } = useSignIn();
  const here = useLocation();
  const catalog = useCatalog(pet);
  const { view, role, tokenOf, refused } = catalog;
  const owner = role?.kind === 'owner' ? role : null;
  const name = owner?.name ?? '';
  const tokenId = owner?.tokenId ?? pet ?? '';

  // A saved connect leads to the pet's page with Skill sheet and the line (`Adapter connect flow` › «saved»).
  // A `401` under the open sheet ends the session; the page has no poll to say so before the tap, so the sheet is opened again on the
  // same entry and name, and it meets the ended-session line with «Sign in» (`Session expiry flow`).
  const [again, setAgain] = useState<{ entry: CatalogEntryView; label: string } | null>(null);
  const held = useRef<{ entry: CatalogEntryView | null; label: string }>({ entry: null, label: '' });
  const adapter = useAdapter(tokenId, {
    tokenOf,
    refused: (e) => {
      if (e instanceof WorkerError && e.status === 401 && held.current.entry) setAgain({ entry: held.current.entry, label: held.current.label });
      refused(e);
    },
    done: ({ label }) => {
      holdSkillArrival(tokenId, connectedLine(name, label));
      go(petPath(tokenId));
    },
    back: () => {
      holdSkillArrival(tokenId);
      go(petPath(tokenId));
    },
  });
  held.current = { entry: adapter.fields.current.entry, label: adapter.fields.current.label };
  useEffect(() => {
    if (!again) return;
    setAgain(null);
    adapter.openEntry(again.entry);
    adapter.setLabel(again.label);
    // the sheet is opened once per ended session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [again]);
  const entries = view.kind === 'ready' ? view.entries : null;

  // Back from the sign-in of the connect sheet's ended-session line: the sheet opens again on the entry it was on, unchecked fields
  // as typed are the entry's own, so the entry is found by its address.
  const reopened = owner !== null && entries !== null;
  useEffect(() => {
    if (!reopened || peekPendingAction() !== 'adapter') return;
    takePendingAction();
    const typed = takeReturnSheet('adapter', here);
    const entry = typed ? entries?.find((e) => e.address === typed.address) : undefined;
    if (entry) adapter.openEntry(entry);
    // once, when the page first knows who is looking and what is listed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reopened]);

  const full = owner !== null && owner.sources >= MAX_SOURCES;
  const connect = (entry: CatalogEntryView) => {
    if (!auth.needSession()) return;
    adapter.openEntry(entry);
  };

  const header =
    role === null ? (
      <Header />
    ) : role.kind === 'visitor' ? (
      <Header start={<Button variant="ghost" size="compact" icon="back" href="/">{GO_HOME}</Button>} end={<Button variant="secondary" size="compact" onClick={() => begin('signin')}>Sign in</Button>} />
    ) : (
      <Header start={owner ? <BackLink tokenId={owner.tokenId} name={owner.name} /> : role.kind === 'player' ? <Button variant="ghost" size="compact" icon="back" href={petPath(role.tokenId)}>{goTo(role.name)}</Button> : undefined} end={<AccountControl />} />
    );

  let body: ReactNode;
  if (view.kind === 'loading') {
    body = (
      <Stack gap={3}>
        <Note tone="status">{CATALOG_LOADING}</Note>
        {[0, 1].map((i) => (
          <Stack key={i} gap={2}>
            <Skeleton shape="name" />
            <Skeleton shape="line" />
            <Skeleton shape="short" />
          </Stack>
        ))}
      </Stack>
    );
  } else if (view.kind === 'error') {
    body = (
      <Stack gap={3}>
        <Note tone="error">{CATALOG_ERROR}</Note>
        <Cluster>
          <Button variant="secondary" size="compact" onClick={catalog.tryAgain}>
            Try again
          </Button>
        </Cluster>
      </Stack>
    );
  } else if (view.entries.length === 0) {
    body = <Text tone="secondary">{CATALOG_EMPTY}</Text>;
  } else {
    body = (
      <CatalogList label={CATALOG_LABEL}>
        {view.entries.map((entry) => {
          const nameId = `entry-${entry.id}`;
          return (
            <CatalogEntry
              key={entry.id}
              name={entry.name}
              nameId={nameId}
              from={entry.petName}
              hue={makePet(entry.petId).hue}
              address={entry.address}
              tools={entry.tools.map((t): [string, string] => [t.name, t.description])}
              pet={<PetFigure tokenId={entry.petId} name={entry.petName} size="sm" decorative lost />}
              action={
                owner ? (
                  <Button
                    variant="secondary"
                    size="compact"
                    icon="plus"
                    haspopup="dialog"
                    nameWith={nameId}
                    off={full}
                    describedBy={full ? COLLAPSE : undefined}
                    expanded={adapter.open && adapter.entry?.id === entry.id ? true : undefined}
                    onClick={() => connect(entry)}
                  >
                    {connectTo(owner.name)}
                  </Button>
                ) : null
              }
            />
          );
        })}
      </CatalogList>
    );
  }

  const line = view.kind !== 'loading' && role !== null ? lineFor(role) : null;

  return (
    <Shell accent="none" header={<Inert on={adapter.open}>{header}</Inert>}>
      <Inert on={adapter.open}>
        <Page width="default">
          <Stack gap={5}>
            <Stack gap={2}>
              <Heading level={1}>{CATALOG_TITLE}</Heading>
              {role?.kind === 'visitor' || role?.kind === 'no-pet' ? <Cluster><Button variant="secondary" size="compact" href={hatchPath()}>{GET_OWN_PET}</Button></Cluster> : null}
              {role?.kind === 'unavailable' ? <Cluster><Button variant="secondary" size="compact" onClick={catalog.tryAgain}>Try again</Button></Cluster> : null}
            </Stack>
            {line}
            {full ? <Text id={COLLAPSE}>{FOURTH_SOURCE}</Text> : null}
            <SignInOutcome />
            {body}
          </Stack>
        </Page>
      </Inert>
      {owner ? <AdapterSheet name={owner.name} adapter={adapter} tokenId={owner.tokenId} onClose={adapter.close} /> : null}
    </Shell>
  );
}
