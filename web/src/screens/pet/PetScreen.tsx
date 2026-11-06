import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSeal, type SealState } from '../../verification/seal';
import { AccountControl } from '../../account/AccountControl';
import {
  Away,
  Banner,
  Button,
  Center,
  Centerpiece,
  Cluster,
  Composer,
  Conversation,
  Dock,
  Header,
  Heading,
  IconButton,
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
  SkillBadge,
  Split,
  Stack,
  Text,
  TextLink,
  Thinking,
  Toast,
  type Accent,
} from '../../ds';
import { DiaryPage } from '../../diary/DiaryPage';
import { useDiary } from '../../diary/useDiary';
import { useSelfOpen } from '../../diary/useSelfOpen';
import { wearProps } from '../../wardrobe/catalogue';
import { NewOutfitNotice } from '../../wardrobe/NewOutfitNotice';
import { useNotice } from '../../wardrobe/useNotice';
import { useWardrobe } from '../../wardrobe/useWardrobe';
import { WardrobePage } from '../../wardrobe/WardrobePage';
import { ErrandSheet } from '../../errands/ErrandSheet';
import { OldReserveNotice } from '../../errands/OldReserveNotice';
import { FORM_WORD, sentLine } from '../../errands/lines';
import { ReportMessage } from '../../errands/reportLines';
import { useErrand } from '../../errands/useErrand';
import { WatchSheet } from '../../watch/WatchSheet';
import { VerdictCard } from '../../errands/VerdictCard';
import { closeVerdict, useVerdictRequest } from '../../errands/verdictRequest';
import { closeFeed, feedOpenNow, openFeed, useAddNearRequest, useFeedRequest } from '../../feeding/feedRequest';
import { FeedLayer } from '../../feeding/FeedLayer';
import { useFeedLinkOpened } from '../../feeding/useFeedLinkOpened';
import '../../gift/giftRequest';
import { GiftSheet } from '../../gift/GiftSheet';
import { MyPetsSheet, useMyPetsOpen, closeMyPets } from '../../gift/MyPetsSheet';
import { closeGift, useGiftRequest } from '../../gift/giftRequest';
import { energyLine } from '../../life/lines';
import { OfferMessage, OwnLostMessage, WorkerMessage } from '../../work/hireLines';
import { askingLine, offerLine, offerRoseLine, skillSavedLine } from '../../work/lines';
import { SkillSheet } from '../../work/SkillSheet';
import { useSkill } from '../../work/useSkill';
import { AdapterSheet } from '../../adapters/AdapterSheet';
import { takeSkillArrival } from '../../adapters/arrival';
import { CodeSheet } from '../../adapters/CodeSheet';
import { codeRemovedLine, codeSavedLine, connectedLine, removedLine } from '../../adapters/lines';
import { useCode } from '../../adapters/useCode';
import { useAdapter } from '../../adapters/useAdapter';
import { formatCents } from '../../lib/price';
import { resetTime } from '../../lib/time';
import { hatchPath, navigate, petPath, useLocation } from '../../route';
import { canUseWebGL } from '../../pet/flat';
import { makePet } from '../../pet/proto/generator.js';
import { useMotionPaused } from '../../pet/motion';
import { useBirth } from '../../pet/newborn';
import { PetFigure } from '../../pet/PetFigure';
import { MS, talkMs } from '../../pet/proto/motion.js';
import { usePetMotion } from '../../pet/proto/useMotion.js';
import { useAuth } from '../../seams/auth';
import { toastHeld, type ErrandForm, type PetView } from '../../seams/worker';
import { SignInLines, SignInOutcome, useSignInLines } from '../../signin/SignInOutcome';
import { useSignIn } from '../../signin/signIn';
import { emptyPaidLine, lostLine, offlineLine, pausedLine, WAIT_LINE } from './lines';
import { hasSlot, peekPendingAction, runAction, Slot, takePendingAction, type ActionName, type Viewer } from './parts';
import { takeReturnSheet, takeReturnSkill } from '../../signin/returnPlace';
import { usePetScreen, type Banner as BannerKind, type OwnerView } from './usePetScreen';
import { useWaking } from './useWaking';
import { usePetCard } from '../../showcase/usePetCard';

// Pet screen (add-pet › Pet screen, Connection rule) built from design/bundle/screens/pet.js: the owner's page is two
// columns — the pet with its rail and plate at the left, the conversation with the input pinned at its bottom at the
// right; a guest or a visitor gets one centred column. The parts of other changes (energy, stage and traits, the
// hiring mode, the guest's advice, Account) are slots of `parts.ts`: drawn where the frames have them once their
// change registers them. The words are the Scenarios' and the frames' `copy`, verbatim.
const UNREACHABLE = "We can't reach the game right now. Try again in a moment.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';
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
  // goes, so the screen keeps the lost context for it. `toggle` — what moves without the figure (the errand's walker) has one.
  const toggleNode = <MotionToggle paused={paused} onToggle={toggle} />;
  return { lost, paused, onLost: () => setLost(true), hub, motion: flat ? null : toggleNode, toggle: toggleNode };
}

function sealLine(name: string, state: SealState): string {
  return state.kind === 'mismatch' ? `${name}'s character no longer matches the hatch record.`
    : state.kind === 'unavailable' ? `We can't check ${name}'s character on NEAR just now. Try again.`
      : state.kind === 'checked' ? `This mark identifies ${name}'s character hash checked on NEAR. The contract can be upgraded later.` : '';
}

/** `start`: the phone owner's intro card, where the line is left-aligned and a mismatch or an unreadable seal is said by the
 *  banner above the page instead (the frames' `checkLink(pet, true)`). */
function CheckLink({ tokenId, name, seal, start, watching }: { tokenId: string; name: string; seal: ReturnType<typeof useSeal>; start?: boolean; watching?: string | null }) {
  const align = start ? undefined : 'center';
  return (
    <Stack gap={1} align={align}>
      {watching ? <Text variant="small" tone="secondary" align={align}>{`Watching: ${watching}`}</Text> : null}
      <TextLink href={`/pet/${tokenId}/verify`} tone="trust" icon="verify">{`Check it's really ${name}`}</TextLink>
      {seal.state.kind === 'checked' ? <Text variant="small" tone="secondary" align={align}>{sealLine(name, seal.state)}</Text> : null}
      {seal.state.kind === 'mismatch' && !start ? <Note tone="error" silent>{sealLine(name, seal.state)}</Note> : null}
      {seal.state.kind === 'unavailable' && !start ? <Cluster gap={3}><Note tone="error" silent>{sealLine(name, seal.state)}</Note><Button variant="secondary" size="compact" onClick={seal.retry}>Try again</Button></Cluster> : null}
    </Stack>
  );
}

function SealBanner({ name, seal }: { name: string; seal: ReturnType<typeof useSeal> }) {
  if (seal.state.kind !== 'mismatch' && seal.state.kind !== 'unavailable') return null;
  return <Only on="phone"><Banner action={seal.state.kind === 'unavailable' ? <Button variant="secondary" size="compact" onClick={seal.retry}>Try again</Button> : undefined}>
    {sealLine(name, seal.state)}
  </Banner></Only>;
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
    <Shell fill header={<Header end={<AccountControl tokenId={tokenId} />} />}>
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

function OwnerPage({ pet, s, seal }: { pet: OwnerView; s: ReturnType<typeof usePetScreen>; seal: ReturnType<typeof useSeal> }) {
  const { tokenId, name } = pet;
  const auth = useAuth();
  // the ended session's line, or what a tap on its «Sign in» came to: the first stands in the field's note and its action in
  // «Send»'s place, a second (the phone's way to a real browser) under the Composer
  const signInLines = useSignInLines({ unreachable: offlineLine(name), text: s.draft });
  const [lead, ...moreLines] = signInLines;
  const figure = useFigure();
  const asleep = pet.fullness.state === 'asleep';
  const hungry = pet.fullness.state === 'hungry';
  const share = usePetCard(pet, s.lines ?? [], s.tokenOf, auth.authenticated && !auth.sessionEnded);
  const hello = pet.hello && !s.spoke;
  const slot = {
    tokenId,
    name,
    viewer: 'owner' as const,
    asleep,
    life: { stage: pet.stage, traits: pet.traits, energy: pet.energy },
    hiring: { mode: pet.hireMode, set: s.setHireMode },
  };
  const ctx = { tokenId, name, viewer: 'owner' as const };
  const birth = useBirth(tokenId);
  const { hub } = figure;
  const feedCover = useFeedCover(tokenId);
  const giftRequest = useGiftRequest();
  const giftOpen = giftRequest?.tokenId === tokenId;
  const myPetsOpen = useMyPetsOpen() === tokenId;
  const giftGiven = giftOpen && giftRequest?.given === true;
  const giftTyping = giftOpen && giftRequest?.self && s.draft !== '';
  useEffect(() => { if (!auth.authenticated || auth.sessionEnded) { closeGift(); closeMyPets(); } }, [auth.authenticated, auth.sessionEnded]);

  // Skill sheet (`Skill sheet screen`): the badge under the name opens it, over the conversation column like Feed sheet. The label
  // the badge shows is the poll's, until a save or a forget of this tab says otherwise.
  const [skillLabel, setSkillLabel] = useState<string | null | undefined>(undefined);
  const [skillSaved, setSkillSaved] = useState(false);
  useEffect(() => setSkillLabel(undefined), [pet.skill?.label]);
  const label = skillLabel !== undefined ? skillLabel : (pet.skill?.label ?? null);
  const skill = useSkill(tokenId, { tokenOf: s.tokenOf, refused: (e) => s.report(e, () => undefined) }, (next, saved) => {
    setSkillLabel(next);
    setSkillSaved(saved);
  });
  const skillShown = skill.phase === 'open' || skill.phase === 'error';
  // Adapter sheet (`Adapter sheet screen`): a step of Skill sheet, which keeps its fields and its place while the step stands. A source
  // saved or removed brings Skill sheet back with the line; on a pet that fell asleep meanwhile a saved one closes the sheet and the
  // page says the line in a toast (`Adapter connect flow` › «saved»).
  const [adapterLine, setAdapterLine] = useState<string | null>(null);
  const asleepNow = useRef(false);
  asleepNow.current = pet.fullness.state === 'asleep';
  const adapter = useAdapter(tokenId, {
    tokenOf: s.tokenOf,
    refused: (e) => {
      skill.close();
      s.report(e, () => undefined);
    },
    done: ({ kind, label: source }) => {
      if (kind === 'saved' && asleepNow.current) {
        skill.close();
        setAdapterLine(connectedLine(name, source));
        return;
      }
      void skill.refresh(kind === 'saved' ? connectedLine(name, source) : removedLine(name, source));
    },
    back: () => void skill.refresh(),
  });

  // Skill code sheet (`Skill code sheet screen`): the other step of Skill sheet, which keeps its fields and its place while it stands. Code
  // saved or removed brings Skill sheet back with the line (`Skill code flow` › «code saved», «code removed»).
  const code = useCode(tokenId, {
    tokenOf: s.tokenOf,
    refused: (e) => {
      skill.close();
      s.report(e, () => undefined);
    },
    done: ({ kind }) => void skill.refresh(kind === 'saved' ? codeSavedLine(name) : codeRemovedLine(name)),
  });

  // Errand sheet (`Errand sheet screen`): the rail's «Send {name} on an errand» opens it over the conversation column. Feed sheet
  // opens over it (its «Feed {name}»), and the form and the text stay.
  const errand = useErrand({
    tokenId,
    tokenOf: s.tokenOf,
    refused: (e) => s.report(e, () => undefined),
    failed: (e, retry) => s.report(e, retry),
    sent: s.errandSent,
    away: () => void s.look(),
    watch: `${pet.fullness.state}|${pet.energy}|${pet.tired}|${pet.paused}|${pet.until ?? ''}`,
  });
  const [watchOpen, setWatchOpen] = useState(false);
  const [watchDraft, setWatchDraft] = useState('');
  // the sheets cover the page the same way: the one that is open takes the column
  const cover = { ...feedCover, open: feedCover.open || skillShown || errand.open || watchOpen };
  const here = useLocation();
  useEffect(() => {
    if (peekPendingAction() !== 'watch') return;
    takePendingAction();
    setWatchDraft(takeReturnSheet('watch', here)?.target ?? '');
    setWatchOpen(true);
  }, []);
  const openWatch = () => {
    if (!auth.needSession()) return;
    closeFeed(); skill.close(); adapter.close(); code.close(); errand.close();
    setWatchOpen(true);
  };
  // Back from the sign-in of Errand sheet's ended-session line: the sheet opens again with the form and the text as typed
  useEffect(() => {
    if (peekPendingAction() !== 'errand') return;
    takePendingAction();
    errand.openSheet(takeReturnSheet('errand', here) ?? undefined);
    // once, when the owner's page is first drawn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // An errand that came back with a block (`Errand flow` › «blocked after Send»): the sheet opens with its form, its job and the block
  const reopen = s.reopen;
  useEffect(() => {
    if (!reopen) return;
    s.clearReopen();
    closeFeed();
    skill.close();
    adapter.close();
    code.close();
    errand.openSheet({ form: reopen.form, job: reopen.job });
    // the sheet opens once per block
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reopen]);
  // the sheet closed: an errand that came back with a block and is still kept stays in the conversation with «Try again»
  const errandWasOpen = useRef(false);
  useEffect(() => {
    if (errandWasOpen.current && !errand.open) s.errandSheetClosed();
    errandWasOpen.current = errand.open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errand.open]);
  const openErrand = () => {
    if (!auth.needSession()) return;
    closeFeed();
    skill.close();
    adapter.close();
    code.close();
    errand.openSheet(undefined, pet.fullness.state === 'asleep');
  };
  // Back from the sign-in of Adapter sheet's ended-session line: Skill sheet opens, and over it the sheet with the name and the typed
  // address (unchecked), or the connected source it was on
  useEffect(() => {
    if (peekPendingAction() !== 'adapter') return;
    takePendingAction();
    const typed = takeReturnSheet('adapter', here);
    void skill.open().then((answer) => {
      if (!typed || !answer) return;
      const connected = typed.sid ? answer.sources.find((x) => x.id === typed.sid) : undefined;
      if (connected) adapter.openSource(connected, { label: typed.label });
      else adapter.openNew({ label: typed.label, address: typed.address });
    });
    // once, when the owner's page is first drawn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Back from the sign-in of Skill code sheet's ended-session line: Skill sheet opens, and over it the code sheet with the code, the
  // function and the sample values as typed (no test outcome)
  useEffect(() => {
    if (peekPendingAction() !== 'code') return;
    takePendingAction();
    const typed = takeReturnSheet('code', here);
    void skill.open().then((answer) => {
      if (!answer || !typed) return;
      code.openSheet(typed);
    });
    // once, when the owner's page is first drawn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Back from the sign-in of Skill sheet's ended-session line: the sheet opens again with both fields as typed, unsaved
  useEffect(() => {
    if (peekPendingAction() !== 'skill') return;
    takePendingAction();
    void skill.open(takeReturnSkill(here) ?? undefined);
    // once, when the owner's page is first drawn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Led here from the catalog («Back to {name}», or a saved connect): Skill sheet opens, with the line a connect left. A pet that fell
  // asleep meanwhile has no Skill sheet; the line of a saved connect is said in a toast then (`Adapter catalog screen`).
  useEffect(() => {
    const arrival = takeSkillArrival(tokenId);
    if (!arrival) return;
    if (asleepNow.current) {
      if (arrival.line) setAdapterLine(arrival.line);
      return;
    }
    const line = arrival.line;
    void skill.open().then((answer) => {
      if (answer && line) skill.note(line);
    });
    // once, when the owner's page is first drawn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const openSkill = () => {
    if (!auth.needSession()) return;
    closeFeed();
    errand.close();
    adapter.close();
    code.close();
    void skill.open();
  };

  // The pet fell asleep while this page was open: the field goes off and keeps the focus, the Live says the sleep line, Tab
  // reaches «Feed {name}» (DS › Composer › Keyboard: no line inside the Composer takes the focus); it woke: the focus comes
  // back to the field, unless the player has gone somewhere else, and the pet boots — on pause and under reduced motion too,
  // as cuts: the log's three rows, then the next state (DS › Pet › Waking). Opened asleep, nothing is moved.
  // A wake that lands while a sheet covers the page (inert, it can't take the focus) is owed to the field: when the sheet has
  // closed, the focus it returned fell to the body — its opener, the Feed button, was replaced by the wake — and goes to the field.
  const focusOwed = useRef(false);
  const focusField = () => {
    if (document.activeElement === document.body) document.querySelector<HTMLTextAreaElement>('.ds-composer__field')?.focus();
  };
  const waking = useWaking(asleep, () => {
    if (cover.open) focusOwed.current = true;
    else focusField();
  });
  useEffect(() => {
    if (cover.open || !focusOwed.current) return;
    focusOwed.current = false;
    focusField();
  }, [cover.open]);

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
    if (!auth.needSession()) return;
    if (name === 'feed') { skill.close(); closeGift(); }
    if (name === 'gift' && feedOpenNow()) return;
    runAction(name, ctx);
  };
  const feedButton = (compact: boolean, variant?: 'secondary') => (
    <Button variant={variant} size={compact ? 'compact' : undefined} icon="feed" role="food" haspopup="dialog" expanded={cover.opener || undefined} onClick={() => act('feed')}>
      {`Feed ${name}`}
    </Button>
  );

  // The newest thing the pet said is in its lead voice — while nothing is on its way, nothing failed, and only the
  // note of a reply that stopped at its limit follows it.
  const all = s.lines ?? [];
  // the pet's question to a worker is not the reply the turn waits for, so it never takes the lead voice
  const lastPet = all.reduce((at, l, i) => (l.who === 'pet' && !l.question ? i : at), -1);
  const settled = !s.busy && s.failure === null;
  // The Manual offer is a card after the pet's question of its turn: open (with its buttons) while it stands and nothing answers it,
  // its words alone once answered; the tab keeps the words.
  const offer = pet.offer;
  // the worker whose answer the own reply is lost after: the newest worker line
  const lastWorker = all.reduce((at, l) => (l.who === 'worker' && l.worker ? l.worker.name : at), '');
  const lastQuestion = all.reduce<string | null>((at, l) => (l.question ? l.id : at), null);
  const offerCards = (afterId: string | null): ReactNode[] => [
    ...s.answeredOffers.filter((o) => o.after === afterId).map((o) => <OfferMessage key={o.id} text={o.text} worker="" />),
    ...(offer !== null && lastQuestion === afterId
      ? [
          <OfferMessage
            key="offer"
            text={s.rose ? offerRoseLine(offer.worker, offer.price.cents) : offerLine(name, offer.worker, offer.price.cents)}
            worker={offer.worker}
            buttons={s.offerBusy || s.busy ? undefined : { onAsk: s.askOffer, onDecline: s.declineOffer }}
          />,
        ]
      : []),
  ];
  // «Try again» under an errand that came back with nothing: Errand sheet with that form and job and a fresh price (`Errand flow` › «try again»)
  const openAgain = (again: { form: ErrandForm; job: string }) => {
    if (!auth.needSession()) return;
    closeFeed();
    skill.close();
    errand.openSheet(again);
  };
  const history = [
    ...all.flatMap((line, i): ReactNode[] => [
      line.who === 'event' ? (
        <Message key={line.id} from="event" fresh={line.fresh}>
          {line.text}
        </Message>
      ) : line.who === 'player' ? (
        <Message key={line.id} from="player" speaker={line.previousOwner ? 'Previous owner' : 'You'} fresh={line.fresh} kicker={line.kicker ? FORM_WORD[line.kicker] : undefined}>
          {line.text}
        </Message>
      ) : line.who === 'error' ? (
        // an errand that came back with nothing: the line where the card would be, and «Try again» with its form and job
        <Message
          key={line.id}
          from="error"
          fresh={line.fresh}
          actions={
            line.retry ? (
              <Button variant="secondary" size="compact" onClick={() => openAgain(line.retry!)}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {line.text}
        </Message>
      ) : line.who === 'worker' ? (
        <WorkerMessage key={line.id} line={line} />
      ) : line.report ? (
        <ReportMessage key={line.id} line={line} name={name} tokenId={tokenId} reveal={Boolean(line.fresh) && i === all.length - 1} />
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
      ...(line.question ? offerCards(line.id) : []),
    ]),
    // a card with no question line to follow (the page opened on an offer whose question is not read yet) stands at the end
    ...offerCards(null),
  ];

  const card = (
    <Stack gap={3}>
      <Cluster gap={3}>
        <Slot slot="growth" {...slot} />
      </Cluster>
      <CheckLink tokenId={tokenId} name={name} seal={seal} watching={pet.watch?.target} start />
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
  // with a card sheet open the page under it says the line of `Card eligibility rule` › pet asleep
  const sleepLine = share.open ? `${name} is asleep. A meal can wake ${name}.` : `${name} is asleep. A meal will wake ${name} up.`;
  // zero energy is not the day's cap: «Think hard» stops for it, chatting does not (`Energy rule`), and its words come before the hunger's
  const drained = !asleep && !tired && pet.energy === 0;
  const note = asleep ? null : tired ? tiredLine : drained ? energyLine(name, pet.until) : hungry ? hungryLine : null;
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
            off={(off && !signedOut) || hungry || drained}
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
          <Slot slot="hiring" {...slot} row />
        </Only>
      )}
    </Stack>
  );

  // A newborn from a friend's pet keeps that route back; an owner with two pets also needs the list.
  const header = (
    <Header
      start={
        s.friend && pet.ownedCount >= 2 ? <Cluster>
          <Button variant="ghost" size="compact" icon="back" href={`/pet/${s.friend.tokenId}`}>
            {`Back to ${s.friend.name}`}
          </Button>
          <Button variant="ghost" size="compact" icon="pets" haspopup="dialog" expanded={myPetsOpen} onClick={() => act('myPets')}>
            My pets
          </Button>
        </Cluster> : s.friend ? (
          <Button variant="ghost" size="compact" icon="back" href={`/pet/${s.friend.tokenId}`}>
            {`Back to ${s.friend.name}`}
          </Button>
        ) : pet.ownedCount >= 2 ? (
          <Button variant="ghost" size="compact" icon="pets" haspopup="dialog" expanded={myPetsOpen} onClick={() => act('myPets')}>
            My pets
          </Button>
        ) : null
      }
      end={<Cluster gap={2} nowrap>
        <Only on="desktop"><Button variant="secondary" size="compact" icon="search" href="/hire">Find a pet to ask</Button></Only>
        <Only on="phone"><IconButton variant="secondary" icon="search" label="Find a pet to ask" href="/hire" /></Only>
        <Account {...slot} />
      </Cluster>}
    />
  );

  // With Feed sheet open the phone's bottom sheet is modal: the header and the pet are out of reach (on the desktop the page stays
  // live beside the panel); the conversation and its field are covered on both, the sheet takes the column they stand in.
  if (share.lostOwner) {
    const guestPet: Exclude<PetView, { viewer: 'owner' }> = { ...pet, viewer: 'guest' };
    return <>
      <Inert on><OutsiderPage pet={guestPet} s={s} seal={seal} /></Inert>
      <div className="ds-only" data-accent={accentOf(tokenId)} style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-sans)' }}>{share.sheet}</div>
    </>;
  }
  return (
    <Shell accent={accentOf(tokenId)} fill header={<Inert on={giftGiven || share.open ? true : cover.open || giftOpen || myPetsOpen ? 'phone' : undefined}>{header}</Inert>}>
      {myPetsOpen ? <MyPetsSheet tokenId={tokenId} /> : null}
      <Inert on={share.open ? true : myPetsOpen ? 'phone' : undefined}><Page fill>
        <ConnectionBanner banner={s.banner} name={name} tryAgain={s.tryAgain} />
        <SealBanner name={name} seal={seal} />
        {paused && !s.banner ? <Banner tone="info">{pausedLine(name)}</Banner> : null}
        <Split
          fill
          ratio="start"
          start={
            <Inert on={giftGiven ? true : cover.open || giftOpen ? 'phone' : undefined}>
              <PetStage
                compact
                owner
                pet={
                  s.away ? (
                    // the pet is off on an errand: the stage empties but for its light pool and the path (`Errand flow` › «sent»)
                    <Away paused={figure.paused} />
                  ) : (
                    <PetFigure tokenId={tokenId} name={name} state={state} stage={pet.stage} mood={asleep ? null : pet.mood} size="hero" lost={figure.lost} onLost={figure.onLost} hub={hub} birth={birth} {...wearProps(pet.worn)} />
                  )
                }
                // the walker of the errand moves on a flat page too (no WebGL, the context lost): «Pause motion» stops it (DS › Away)
                motion={s.away ? figure.toggle : figure.motion}
                rail={
                  asleep ? <Rail>
                    <RailItem icon="share" label="Ask friends to fund an errand" haspopup="dialog" expanded={errand.open || undefined} onClick={openErrand} />
                    <RailItem icon="watch" label={pet.watch ? 'Edit watch' : 'Watch something'} haspopup="dialog" expanded={watchOpen || undefined} onClick={openWatch} />
                    {share.entry}
                  </Rail> : (
                    <Rail>
                      <RailItem icon="today" label="Today" href={`/pet/${tokenId}/diary`} role="food" />
                      <RailItem icon="hanger" label="Wardrobe" href={`/pet/${tokenId}/wardrobe`} />
                      <RailItem
                        icon="pack"
                        label={`Send ${name} on an errand`}
                        role="mind"
                        haspopup="dialog"
                        expanded={errand.open || undefined}
                        off={s.away}
                        describedBy={s.away ? 'errand-away' : undefined}
                        onClick={openErrand}
                      />
                      <RailItem icon="watch" label={pet.watch ? 'Edit watch' : 'Watch something'} haspopup="dialog" expanded={watchOpen || undefined} onClick={openWatch} />
                      {share.entry}
                      <RailItem icon="gift" label={`Give ${name} away`} haspopup="dialog" expanded={giftOpen && !giftRequest?.self} onClick={() => act('gift')} />
                    </Rail>
                  )
                }
                plate={
                  <PetPlate
                    name={name}
                    seal={seal.state.hash ?? undefined}
                    compact={hasSlot('energy')}
                    badge={
                      asleep && !label ? undefined : (
                        <SkillBadge name={name} label={label} owner={!asleep} expanded={skillShown || undefined} onClick={openSkill} />
                      )
                    }
                    fullness={{ state: pet.fullness.state, level: hungry ? pet.fullness.level : undefined }}
                    action={asleep ? null : feedButton(true, 'secondary')}
                  >
                    <Only on="desktop">
                      <Slot slot="growth" {...slot} />
                    </Only>
                    <Slot slot="energy" {...slot} />
                  </PetPlate>
                }
                foot={<Stack gap={2} align="center">
                  <CheckLink tokenId={tokenId} name={name} seal={seal} watching={pet.watch?.target} />
                  <OldReserveNotice tokenId={tokenId} name={name} reserve={pet.oldSharedReserve} onReleased={s.reread} />
                </Stack>}
              />
            </Inert>
          }
          end={
            <Stack gap={0} grow>
              <Inert on={cover.open || (giftOpen && !giftTyping)}>
                <Conversation intro={card} introOn="phone">
                  {history}
                  {s.failure ? (
                    <Message
                      key="failure"
                      from="error"
                      actions={
                        s.failure.noRetry ? undefined : (
                          <Button variant="secondary" size="compact" onClick={s.retryThought}>
                            Try again
                          </Button>
                        )
                      }
                    >
                      {s.failure.code === 'empty_paid' ? emptyPaidLine(name) : lostLine(name)}
                    </Message>
                  ) : null}
                  {s.ownLost && !s.busy ? <OwnLostMessage key="own-lost" name={name} worker={lastWorker} onTryAgain={s.finishHire} /> : null}
                  {s.busy ? (
                    <Thinking key="thinking" id={s.away ? 'errand-away' : undefined} wait={s.waiting ? WAIT_LINE : undefined}>
                      {s.away ? sentLine(name) : s.asking ? askingLine(name, s.asking) : `${name} is thinking${s.jobMode === 'deep' ? ' hard' : ''}…`}
                    </Thinking>
                  ) : null}
                </Conversation>
                <Dock>
                  {field}
                  <Live>{live}</Live>
                  <Live alert>{signedOut ? signInLines.map((l) => l.text).join(' ') : ''}</Live>
                </Dock>
              </Inert>
              {/* Feed sheet stands over this one: the errand's sheet is out of reach while it is open, and keeps its form and text */}
              <Inert on={feedCover.open}>
                <ErrandSheet name={name} errand={errand} asleep={pet.fullness.state === 'asleep'} onFeed={() => openFeed({ tokenId, name, label: name, elsewhere: false })} />
              </Inert>
              <WatchSheet tokenId={tokenId} name={name} open={watchOpen} draft={watchDraft} onDraft={setWatchDraft} onClose={() => setWatchOpen(false)} tokenOf={s.tokenOf} onOwnerLost={s.reread} onChanged={s.reread} />
              <FeedLayer column pageFullness={pet.fullness} />
              <GiftSheet tokenId={tokenId} name={name} stage={pet.stage} worn={pet.worn} onGiven={s.reread} />
              <SkillSheet
                name={name}
                skill={skill}
                hasLabel={label !== null}
                onClose={skill.close}
                hidden={adapter.open || code.open}
                sockets={{ onConnect: () => adapter.openNew(), onSource: (source) => adapter.openSource(source), onCode: () => code.openSheet() }}
              />
              <AdapterSheet
                name={name}
                adapter={adapter}
                tokenId={tokenId}
                onClose={() => {
                  adapter.close();
                  skill.close();
                }}
              />
              <CodeSheet
                name={name}
                sheet={code}
                onClose={() => {
                  code.close();
                  skill.close();
                }}
              />
            </Stack>
          }
        />
      </Page></Inert>
      {share.sheet}
      <Live>{skillSaved ? skillSavedLine(name) : ''}</Live>
      {skillSaved ? (
        <Toast icon="check" silent onDone={toastHeld() ? undefined : () => setSkillSaved(false)}>
          {skillSavedLine(name)}
        </Toast>
      ) : null}
      <Live>{adapterLine ?? ''}</Live>
      {adapterLine ? (
        <Toast icon="check" silent onDone={toastHeld() ? undefined : () => setAdapterLine(null)}>
          {adapterLine}
        </Toast>
      ) : null}
    </Shell>
  );
}

/** A signed-in player who isn't the owner, or a visitor with no session: one centred column — the pet, its plate,
 *  «Check it's really {name}», the asleep line, then «Feed {name}» and what the viewer can do next. */
function OutsiderPage({ pet, s, seal }: { pet: Exclude<PetView, { viewer: 'owner' }>; s: ReturnType<typeof usePetScreen>; seal: ReturnType<typeof useSeal> }) {
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
  // the label under the name, for every viewer, inert (`Skill rule` › «label on the pet's page»); none for a pet with no skill
  // the badge is always passed, as the frames do: with no skill it draws nothing, and the plate keeps the frames' spacing
  const skillBadge = <SkillBadge name={name} label={pet.skill?.label} />;
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
  const giftRequest = useGiftRequest();
  const givenHere = giftRequest?.tokenId === tokenId && giftRequest.given === true;
  const feed = (
    <Button block icon="feed" haspopup="dialog" expanded={cover.opener || undefined} onClick={() => (viewer === 'visitor' ? begin('feed') : auth.needSession() && runAction('feed', ctx))}>
      {`Feed ${name}`}
    </Button>
  );
  // a friend's meal wakes the pet on this screen too: the boot, as on the owner's page
  const waking = useWaking(asleep);
  // what the advice column tells the page: a question on its way gives the friend's pet its thinking face
  const [adviceStatus, setAdviceStatus] = useState({ thinking: false, cantPay: false });
  const onAdviceStatus = useCallback(
    (next: { thinking: boolean; cantPay: boolean }) => setAdviceStatus((now) => (now.thinking === next.thinking && now.cantPay === next.cantPay ? now : next)),
    [],
  );
  const state = waking ? 'waking' : adviceStatus.thinking && !asleep ? 'thinking' : pet.fullness.state;
  // the pet falls asleep or wakes while this page is open (it re-reads by itself): the line is said by the page's own region
  const asleepLine = `${name} is asleep — food from you would wake ${name} up.`;
  const covered = cover.open ? 'phone' : undefined;
  // The connection line is drawn silent over the pet and said by a region of the page; the pet given away under a clear says its
  // words in a Toast — silent, the screen's own Live says them
  const tail = (
    <>
      <Live>{bannerLine(s.banner, name)}</Live>
      {s.notice ? (
        <Toast silent onDone={toastHeld() ? undefined : s.clearNotice}>
          {s.notice}
        </Toast>
      ) : null}
    </>
  );

  // A guest with a pet of their own asks the friend's pet for advice (add-pet-work › Advice flow): the frame `guestAdvice` — the pet
  // at the left with «Feed {name}» beside the name on the phone and under the plate on the desktop, the advice log and its field at
  // the right where the owner's conversation stands, Feed sheet taking the column's place when it opens.
  if (viewer === 'guest' && home !== null && hasSlot('advice')) {
    const feedBeside = (compact: boolean) => (
      <Button
        size={compact ? 'compact' : undefined}
        variant={adviceStatus.cantPay ? 'secondary' : undefined}
        icon="feed"
        role={adviceStatus.cantPay ? 'food' : undefined}
        haspopup="dialog"
        expanded={cover.opener || undefined}
        onClick={() => auth.needSession() && runAction('feed', ctx)}
      >
        {`Feed ${name}`}
      </Button>
    );
    const advice = {
      payer: home,
      tokenOf: s.tokenOf,
      report: s.report,
      payerChanged: s.refreshMe,
      onStatus: onAdviceStatus,
      look: () => void s.look(),
      covered: cover.open,
      check: <CheckLink tokenId={tokenId} name={name} seal={seal} watching={pet.watch?.target} />,
      offline: offlineLine(name),
      carried: s.carried,
      takeCarried: s.takeCarried,
    };
    return (
      <Shell accent={accentOf(tokenId)} fill header={<Inert on={givenHere ? true : covered}>{header}</Inert>}>
        <Page fill>
          <ConnectionBanner banner={s.banner} name={name} tryAgain={s.tryAgain} />
          <SealBanner name={name} seal={seal} />
          <Split
            fill
            ratio="start"
            start={
              <Inert on={givenHere ? true : covered}>
                <PetStage
                  compact
                  pet={<PetFigure tokenId={tokenId} name={name} state={state} stage={pet.stage} mood={asleep ? null : pet.mood} size="hero" lost={figure.lost} onLost={figure.onLost} hub={figure.hub} {...wearProps(pet.worn)} />}
                  motion={figure.motion}
                  plate={
                    <PetPlate name={name} seal={seal.state.hash ?? undefined} compact badge={skillBadge} fullness={{ state: pet.fullness.state, level: pet.fullness.state === 'hungry' ? pet.fullness.level : undefined }}>
                      <Only on="phone">{feedBeside(true)}</Only>
                    </PetPlate>
                  }
                  foot={
                    <Stack gap={2} align="center">
                      {feedBeside(false)}
                      <CheckLink tokenId={tokenId} name={name} seal={seal} watching={pet.watch?.target} />
                    </Stack>
                  }
                />
              </Inert>
            }
            end={
              <Stack gap={0} grow>
                <Inert on={givenHere}><Slot slot="advice" {...slot} advice={advice} /></Inert>
                <FeedLayer column pageFullness={pet.fullness} />
                {givenHere ? <GiftSheet tokenId={tokenId} name={name} stage={pet.stage} worn={pet.worn} onGiven={() => undefined} /> : null}
              </Stack>
            }
          />
        </Page>
        {tail}
      </Shell>
    );
  }
  return (
    <Shell accent={accentOf(tokenId)} fill header={<Inert on={givenHere ? true : covered}>{header}</Inert>}>
      <Inert on={givenHere ? true : covered}>
        <Page fill width="narrow">
          <ConnectionBanner banner={s.banner} name={name} tryAgain={s.tryAgain} />
          <SealBanner name={name} seal={seal} />
          <Centerpiece
            status={asleep ? asleepLine : ''}
            actions={
              <Stack gap={2}>
                {asleep ? <Text align="center">{asleepLine}</Text> : null}
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
                <SignInOutcome column unreachable={offlineLine(name)} />
              </Stack>
            }
          >
            <PetStage
              pet={<PetFigure tokenId={tokenId} name={name} state={state} stage={pet.stage} mood={asleep ? null : pet.mood} size="hero" lost={figure.lost} onLost={figure.onLost} hub={figure.hub} {...wearProps(pet.worn)} />}
              motion={figure.motion}
              plate={<PetPlate name={name} seal={seal.state.hash ?? undefined} badge={skillBadge} fullness={{ state: pet.fullness.state, level: pet.fullness.state === 'hungry' ? pet.fullness.level : undefined }} />}
              foot={<CheckLink tokenId={tokenId} name={name} seal={seal} watching={pet.watch?.target} />}
            />
          </Centerpiece>
        </Page>
      </Inert>
      <FeedLayer pageFullness={pet.fullness} />
      {givenHere ? <GiftSheet tokenId={tokenId} name={name} stage={pet.stage} worn={pet.worn} onGiven={() => undefined} /> : null}
      {tail}
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

/** Diary screen of the owner's awake pet, over the Pet screen's own state (`add-daily-ritual` › `Diary screen`). */
function DiaryOwner({ pet, d, s }: { pet: OwnerView; d: ReturnType<typeof useDiary>; s: ReturnType<typeof usePetScreen> }) {
  const { tokenId, name } = pet;
  const auth = useAuth();
  const cover = useFeedCover(tokenId);
  // the Diary's own failed read, or the failed send of a question: one connection line over the page
  const line = d.banner ?? s.banner;
  return (
    <DiaryPage
      pet={pet}
      d={d}
      s={s}
      accent={accentOf(tokenId)}
      account={<Account tokenId={tokenId} name={name} viewer="owner" asleep={pet.fullness.state === 'asleep'} />}
      banner={<ConnectionBanner banner={line} name={name} tryAgain={d.banner ? d.tryAgain : s.tryAgain} />}
      bannerLine={bannerLine(line, name)}
      offline={offlineLine(name)}
      covered={cover.open}
      layer={<FeedLayer pageFullness={pet.fullness} />}
      onFeed={() => {
        if (auth.needSession()) runAction('feed', { tokenId, name, viewer: 'owner' });
      }}
    />
  );
}

/** Wardrobe screen of the owner's awake pet, over the Pet screen's own state (`add-wardrobe` › `Wardrobe screen`). */
function WardrobeOwner({ pet, w, s }: { pet: OwnerView; w: ReturnType<typeof useWardrobe>; s: ReturnType<typeof usePetScreen> }) {
  const { tokenId, name } = pet;
  const cover = useFeedCover(tokenId);
  const figure = useFigure();
  // the wardrobe's own failed read or a failed «Wear», or the Pet screen's: one connection line over the page
  const line = w.banner ?? s.banner;
  return (
    <WardrobePage
      pet={pet}
      w={w}
      figure={{ lost: figure.lost, onLost: figure.onLost, hub: figure.hub, motion: figure.motion }}
      accent={accentOf(tokenId)}
      account={<Account tokenId={tokenId} name={name} viewer="owner" asleep={pet.fullness.state === 'asleep'} />}
      banner={<ConnectionBanner banner={line} name={name} tryAgain={w.banner ? w.tryAgain : s.tryAgain} />}
      bannerLine={bannerLine(line, name)}
      offline={offlineLine(name)}
      covered={cover.open}
      layer={<FeedLayer pageFullness={pet.fullness} />}
    />
  );
}

function SealPet({ pet, s }: { pet: PetView; s: ReturnType<typeof usePetScreen> }) {
  const key = `${pet.viewer}:${pet.stage}:${pet.worn}:${pet.viewer === 'owner' ? pet.memoryEpoch : ''}`;
  const seal = useSeal(pet.tokenId, key);
  return <>
    <Live>{seal.state.kind === 'mismatch' || seal.state.kind === 'unavailable' ? sealLine(pet.name, seal.state) : ''}</Live>
    {pet.viewer === 'owner' ? <OwnerPage pet={pet} s={s} seal={seal} /> : <OutsiderPage pet={pet} s={s} seal={seal} />}
  </>;
}

function PetView({
  s,
  d,
  w,
  diary,
  wardrobe,
}: {
  s: ReturnType<typeof usePetScreen>;
  d: ReturnType<typeof useDiary>;
  w: ReturnType<typeof useWardrobe>;
  diary: boolean;
  wardrobe: boolean;
}) {
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
  if (page.pet.viewer !== 'owner') return <SealPet pet={page.pet} s={s} />;
  if (wardrobe) return <WardrobeOwner pet={page.pet} w={w} s={s} />;
  return diary ? <DiaryOwner pet={page.pet} d={d} s={s} /> : <SealPet pet={page.pet} s={s} />;
}

/** `diary`: the address is the Diary's (`/pet/<token_id>/diary`). Its page is the owner's awake pet's; a guest or a visitor on it gets
 *  the Pet screen's page for them, the address kept; an asleep pet's address is the Pet screen (`Diary screen` › entry point). */
export function PetScreen({ tokenId, from, diary = false, wardrobe = false }: { tokenId: string; from: string | null; diary?: boolean; wardrobe?: boolean }) {
  const s = usePetScreen(tokenId, from, diary);
  useEffect(() => closeGift, [tokenId]);
  useEffect(() => closeMyPets, [tokenId]);
  const owner = s.page.kind === 'pet' && s.page.pet.viewer === 'owner' ? s.page.pet : null;
  const isOwner = owner !== null;
  useEffect(() => { if (!isOwner) closeMyPets(); }, [isOwner]);
  const asleep = owner?.fullness.state === 'asleep';
  // An asleep pet at the address has no Diary and no Wardrobe: its Pet screen, at its own address. A Diary or a Wardrobe that stood
  // while the pet was awake stays (and turns «asleep»).
  const stood = useRef(false);
  const awakeOwner = owner !== null && !asleep;
  const surface = diary || wardrobe;
  useEffect(() => {
    if (!surface) stood.current = false;
    else if (awakeOwner) stood.current = true;
    else if (owner !== null && !stood.current) navigate(petPath(tokenId));
  }, [surface, awakeOwner, owner !== null, tokenId]);
  const standingSurface = owner !== null && (!asleep || stood.current);
  const standing = diary && standingSurface;
  const standingWardrobe = wardrobe && standingSurface;
  const decided = s.page.kind === 'pet' || s.page.kind === 'not_found';
  const d = useDiary({ tokenId, active: standing, owner: owner !== null, decided, reread: s.reread, nudge: s.nudge, returned: s.returned, askLook: s.look });
  const w = useWardrobe({ tokenId, active: standingWardrobe, reread: s.reread, askLook: s.look });
  // The Wardrobe stands like the Diary does: the owner chose it, so neither the Diary nor the notice opens by itself over it.
  const { reread, look } = s;
  const notice = useNotice({ tokenId, owner: owner !== null, notices: owner?.notices ?? [], look: () => void look(), reread });
  useSelfOpen({
    tokenId,
    diaryUnread: owner?.diaryUnread ?? false,
    diary: standing,
    wardrobe: standingWardrobe,
    asleep,
    typing: s.draft !== '',
    notice: notice.due,
    onNotice: notice.show,
  });
  // The pet is someone else's now, whichever read told first (the Diary's own `403`, or `/state`, the only one on the Pet screen):
  // the riddle answer typed for it goes with the owner's page (`Ritual data`). A visitor's page is the ended session, which keeps it.
  const guest = s.page.kind === 'pet' && s.page.pet.viewer === 'guest';
  const { dropRiddle } = d;
  useEffect(() => {
    if (guest) dropRiddle();
  }, [guest, dropRiddle]);
  // The exchange is in the diary: the answer on its way has done its part under the question
  const exchanged = d.view?.exchange != null;
  const { clearAsked } = s;
  useEffect(() => {
    if (exchanged) clearAsked();
  }, [exchanged, clearAsked]);
  // A Diary that stood while the pet slept ends with the day: at 00:00 UTC the Pet screen, and the riddle answer typed for the old
  // day does not come back (`Ritual day rule` › «новые сутки у спящего»)
  const sleptOn = useRef<number | null>(null);
  const day = d.view?.day ?? null;
  const sleeping = diary && asleep === true && stood.current;
  useEffect(() => {
    if (!sleeping) {
      sleptOn.current = null;
      return;
    }
    if (day === null) return;
    if (sleptOn.current === null) sleptOn.current = day;
    else if (day !== sleptOn.current) {
      d.dropRiddle();
      navigate(petPath(tokenId));
    }
  }, [sleeping, day, tokenId, d.dropRiddle]);
  useFeedLinkOpened();
  // The sheet is the tab's memory of this screen: it goes with the screen, and a sheet for another pet than this page's (not the
  // own pet's «Feed your {my_pet}») does not follow the player to it.
  const request = useFeedRequest();
  useEffect(() => {
    if (request !== null && !request.elsewhere && request.tokenId !== tokenId) closeFeed();
  }, [request, tokenId]);
  useEffect(() => closeFeed, []);
  // New outfit notice: beside the page, which stays at one place of the tree (its state, its draft and its pet's canvas live on) and is
  // out of reach while the notice stands. The dialog is beside the Shell, which is where the DS sets the text colour and the font and
  // the pet's accent: they are given here.
  const noticeSlug = owner !== null ? notice.open : null;
  // Verdict card (`Verdict card screen`): the tab's memory of one «Share card» tap. It goes with the pet's owner, the screen and the
  // page: a pet that is someone else's now, or another pet's page, has no card of this one.
  const verdict = useVerdictRequest();
  const cardShown = owner !== null && verdict !== null;
  useEffect(() => {
    if (owner === null) closeVerdict();
  }, [owner === null]);
  useEffect(() => closeVerdict, [tokenId]);
  return (
    <>
      <Live>{outcomeLine(s.page, s.notice)}</Live>
      <Inert on={noticeSlug !== null || cardShown}>
        <PetView s={s} d={d} w={w} diary={standing} wardrobe={standingWardrobe} />
      </Inert>
      {owner !== null && verdict !== null ? (
        <div className="ds-only" data-accent={accentOf(tokenId)} style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-sans)' }}>
          <VerdictCard
            request={verdict}
            pet={{ tokenId, name: owner.name, stage: owner.stage, state: owner.fullness.state, worn: owner.worn }}
          />
        </div>
      ) : null}
      {owner !== null && noticeSlug !== null ? (
        <div className="ds-only" data-accent={accentOf(tokenId)} style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-sans)' }}>
          <NewOutfitNotice pet={owner} slug={noticeSlug} wearing={notice.wearing} failed={notice.failed} onWear={() => void notice.wear()} onLater={notice.later} />
        </div>
      ) : null}
    </>
  );
}
