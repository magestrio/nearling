import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Header, Heading, Inert, ItemGrid, ItemNote, ItemTile, Live, Note, Page, PetStage, Shell, Split, Stack, Text, type Accent } from '../ds';
import { PetFigure, type PetHub } from '../pet/PetFigure';
import { useWaking } from '../screens/pet/useWaking';
import { petPath } from '../route';
import type { OwnerView } from '../screens/pet/usePetScreen';
import { useAuth } from '../seams/auth';
import { SESSION_LINE } from '../signin/session';
import { SignInLines, useSignInLines } from '../signin/SignInOutcome';
import { nameOf, wearProps } from './catalogue';
import { asleepLine, BUYING_LINE, loadingLine, pausedLine, signedOutLine, wearingLine } from './lines';
import { useKeepTileFocus } from './useKeepTileFocus';
import type { useWardrobe } from './useWardrobe';
import { LINE, wardrobeView, type TileDraw } from './wardrobeView';

// Wardrobe screen (add-wardrobe › Wardrobe screen) built from design/bundle/screens/wardrobe.js: the pet in what it wears at the left,
// the items at the right (on the phone the pet on top, the page scrolling): own first, then the earned not yet, then the ones to buy,
// each as a tile with its picture, its name and its one action. The lines about the page stand at the top of the column, the lines
// about the list at the top of the list, the food line just above the Buy items. What is drawn is `wardrobeView`'s; the words are the
// Scenarios' and the frames' `copy`, verbatim, in `lines.ts`.
type WardrobeState = ReturnType<typeof useWardrobe>;

/** The line under the pet after a purchase landed: the focus goes to it. */
const BOUGHT_ID = 'bought-line';

/** What the screen hands its pet: the lost context, the screen's motion handle and the «Pause motion» that goes with it. */
export interface Figure {
  lost: boolean;
  onLost: () => void;
  hub: PetHub;
  motion: ReactNode;
}

export function WardrobePage({
  pet,
  w,
  figure,
  accent,
  account,
  banner,
  bannerLine,
  offline,
  covered,
  layer,
}: {
  pet: OwnerView;
  w: WardrobeState;
  figure: Figure;
  accent: Accent;
  /** «Account», the header's end; the page draws none of its own after the session ended */
  account: ReactNode;
  /** the connection line over the last known wardrobe (`Connection rule`) and what the page's live region says of it */
  banner: ReactNode;
  bannerLine: string;
  /** the Connection rule's words of this pet, for a sign-in that could not read the gate */
  offline: string;
  /** Feed sheet or another sheet is over the page on this viewport: the page is out of reach */
  covered: boolean;
  /** Feed sheet and what stands over the page with it */
  layer: ReactNode;
}) {
  const { tokenId, name } = pet;
  const auth = useAuth();
  const lines = useSignInLines({ unreachable: offline });
  const [lead, ...more] = lines;
  const signedOut = auth.sessionLine;
  useKeepTileFocus();
  const leadText = lead?.text === SESSION_LINE ? signedOutLine(name) : lead?.text;
  const seenAsleep = pet.fullness.state === 'asleep';
  const draw = wardrobeView({
    name,
    status: w.load.kind,
    asleep: seenAsleep,
    pet: { outfits: pet.outfits, worn: pet.worn, outfitPrice: pet.outfitPrice },
    view: w.view,
    failed: w.failed,
    tapped: w.tapped,
  });
  // The pet woke with the screen open: the food is read at once, so «short» does not stand for a poll over a pet that has food enough
  // (`Wardrobe screen` › «проснулся при открытом экране»).
  const waking = useWaking(seenAsleep, w.read);
  const state = waking ? 'waking' : pet.fullness.state;

  // The failed line goes with its tile (the item turned out to be the pet's) or when Buy turns off: the view draws no note then, and
  // the tab forgets it, so it does not come back when Buy turns on again.
  const { failed, dropFailed } = w;
  const noteDrawn = draw.failedNote !== null;
  const tilesDrawn = draw.tiles !== null;
  useEffect(() => {
    if (failed !== null && tilesDrawn && !noteDrawn) dropFailed();
  }, [failed, tilesDrawn, noteDrawn, dropFailed]);

  // After a purchase landed, the page goes up to the pet and the focus moves to the line under it (DS › ItemGrid › After an outcome);
  // the page's live region does not say it again.
  const boughtName = nameOf(w.bought);
  useEffect(() => {
    if (boughtName === undefined) return;
    window.scrollTo(0, 0);
    document.getElementById(BOUGHT_ID)?.focus({ preventScroll: true });
  }, [boughtName, w.bought]);

  // A tap that met the ended session: the page goes to the column's top and the focus moves to «Sign in» (DS › ItemGrid › After an
  // outcome). A sheet over the page comes first: the tap in it closes it.
  const topHead = useRef<HTMLDivElement>(null);
  const outOfSession = signedOut && !covered;
  // every tap that meets the ended session takes the page up again, the first or a later one
  const [refused, setRefused] = useState(0);
  useEffect(() => {
    if (!outOfSession) return;
    window.scrollTo(0, 0);
    topHead.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [outOfSession, refused]);

  // Every control that needs a session asks first: with the session ended it shows the line and sends nothing (`Wardrobe screen` › «signed-out»).
  const tap = (t: TileDraw) => {
    if (!auth.needSession()) {
      setRefused((n) => n + 1);
      return;
    }
    if (t.does === 'wear') void w.wear(t.slug, t.slug);
    else if (t.does === 'takeoff') void w.wear(t.slug, null);
    else if (t.does === 'buy') void w.buy(t.slug);
  };

  const tile = (t: TileDraw) => (
    <ItemTile
      key={t.slug}
      picture={t.picture}
      name={t.name}
      worn={t.worn}
      condition={t.condition}
      action={t.action}
      price={t.price}
      off={t.off}
      disabled={t.disabled}
      pending={t.pending}
      pendingLabel={t.pending ? 'Buying…' : undefined}
      busy={w.wearing === t.slug}
      why={t.why}
      onClick={() => tap(t)}
    />
  );

  let top: ReactNode = null;
  if (signedOut) {
    top = (
      <div ref={topHead}>
        <Stack gap={3}>
          <Note tone="plain" silent>
            {leadText}
          </Note>
          {lead?.action ? <Button onClick={lead.action.onClick}>{lead.action.label}</Button> : null}
          <SignInLines lines={more} />
        </Stack>
      </div>
    );
  } else if (draw.top) {
    const { tone, text, action, id } = draw.top;
    top = (
      <Stack gap={3}>
        <Note tone={tone} id={id} silent={tone === 'status' || tone === 'plain'}>
          {text}
        </Note>
        {action === 'try-again' ? (
          <Button
            variant="secondary"
            onClick={() => {
              if (!auth.needSession()) setRefused((n) => n + 1);
              else w.retryRead();
            }}
          >
            Try again
          </Button>
        ) : action === 'back' ? (
          <Button variant="secondary" href={petPath(tokenId)}>
            {`Back to ${name}`}
          </Button>
        ) : null}
      </Stack>
    );
  }

  let list: ReactNode = null;
  if (draw.tiles) {
    const { mine, notYet, toBuy } = draw.tiles;
    if (draw.buyLine) {
      // the food line stands just above the Buy items: the list breaks there, and the off Buy buttons are described by it
      list = (
        <Stack gap={4}>
          <ItemGrid>
            {mine.map(tile)}
            {notYet.map(tile)}
          </ItemGrid>
          <Note id={draw.buyLine.id}>{draw.buyLine.text}</Note>
          <ItemGrid>{toBuy.map(tile)}</ItemGrid>
        </Stack>
      );
    } else {
      list = (
        <ItemGrid dense={draw.failedNote !== null}>
          {mine.map(tile)}
          {notYet.map(tile)}
          {toBuy.flatMap((t) =>
            draw.failedNote !== null && t.why === LINE.failed
              ? [
                  tile(t),
                  <ItemNote key="failed" id={draw.failedNote.id}>
                    <Note tone="error">{draw.failedNote.text}</Note>
                  </ItemNote>,
                ]
              : [tile(t)],
          )}
        </ItemGrid>
      );
    }
  }

  // what the page's live region says: a line that comes is written into a region that is there
  const live = signedOut
    ? [leadText ?? '', ...more.map((l) => l.text)].join(' ')
    : w.load.kind === 'loading'
      ? loadingLine(name)
      : bannerLine !== ''
        ? bannerLine
        : seenAsleep && draw.top !== null
          ? asleepLine(name)
          : draw.listLines.some((l) => l.id === LINE.paused)
            ? pausedLine(name)
            : draw.buyLine
              ? draw.buyLine.text
              : draw.buying !== null
                ? BUYING_LINE
                : '';

  const header = (
    <Header
      start={
        <Button variant="ghost" size="compact" icon="back" href={petPath(tokenId)}>
          {`Back to ${name}`}
        </Button>
      }
      end={signedOut ? null : account}
    />
  );

  return (
    <Shell accent={accent} header={<Inert on={covered ? 'phone' : undefined}>{header}</Inert>}>
      <Inert on={covered ? 'phone' : undefined}>
        <Page>
          <Heading level={1} hidden>
            {`${name}'s wardrobe`}
          </Heading>
          {banner}
          <Split
            ratio="start"
            start={
              <PetStage
                pet={
                  <PetFigure
                    tokenId={tokenId}
                    name={name}
                    state={state}
                    stage={pet.stage}
                    mood={seenAsleep ? null : pet.mood}
                    size="hero"
                    lost={figure.lost}
                    onLost={figure.onLost}
                    hub={figure.hub}
                    {...wearProps(draw.worn)}
                  />
                }
                motion={figure.motion}
                foot={
                  boughtName !== undefined ? (
                    <Text align="center" id={BOUGHT_ID} tabIndex={-1}>
                      {wearingLine(name, boughtName)}
                    </Text>
                  ) : null
                }
              />
            }
            end={
              <Stack gap={5}>
                {top}
                {draw.listLines.map((l) => (
                  <Text key={l.id} id={l.id}>
                    {l.text}
                  </Text>
                ))}
                {list}
              </Stack>
            }
          />
          <Live alert={signedOut}>{live}</Live>
        </Page>
      </Inert>
      {layer}
    </Shell>
  );
}
