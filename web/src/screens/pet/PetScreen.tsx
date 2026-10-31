import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Banner,
  Button,
  Center,
  Centerpiece,
  Composer,
  Conversation,
  Dock,
  Header,
  Heading,
  Inert,
  Live,
  Message,
  MotionToggle,
  Note,
  Only,
  Page,
  PetPlate,
  PetStage,
  Rail,
  RailItem,
  Shell,
  Skeleton,
  Split,
  Stack,
  Text,
  TextLink,
  Thinking,
  Toast,
  type Accent,
} from '../../ds';
import { closeFeed, useAddNearRequest, useFeedRequest } from '../../feeding/feedRequest';
import { FeedLayer } from '../../feeding/FeedLayer';
import { useFeedLinkOpened } from '../../feeding/useFeedLinkOpened';
import { formatCents } from '../../lib/price';
import { resetTime } from '../../lib/time';
import { hatchPath } from '../../route';
import { canUseWebGL } from '../../pet/flat';
import { makePet } from '../../pet/proto/generator.js';
import { useMotionPaused } from '../../pet/motion';
import { useBirth } from '../../pet/newborn';
import { PetFigure } from '../../pet/PetFigure';
import { MS, talkMs } from '../../pet/proto/motion.js';
import { usePetMotion } from '../../pet/proto/useMotion.js';
import { useAuth } from '../../seams/auth';
import { toastHeld, type PetView } from '../../seams/worker';
import { SignInLines, SignInOutcome, useSignInLines } from '../../signin/SignInOutcome';
import { useSignIn } from '../../signin/signIn';
import { hasSlot, runAction, Slot, type ActionName, type Viewer } from './parts';
import { usePetScreen, type Banner as BannerKind, type OwnerView } from './usePetScreen';
import { useWaking } from './useWaking';

// Pet screen (add-pet › Pet screen, Connection rule) built from design/bundle/screens/pet.js: the owner's page is two
// columns — the pet with its rail and plate at the left, the conversation with the input pinned at its bottom at the
// right; a guest or a visitor gets one centred column. The parts of other changes (energy, stage and traits, the
// hiring mode, the guest's advice, Account) are slots of `parts.ts`: drawn where the frames have them once their
// change registers them. The words are the Scenarios' and the frames' `copy`, verbatim.
const UNREACHABLE = "We can't reach the game right now. Try again in a moment.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';
const offlineLine = (name: string) => `Can't reach ${name} right now. Nothing's lost — try again in a moment.`;
const WAIT_LINE = 'Still working on it — long answers can take a minute or two.';
const lostLine = (name: string) => `${name} lost that thought. Nothing was spent — try again.`;
const emptyPaidLine = (name: string) => `${name} lost that thought, but it still used a little food. Your message is kept — try again.`;
const pausedLine = (name: string) => `Chatting is paused on our side while we top up. Your message is kept — ${name} will be back soon.`;
const NOT_FOUND = "We couldn't find this pet. The link may be broken.";
const FINDING = 'Finding this pet…';

/** The pet's light: the hue of its seed — the accent of the page. */
function accentOf(tokenId: string): Accent {
  return makePet(tokenId).hue as Accent;
}

/** Feed sheet over this page: `open` — it is (the page under it goes out of reach); `opener` — it was opened from this page's own
 *  «Feed {name}», which shows it expanded (not the own pet's sheet over a friend's page, whose opener is not here). */
function useFeedCover(tokenId: string): { open: boolean; opener: boolean } {
  const request = useFeedRequest();
  // the Add NEAR sheet another surface opened covers the page the same way
  const addNear = useAddNearRequest();
  return { open: request !== null || addNear !== null, opener: request !== null && !request.elsewhere && request.tokenId === tokenId };
}

function useFigure() {
  const [lost, setLost] = useState(false);
  const [paused, toggle] = useMotionPaused();
  const hub = usePetMotion();
  const flat = lost || !canUseWebGL();
  // the flat drawing doesn't move, so it has no «Pause motion»; the stage is rebuilt around the figure when it
  // goes, so the screen keeps the lost context for it
  return { lost, onLost: () => setLost(true), hub, motion: flat ? null : <MotionToggle paused={paused} onToggle={toggle} /> };
}

function CheckLink({ tokenId, name }: { tokenId: string; name: string }) {
  return (
    <TextLink href={`/pet/${tokenId}/verify`} tone="trust" icon="verify">
      {`Check it's really ${name}`}
    </TextLink>
  );
}

function Account({ tokenId, name, viewer, asleep }: { tokenId: string; name: string; viewer: Viewer; asleep: boolean }) {
  return <Slot slot="account" tokenId={tokenId} name={name} viewer={viewer} asleep={asleep} />;
}

function Gone({ children }: { children: ReactNode }) {
  return (
    <Shell fill>
      <Page fill width="narrow">
        <Center>{children}</Center>
      </Page>
    </Shell>
  );
}

/** The dead link: a pet the network does not know, or an address that can't be one. */
export function PetNotFound() {
  return (
    <Gone>
      <Heading level={1} variant="title-2" align="center">
        {NOT_FOUND}
      </Heading>
      <Button href="/">Go home</Button>
    </Gone>
  );
}

function LoadingView({ tokenId }: { tokenId: string }) {
  return (
    <Shell fill header={<Header end={<Account tokenId={tokenId} name="" viewer="visitor" asleep={false} />} />}>
      <Page fill>
        <Split
          fill
          ratio="start"
          start={
            <Stack gap={4} align="center">
              <Skeleton shape="pet" />
              <Skeleton shape="name" />
              {/* said by the screen's own live region, which outlives this view */}
              <Note tone="status" silent>
                {FINDING}
              </Note>
            </Stack>
          }
          end={
            <Stack gap={0} grow>
              <Stack grow>{null}</Stack>
              <Dock>
                <Composer disabled label={FINDING} />
              </Dock>
            </Stack>
          }
        />
      </Page>
    </Shell>
  );
}

function bannerLine(banner: BannerKind, name: string): string {
  return banner === 'offline' ? offlineLine(name) : banner === 'busy' ? BUSY : '';
}

function ConnectionBanner({ banner, name, tryAgain }: { banner: BannerKind; name: string; tryAgain: () => void }) {
  if (!banner) return null;
  return (
    <Banner
      action={
        banner === 'busy' ? (
          <Button variant="secondary" size="compact" onClick={tryAgain}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {bannerLine(banner, name)}
    </Banner>
  );
}

function OwnerPage({ pet, s }: { pet: OwnerView; s: ReturnType<typeof usePetScreen> }) {
  const { tokenId, name } = pet;
  const auth = useAuth();
  // the ended session's line, or what a tap on its «Sign in» came to: the first stands in the field's note and its action in
  // «Send»'s place, a second (the phone's way to a real browser) under the Composer
  const signInLines = useSignInLines({ unreachable: offlineLine(name), text: s.draft });
  const [lead, ...moreLines] = signInLines;
  const figure = useFigure();
  const asleep = pet.fullness.state === 'asleep';
  const hungry = pet.fullness.state === 'hungry';
  const hello = pet.hello && !s.spoke;
  const slot = { tokenId, name, viewer: 'owner' as const, asleep };
  const ctx = { tokenId, name, viewer: 'owner' as const };
  const birth = useBirth(tokenId);
  const { hub } = figure;
  const cover = useFeedCover(tokenId);

  // The pet fell asleep while this page was open: the field goes off and keeps the focus, the Live says the sleep line, Tab
  // reaches «Feed {name}» (DS › Composer › Keyboard: no line inside the Composer takes the focus); it woke: the focus comes
  // back to the field, unless the player has gone somewhere else, and the pet boots — on pause and under reduced motion too,
  // as cuts: the log's three rows, then the next state (DS › Pet › Waking). Opened asleep, nothing is moved.
  const waking = useWaking(asleep, () => {
    if (document.activeElement === document.body) document.querySelector<HTMLTextAreaElement>('.ds-composer__field')?.focus();
  });

  // A reply landed: the pet says it, once its eyes have opened (`Conversation flow` › «Ответ»).
  const newest = (s.lines ?? []).filter((l) => l.who === 'pet').at(-1);
  const said = newest?.fresh ? newest : null;
  useEffect(() => {
    if (!said) return undefined;
    const timer = setTimeout(() => hub.fire('talk', { ms: talkMs([...said.text].length) }), MS.medium);
    return () => clearTimeout(timer);
  }, [said?.id, hub]);

  // Every control that needs a session asks first: with the session ended it shows the line and does nothing else
  // (`Session expiry flow` › «сессия кончилась при открытом экране»).
  const act = (name: ActionName) => {
    if (auth.needSession()) runAction(name, ctx);
  };
  const feedButton = (compact: boolean, variant?: 'secondary') => (
    <Button variant={variant} size={compact ? 'compact' : undefined} icon="feed" role="food" haspopup="dialog" expanded={cover.opener || undefined} onClick={() => act('feed')}>
      {`Feed ${name}`}
    </Button>
  );

  // The newest thing the pet said is in its lead voice — while nothing is on its way, nothing failed, and only the
  // note of a reply that stopped at its limit follows it.
  const all = s.lines ?? [];
  const lastPet = all.reduce((at, l, i) => (l.who === 'pet' ? i : at), -1);
  const settled = !s.busy && s.failure === null;
  const history = all.map((line, i) =>
    line.who === 'event' ? (
      <Message key={line.id} from="event" fresh={line.fresh}>
        {line.text}
      </Message>
    ) : line.who === 'player' ? (
      <Message key={line.id} from="player" speaker="You" fresh={line.fresh}>
        {line.text}
      </Message>
    ) : (
      <Message
        key={line.id}
        from="pet"
        speaker={name}
        fresh={line.fresh}
        latest={settled && i === lastPet && all.slice(i + 1).every((l) => l.cutNote)}
        verify={{ href: `/pet/${tokenId}/verify/${line.id}`, label: 'Check this thought' }}
        meta={line.meta}
      >
        {line.text}
      </Message>
    ),
  );

  const card = (
    <Stack gap={3}>
      <Slot slot="growth" {...slot} />
      <CheckLink tokenId={tokenId} name={name} />
      {asleep ? null : <Slot slot="hiring" {...slot} />}
    </Stack>
  );

  // What turns the field off, and the line that says why (`Pet screen` › «asleep (владелец)», `Daily cap rule` ›
  // «Устал», `Connection rule` › «разговор на паузе»); «Think hard» is also off while the pet is too hungry for it
  // (`Pet condition rule` › «Голоден»), and chatting works then.
  const tired = !asleep && pet.tired;
  const paused = !asleep && !tired && pet.paused;
  // a tap found the session ended: the field is off with its text, the line is the field's note and «Sign in» (or the «Try
  // again» of what became of it) stands in «Send»'s place (frame `session-expired`)
  const signedOut = auth.sessionLine;
  const off = asleep || tired || paused || signedOut;
  const tiredLine = `${name} is tired for today. Back at ${resetTime(pet.until)}.`;
  const hungryLine = `${name} is too hungry to think hard right now.`;
  const sleepLine = `${name} is asleep. A meal will wake ${name} up.`;
  const note = asleep ? null : tired ? tiredLine : hungry ? hungryLine : null;
  // the Dock's region says what the field's note says, the asleep line included; the ended session has its own region
  const live = signedOut ? '' : bannerLine(s.banner, name) || (paused ? pausedLine(name) : '') || (asleep ? sleepLine : '') || note || '';

  const state = waking ? 'waking' : s.busy ? 'thinking' : pet.fullness.state;
  const field = (
    <Stack gap={3}>
      <Composer
        placeholder={`${hello ? 'Say hi to ' : 'Talk to '}${name}…`}
        autoFocus={!off && !cover.open}
        value={s.draft}
        onChange={s.setDraft}
        onSend={(text) => void s.send(text)}
        disabled={off}
        note={signedOut ? <Note>{lead?.text}</Note> : asleep ? <Note>{sleepLine}</Note> : note ? <Note>{note}</Note> : null}
        start={
          <Button
            variant="secondary"
            size="compact"
            icon="bolt"
            role="mind"
            price={`≈ ${formatCents(pet.deepPrice.cents)}`}
            off={(off && !signedOut) || hungry}
            busy={s.busy}
            onClick={() => void s.send(s.draft, 'deep')}
          >
            Think hard
          </Button>
        }
        end={
          signedOut ? (
            lead?.action ? (
              <Button size="compact" onClick={lead.action.onClick}>
                {lead.action.label}
              </Button>
            ) : null
          ) : asleep ? (
            <Button key="feed" size="compact" icon="feed" haspopup="dialog" expanded={cover.opener || undefined} onClick={() => act('feed')}>
              {`Feed ${name}`}
            </Button>
          ) : (
            <Button key="send" size="compact" iconEnd="send" type="submit" off={off} busy={s.busy} onClick={() => void s.send(s.draft)}>
              Send
            </Button>
          )
        }
      />
      {signedOut ? <SignInLines lines={moreLines} /> : null}
      {asleep ? null : (
        <Only on="desktop">
          <Slot slot="hiring" {...slot} />
        </Only>
      )}
    </Stack>
  );

  // «Back to {friend_pet}» takes the place of «My pets» on the newborn that came from a friend's pet (frame
  // `pet-newborn-from-friend`); both are the header's start control
  const header = (
    <Header
      start={
        s.friend ? (
          <Button variant="ghost" size="compact" icon="back" href={`/pet/${s.friend.tokenId}`}>
            {`Back to ${s.friend.name}`}
          </Button>
        ) : pet.ownedCount >= 2 ? (
          <Button variant="ghost" size="compact" icon="pets" haspopup="dialog" onClick={() => act('myPets')}>
            My pets
          </Button>
        ) : null
      }
      end={<Account {...slot} />}
    />
  );

  // With Feed sheet open the phone's bottom sheet is modal: the header and the pet are out of reach (on the desktop the page stays
  // live beside the panel); the conversation and its field are covered on both, the sheet takes the column they stand in.
  return (
    <Shell accent={accentOf(tokenId)} fill header={<Inert on={cover.open ? 'phone' : undefined}>{header}</Inert>}>
      <Page fill>
        <ConnectionBanner banner={s.banner} name={name} tryAgain={s.tryAgain} />
        {paused && !s.banner ? <Banner tone="info">{pausedLine(name)}</Banner> : null}
        <Split
          fill
          ratio="start"
          start={
            <Inert on={cover.open ? 'phone' : undefined}>
              <PetStage
                compact
                pet={<PetFigure tokenId={tokenId} name={name} state={state} stage={pet.stage} size="hero" lost={figure.lost} onLost={figure.onLost} hub={hub} birth={birth} />}
                motion={figure.motion}
                rail={
                  asleep ? null : (
                    <Rail>
                      <RailItem icon="today" label="Today" href={`/pet/${tokenId}/diary`} role="food" />
                      <RailItem icon="hanger" label="Wardrobe" href={`/pet/${tokenId}/wardrobe`} />
                      <RailItem icon="gift" label={`Give ${name} away`} haspopup="dialog" onClick={() => act('gift')} />
                    </Rail>
                  )
                }
                plate={
                  <PetPlate
                    name={name}
                    compact={hasSlot('energy')}
                    fullness={{ state: pet.fullness.state, level: hungry ? pet.fullness.level : undefined }}
                    action={asleep ? null : feedButton(true, 'secondary')}
                  >
                    <Only on="desktop">
                      <Slot slot="growth" {...slot} />
                    </Only>
                    <Slot slot="energy" {...slot} />
                  </PetPlate>
                }
                foot={<CheckLink tokenId={tokenId} name={name} />}
              />
            </Inert>
          }
          end={
            <Stack gap={0} grow>
              <Inert on={cover.open}>
                <Conversation intro={card} introOn="phone">
                  {history}
                  {s.failure ? (
                    <Message
                      key="failure"
                      from="error"
                      actions={
                        <Button variant="secondary" size="compact" onClick={s.retryThought}>
                          Try again
                        </Button>
                      }
                    >
                      {s.failure.code === 'empty_paid' ? emptyPaidLine(name) : lostLine(name)}
                    </Message>
                  ) : null}
                  {s.busy ? (
                    <Thinking key="thinking" wait={s.waiting ? WAIT_LINE : undefined}>
                      {`${name} is thinking${s.jobMode === 'deep' ? ' hard' : ''}…`}
                    </Thinking>
                  ) : null}
                </Conversation>
                <Dock>
                  {field}
                  <Live>{live}</Live>
                  <Live alert>{signedOut ? signInLines.map((l) => l.text).join(' ') : ''}</Live>
                </Dock>
              </Inert>
              <FeedLayer column pageFullness={pet.fullness} />
            </Stack>
          }
        />
      </Page>
    </Shell>
  );
}

/** A signed-in player who isn't the owner, or a visitor with no session: one centred column — the pet, its plate,
 *  «Check it's really {name}», the asleep line, then «Feed {name}» and what the viewer can do next. */
function OutsiderPage({ pet, s }: { pet: Exclude<PetView, { viewer: 'owner' }>; s: ReturnType<typeof usePetScreen> }) {
  const { tokenId, name } = pet;
  const figure = useFigure();
  const { begin } = useSignIn();
  const auth = useAuth();
  const viewer: Viewer = pet.viewer;
  const asleep = pet.fullness.state === 'asleep';
  const ctx = { tokenId, name, viewer };
  const slot = { tokenId, name, viewer, asleep };
  const me = s.me;
  const home = me?.currentPet ?? null;
  // a guest who never hatched is offered a pet of their own
  const fresh = viewer === 'guest' && me !== null && me.hatched === null;
  // a guest with a pet of their own would have the advice column (add-pet-work); without it the page stands as the visitor's
  const header =
    viewer === 'visitor' ? null : (
      <Header
        start={
          home ? (
            <Button variant="ghost" size="compact" icon="back" href={`/pet/${home.tokenId}`}>
              {`Go to your ${home.name}`}
            </Button>
          ) : null
        }
        end={<Account {...slot} />}
      />
    );
  const cover = useFeedCover(tokenId);
  const feed = (
    <Button block icon="feed" haspopup="dialog" expanded={cover.opener || undefined} onClick={() => (viewer === 'visitor' ? begin('feed') : auth.needSession() && runAction('feed', ctx))}>
      {`Feed ${name}`}
    </Button>
  );
  // a friend's meal wakes the pet on this screen too: the boot, as on the owner's page
  const waking = useWaking(asleep);
  const state = waking ? 'waking' : pet.fullness.state;
  const covered = cover.open ? 'phone' : undefined;
  return (
    <Shell accent={accentOf(tokenId)} fill header={<Inert on={covered}>{header}</Inert>}>
      <Inert on={covered}>
        <Page fill width="narrow">
          <Centerpiece
            status=""
            actions={
              <Stack gap={2}>
                {asleep ? <Text align="center">{`${name} is asleep — food from you would wake ${name} up.`}</Text> : null}
                {feed}
                {viewer === 'visitor' ? (
                  <Button block variant="secondary" onClick={() => begin('signin')}>
                    Sign in
                  </Button>
                ) : null}
                {fresh ? (
                  <Button block variant="secondary" href={hatchPath(tokenId)}>
                    Get your own pet
                  </Button>
                ) : null}
                {/* the outcome of a sign-in, and a guest's line of an ended session, under the action */}
                <SignInOutcome unreachable={offlineLine(name)} />
              </Stack>
            }
          >
            <PetStage
              pet={<PetFigure tokenId={tokenId} name={name} state={state} stage={pet.stage} size="hero" lost={figure.lost} onLost={figure.onLost} hub={figure.hub} />}
              motion={figure.motion}
              plate={<PetPlate name={name} fullness={{ state: pet.fullness.state, level: pet.fullness.state === 'hungry' ? pet.fullness.level : undefined }} />}
              foot={<CheckLink tokenId={tokenId} name={name} />}
            />
          </Centerpiece>
        </Page>
      </Inert>
      <FeedLayer pageFullness={pet.fullness} />
      {/* the pet was given away under a clear: the Toast is silent, the screen's own Live says its words */}
      {s.notice ? (
        <Toast icon="check" silent onDone={toastHeld() ? undefined : s.clearNotice}>
          {s.notice}
        </Toast>
      ) : null}
    </Shell>
  );
}

/** What the page itself came to: one live region that stays through the views, so the outcome of «Finding this pet…» is
 *  heard (the views have their own regions once a pet is there). */
function outcomeLine(page: ReturnType<typeof usePetScreen>['page'], notice: string | null): string {
  if (notice) return notice;
  if (page.kind === 'loading') return FINDING;
  if (page.kind === 'not_found') return NOT_FOUND;
  if (page.kind === 'unreachable') return page.busy ? BUSY : UNREACHABLE;
  return '';
}

function PetView({ s }: { s: ReturnType<typeof usePetScreen> }) {
  const { page } = s;
  if (page.kind === 'loading') return <LoadingView tokenId={s.tokenId} />;
  if (page.kind === 'not_found') return <PetNotFound />;
  if (page.kind === 'unreachable') {
    return (
      <Gone>
        <Heading level={1} variant="title-2" align="center">
          {page.busy ? BUSY : UNREACHABLE}
        </Heading>
        <Button onClick={s.tryAgain}>Try again</Button>
      </Gone>
    );
  }
  return page.pet.viewer === 'owner' ? <OwnerPage pet={page.pet} s={s} /> : <OutsiderPage pet={page.pet} s={s} />;
}

export function PetScreen({ tokenId, from }: { tokenId: string; from: string | null }) {
  const s = usePetScreen(tokenId, from);
  useFeedLinkOpened();
  // The sheet is the tab's memory of this screen: it goes with the screen, and a sheet for another pet than this page's (not the
  // own pet's «Feed your {my_pet}») does not follow the player to it.
  const request = useFeedRequest();
  useEffect(() => {
    if (request !== null && !request.elsewhere && request.tokenId !== tokenId) closeFeed();
  }, [request, tokenId]);
  useEffect(() => closeFeed, []);
  return (
    <>
      <Live>{outcomeLine(s.page, s.notice)}</Live>
      <PetView s={s} />
    </>
  );
}
