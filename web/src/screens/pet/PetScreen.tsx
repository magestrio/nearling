import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSeal } from '../../verification/seal';
import { AccountControl } from '../../account/AccountControl';
import {
  Away,
  Banner,
  Bubble,
  Button,
  Cluster,
  Composer,
  Conversation,
  Dock,
  Heading,
  Hotbar,
  Hud,
  IconButton,
  Inert,
  Live,
  Message,
  MotionToggle,
  Note,
  Only,
  PetCard,
  Seal,
  Shell,
  Skeleton,
  SkillBadge,
  Stage,
  Stack,
  Text,
  TextLink,
  Thinking,
  Toast,
  type Accent,
} from '../../ds';
import { DiaryPage } from '../../diary/DiaryPage';
import { ExperienceNotesPage } from '../../experience/ExperienceNotesPage';
import { WorkRecordPage } from '../../experience/WorkRecordPage';
import { useDiary } from '../../diary/useDiary';
import { useSelfOpen } from '../../diary/useSelfOpen';
import { nameOf, wearProps } from '../../wardrobe/catalogue';
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
import { askingLine, likedOfferLine, offerLine, offerRoseLine, skillSavedLine } from '../../work/lines';
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
import { workRecordPath, hatchPath, navigate, petPath, useLocation } from '../../route';
import { canUseWebGL } from '../../pet/flat';
import { makePet } from '../../pet/proto/generator.js';
import { useMotionPaused } from '../../pet/motion';
import { useBirth } from '../../pet/newborn';
import { PetFigure } from '../../pet/PetFigure';
import { MS, talkMs } from '../../pet/proto/motion.js';
import { usePetMotion } from '../../pet/proto/useMotion.js';
import { useAuth } from '../../seams/auth';
import { toastHeld, workerApi, WorkerError, type ErrandForm, type PetView, type WishTarget } from '../../seams/worker';
import { useWishSheet } from '../../will/WishSheet';
import { InvitationCard, useInvitations } from '../../will/InvitationCard';
import { SignInLines, SignInOutcome, useSignInLines } from '../../signin/SignInOutcome';
import { useSignIn } from '../../signin/signIn';
import { emptyPaidLine, lostLine, offlineLine, pausedLine, WAIT_LINE } from './lines';
import { hasSlot, peekPendingAction, runAction, Slot, takePendingAction, type ActionName, type Viewer } from './parts';
import { takeReturnSheet, takeReturnSkill } from '../../signin/returnPlace';
import { FORMER_OWNER_LINE, usePetScreen, type Banner as BannerKind, type OwnerView } from './usePetScreen';
import { useWaking } from './useWaking';
import { usePetCard } from '../../showcase/usePetCard';
import { guestStageActions, newestPetReply, ownerConversationDisabled, ownerStageActions, visiblePetReply } from './stageActions';
import { useProfileCard } from './useProfileCard';
import { ProfileCard } from './ProfileCard';
import { sealLine } from './sealLine';
export { sealLine } from './sealLine';

// Pet screen (add-pet › Pet screen, Connection rule): one game Stage holds the pet, its conversation and its actions.
// The owner and guest data paths remain in usePetScreen; overlays keep this Stage mounted beneath them.
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

/** The guest's public check and record links. `start` keeps the compact intro alignment when used there. */
function CheckLink({ tokenId, name, seal, start, watching }: { tokenId: string; name: string; seal: ReturnType<typeof useSeal>; start?: boolean; watching?: string | null }) {
  const align = start ? undefined : 'center';
  return (
    <Stack gap={1} align={align}>
      {watching ? <Text variant="small" tone="secondary" measure align={align}>{`Watching: ${watching}`}</Text> : null}
      <TextLink href={`/pet/${tokenId}/verify`} tone="trust" icon="verify">{`Check it's really ${name}`}</TextLink>
      {seal.state.kind === 'checked' ? <Text variant="small" tone="secondary" measure align={align}>{sealLine(name, seal.state)}</Text> : null}
      {seal.state.kind === 'mismatch' && !start ? <Note tone="error" silent>{sealLine(name, seal.state)}</Note> : null}
      {seal.state.kind === 'unavailable' && !start ? <Cluster gap={3}><Note tone="error" silent>{sealLine(name, seal.state)}</Note><Button variant="secondary" size="compact" onClick={seal.retry}>Try again</Button></Cluster> : null}
      <Cluster gap={3} justify={start ? undefined : 'center'}>
        <TextLink href={workRecordPath(tokenId)} tone="quiet" iconEnd="chevron">View work record</TextLink>
      </Cluster>
    </Stack>
  );
}

/** The owner's frames (pet.js › ownerAwake) draw the banner on both viewports; a guest's line stands under the check link on the desktop. */
function SealBanner({ name, seal, all }: { name: string; seal: ReturnType<typeof useSeal>; all?: boolean }) {
  if (seal.state.kind !== 'mismatch' && seal.state.kind !== 'unavailable') return null;
  const banner = <Banner action={seal.state.kind === 'unavailable' ? <Button variant="secondary" size="compact" onClick={seal.retry}>Try again</Button> : undefined}>
    {sealLine(name, seal.state)}
  </Banner>;
  return all ? banner : <Only on="phone">{banner}</Only>;
}

function Account({ tokenId, name, viewer, asleep }: { tokenId: string; name: string; viewer: Viewer; asleep: boolean }) {
  return <Slot slot="account" tokenId={tokenId} name={name} viewer={viewer} asleep={asleep} />;
}

/** The dead link: a pet the network does not know, or an address that can't be one. */
export function PetNotFound() {
  return <EmptyPetStage line={NOT_FOUND} action={<Button href="/">Go home</Button>} />;
}

function LoadingView({ tokenId }: { tokenId: string }) {
  return <EmptyPetStage line={FINDING} tokenId={tokenId} inputOff />;
}

/** `inputOff`: the loading view's field, off until the pet is known and named by the spec's words (add-pet › Pet screen › loading). */
function EmptyPetStage({ line, tokenId, action, inputOff }: { line: string; tokenId?: string; action?: ReactNode; inputOff?: boolean }) {
  return <Shell fill header={<Hud meters={false} routes={tokenId ? <AccountControl tokenId={tokenId} /> : undefined} />}>
    <Stage pet={<Skeleton shape="pet" />} chat={<Stack gap={3} grow>
      <Stack gap={3} align="center" justify="center" grow>
        <Heading level={1} variant="title-2" align="center">{line}</Heading>{action}
      </Stack>
      {inputOff ? <Dock><Composer disabled label={line} /></Dock> : null}
    </Stack>} />
  </Shell>;
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
  const [lostPet, setLostPet] = useState<{ pet: Exclude<PetView, { viewer: 'owner' }>; ownerChanged: boolean } | null>(null);
  const readCard = useCallback(async () => {
    try { return await workerApi.pet(await s.tokenOf(), tokenId); }
    catch (error) { if (error instanceof WorkerError && error.status === 401) auth.endSession(true, true); throw error; }
  }, [s.tokenOf, tokenId, auth.endSession]);
  const ownerLost = useCallback((next: PetView) => {
    if (next.viewer === 'owner') return;
    setLostPet({ pet: next, ownerChanged: next.viewer === 'guest' });
    s.reread();
  }, [s.reread]);
  const profile = useProfileCard(readCard, 'owner', ownerLost, auth.authenticated && !auth.sessionEnded, pet);
  const anchorCardOpen = auth.authenticated && !auth.sessionEnded && profile.phase !== 'closed';
  // the ended session's line, or what a tap on its «Sign in» came to: the first stands in the field's note and its action in
  // «Send»'s place, a second (the phone's way to a real browser) under the Composer
  const signInLines = useSignInLines({ unreachable: offlineLine(name), text: s.draft });
  const [lead, ...moreLines] = signInLines;
  const figure = useFigure();
  const asleep = pet.fullness.state === 'asleep';
  const hungry = pet.fullness.state === 'hungry';
  const share = usePetCard(pet, s.lines ?? [], s.tokenOf, auth.authenticated && !auth.sessionEnded);
  const wishSheet = useWishSheet(tokenId, name, pet.outfitPrice, s.tokenOf, s.reread, s.reread);
  const invites = useInvitations(tokenId, auth.authenticated && !auth.sessionEnded, s.tokenOf, s.reread);
  const invitationIds = invites.cards.map((card) => card.id).join('|');
  useEffect(() => {
    if (!invitationIds && !invites.ended) return undefined;
    const frame = requestAnimationFrame(() => {
      const log = document.querySelector<HTMLElement>('[role="log"]');
      const first = [...(log?.querySelectorAll<HTMLElement>('ul[aria-label="Work invitations"] > li') ?? [])]
        .find((item) => item.getClientRects().length > 0);
      if (!log || !first) return;
      const from = first.getBoundingClientRect();
      const box = log.getBoundingClientRect();
      // a card taller than the phone's short log stands with its buttons in view (the frames' scroll), the top is the cut part
      log.scrollTop += from.height > box.height ? from.bottom - box.bottom : from.top - box.top;
    });
    return () => cancelAnimationFrame(frame);
  }, [invitationIds, invites.ended?.id]);
  const privateWish = auth.authenticated && !auth.sessionEnded && !asleep ? pet.wish : null;
  const wishNode = auth.authenticated && !auth.sessionEnded && !asleep ? wishSheet.node : null;
  const lastWish = useRef<WishTarget | null>(null);
  const [wishOutcome, setWishOutcome] = useState<{ item: string; source: 'owner' | 'pet_wish' } | null>(null);
  const outfitKey = pet.outfits.join('|');
  if (privateWish) lastWish.current = privateWish;
  useEffect(() => { if (pet.wish) setWishOutcome(null); }, [pet.wish]);
  useEffect(() => {
    if (pet.wish || !auth.authenticated || auth.sessionEnded) return;
    let active = true;
    void (async () => {
      try {
        const view = await workerApi.wardrobe(await s.tokenOf(), tokenId);
        const outcome = view.outcome;
        if (!active || outcome?.status !== 'bought' || !pet.outfits.includes(outcome.item)) return;
        if (outcome.source === 'pet_wish' || (outcome.source === 'owner' && lastWish.current?.item === outcome.item)) {
          setWishOutcome({ item: outcome.item, source: outcome.source });
        }
      } catch { /* the Pet screen's own connection banner handles its reads */ }
    })();
    return () => { active = false; };
  }, [pet.wish, outfitKey, auth.authenticated, auth.sessionEnded, s.tokenOf, tokenId]);
  useEffect(() => { if (!auth.authenticated || auth.sessionEnded || asleep) wishSheet.close(); }, [auth.authenticated, auth.sessionEnded, asleep, wishSheet.close]);
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
  const newest = newestPetReply(s.lines ?? []);
  const bubbleReply = visiblePetReply(s.lines ?? [], { busy: s.busy, failed: Boolean(s.failure), asleep, away: s.away });
  const said = newest?.fresh ? newest : null;
  useEffect(() => {
    if (!said) return undefined;
    const timer = setTimeout(() => hub.fire('talk', { ms: talkMs([...said.text].length) }), MS.medium);
    return () => clearTimeout(timer);
  }, [said?.id, hub]);

  // Every control that needs a session asks first: with the session ended it shows the line and does nothing else
  // (`Session expiry flow` › «сессия кончилась при открытом экране»).
  const act = (name: ActionName, returnFocusTo?: () => HTMLElement | null) => {
    if (!auth.needSession()) return;
    if (name === 'feed') { skill.close(); closeGift(); }
    if (name === 'gift' && feedOpenNow()) return;
    runAction(name, { ...ctx, returnFocusTo });
  };

  // The newest thing the pet said is in its lead voice — while nothing is on its way, nothing failed, and only the
  // note of a reply that stopped at its limit follows it.
  const all = s.lines ?? [];
  // the pet's question to a worker is not the reply the turn waits for, so it never takes the lead voice
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
            text={s.rose ? offerRoseLine(offer.worker, offer.price.cents) : offer.discounted ? likedOfferLine(name, offer.worker, offer.price.cents) : offerLine(name, offer.worker, offer.price.cents)}
            worker={offer.worker}
            buttons={s.offerBusy || s.busy ? undefined : { onAsk: s.askOffer, onDecline: s.declineOffer, ...(offer.discounted ? { price: formatCents(offer.price.cents) } : {}) }}
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
  // A sheet keeps this Stage mounted, including its single pet canvas and the current conversation.
  const stageCovered = share.open || giftGiven || anchorCardOpen || code.open ? true
    : cover.open || giftOpen || myPetsOpen || !!wishNode ? 'phone' : undefined;
  const history = [
    ...all.flatMap((line, i): ReactNode[] => [
      line.who === 'event' ? (
        <Message key={line.id} from="event" fresh={line.fresh}
          verify={line.refusalId ? { href: `/pet/${tokenId}/verify/refusal/${line.refusalId}`, label: 'Check this thought' } : undefined}>
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
        <ReportMessage key={line.id} line={line} name={name} tokenId={tokenId} tokenOf={s.tokenOf} reveal={Boolean(line.fresh) && i === all.length - 1} />
      ) : (
        <Message
          key={line.id}
          from="pet"
          speaker={name}
          fresh={line.fresh}
          bubbled={line.id === bubbleReply?.id}
          verify={line.noVerify ? undefined : { href: `/pet/${tokenId}/verify/${line.id}`, label: 'Check this thought' }}
          meta={line.meta}
          foot={line.foot}
        >
          {line.text}
        </Message>
      ),
      ...(line.question ? offerCards(line.id) : []),
    ]),
    // a card with no question line to follow (the page opened on an offer whose question is not read yet) stands at the end
    ...offerCards(null),
  ];

  const invitationCards = (invites.cards.length || invites.ended || invites.readError) ? <ul aria-label="Work invitations" className="ds-stack" style={{ gap: 'var(--space-3)', listStyle: 'none', margin: 'var(--space-0)', padding: 'var(--space-0)' }}>
    {invites.readError ? <li><Note tone="error">Work invitations unavailable. Try again.</Note><Button variant="secondary" size="compact" onClick={invites.retryRead}>Try again</Button></li> : null}
    {invites.cards.map((invitation) => <li key={invitation.id}><InvitationCard card={invitation} busy={invites.busy === invitation.id}
      error={Boolean(invites.actionErrors[invitation.id])} onRetry={() => invites.retryAction(invitation)}
      onAsk={() => invites.ask(invitation)} onDismiss={() => invites.dismiss(invitation)} /></li>)}
    {invites.ended ? <li key={`ended-${invites.ended.id}`}><InvitationCard card={invites.ended} ended onAsk={() => undefined} onDismiss={() => undefined} /></li> : null}
  </ul> : null;

  // What turns the field off, and the line that says why (`Pet screen` › «asleep (владелец)», `Daily cap rule` ›
  // «Устал», `Connection rule` › «разговор на паузе»); «Think hard» is also off while the pet is too hungry for it
  // (`Pet condition rule` › «Голоден»), and chatting works then.
  const tired = !asleep && pet.tired;
  const paused = !asleep && !tired && pet.paused;
  // a tap found the session ended: the field is off with its text, the line is the field's note and «Sign in» (or the «Try
  // again» of what became of it) stands in «Send»'s place (frame `session-expired`)
  const signedOut = auth.sessionLine;
  const off = ownerConversationDisabled(asleep, tired, paused, signedOut);
  const tiredLine = `${name} is tired for today. Back at ${resetTime(pet.until)}.`;
  const hungryLine = `${name} is too hungry to think hard right now.`;
  // with a card sheet open the page under it says the line of `Card eligibility rule` › pet asleep
  const sleepLine = pet.wish ? `Feed ${name} to wake them.`
    : share.open ? `${name} is asleep. A meal can wake ${name}.` : `${name} is asleep. A meal will wake ${name} up.`;
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
            // the game Stage's Hotbar already carries «Feed {name}»: its Composer has no end button asleep (pet.js › gameOwner)
            null
          ) : (
            <Button key="send" size="compact" iconEnd="send" type="submit" off={off} busy={s.busy} onClick={() => void s.send(s.draft)}>
              Send
            </Button>
          )
        }
      />
      {signedOut ? <SignInLines lines={moreLines} /> : null}
    </Stack>
  );

  const stageActions = ownerStageActions({ tokenId, name, asleep, away: s.away, feedOpen: cover.opener,
    errandOpen: errand.open, watch: Boolean(pet.watch), watchOpen, giftOpen: giftOpen && !giftRequest?.self, onFeed: () => act('feed'), onErrand: openErrand,
    onWatch: openWatch, onGift: () => act('gift', () => document.querySelector<HTMLElement>('.ds-hotbar__action[aria-haspopup="menu"]') ?? document.querySelector<HTMLElement>('.ds-hud__nameplate')) });
  if (auth.sessionEnded) {
    stageActions.items = stageActions.items.map((item) => item.more ? { ...item, off: true } : item);
  }
  if (lostPet) return <OutsiderPage pet={lostPet.pet} s={s} seal={seal} ownerChanged={lostPet.ownerChanged} />;
  if (share.lostOwner) {
    const guestPet: Exclude<PetView, { viewer: 'owner' }> = { ...pet, viewer: 'guest' };
    return <>
      <Inert on><OutsiderPage pet={guestPet} s={s} seal={seal} /></Inert>
      <div className="ds-only" data-accent={accentOf(tokenId)} style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-sans)' }}>{share.sheet}</div>
    </>;
  }
  return <Shell accent={accentOf(tokenId)} fill header={<Inert on={stageCovered}>
    <Hud name={name} stage={pet.stage === 'baby' ? 'Baby' : pet.stage === 'teen' ? 'Teen' : 'Grown-up'}
      seal={seal.state.hash ? <Seal hash={seal.state.hash} size="sm" /> : undefined}
      condition={pet.fullness.state} level={hungry ? pet.fullness.level : undefined} owner energy={pet.energy}
      cardOpen={anchorCardOpen} onCard={() => { if (auth.needSession()) void profile.open(); }}
      myPets={pet.ownedCount >= 2 ? <><Only on="desktop"><Button variant="ghost" size="compact" icon="pets" haspopup="dialog" expanded={myPetsOpen} onClick={() => act('myPets')}>My pets</Button></Only>
        <Only on="phone"><IconButton icon="pets" label="My pets" haspopup="dialog" expanded={myPetsOpen} onClick={() => act('myPets')} /></Only></> : undefined}
      routes={s.friend ? <Cluster gap={2} nowrap><Only on="desktop"><Button variant="ghost" size="compact" icon="back" href={`/pet/${s.friend.tokenId}`}>{`Back to ${s.friend.name}`}</Button></Only>
        <Only on="phone"><IconButton variant="ghost" icon="back" label={`Back to ${s.friend.name}`} href={`/pet/${s.friend.tokenId}`} /></Only><Account {...slot} /></Cluster>
        : <Cluster gap={2} nowrap><Only on="desktop"><Button variant="ghost" size="compact" icon="search" href="/hire">Find a pet to ask</Button></Only>
        <Only on="phone"><IconButton variant="secondary" icon="search" label="Find a pet to ask" href="/hire" /></Only><Account {...slot} /></Cluster>} />
  </Inert>}>
    <Heading level={1} hidden>{name}</Heading>
    <ConnectionBanner banner={s.banner} name={name} tryAgain={s.tryAgain} />
    <SealBanner name={name} seal={seal} all />
    {paused && !s.banner ? <Banner tone="info">{pausedLine(name)}</Banner> : null}
    <Inert on={stageCovered}><Stage asleep={asleep}
      pet={s.away ? <Away paused={figure.paused} /> : <PetFigure tokenId={tokenId} name={name} state={state} stage={pet.stage} mood={asleep ? null : pet.mood} size="hero" lost={figure.lost} onLost={figure.onLost} hub={hub} birth={birth} {...wearProps(pet.worn)} />}
      motion={s.away ? figure.toggle : figure.motion}
      bubble={bubbleReply ? <Bubble meta={bubbleReply.meta} receipt={bubbleReply.noVerify ? undefined : { href: `/pet/${tokenId}/verify/${bubbleReply.id}`, label: 'Check this thought' }}>{bubbleReply.text}</Bubble> : undefined}
      edge={asleep ? <Stack gap={1}>{label ? <Text variant="small">{`Good at ${label}`}</Text> : null}<Button variant="secondary" size="compact" icon="share" haspopup="dialog" onClick={openErrand}>Ask friends to fund an errand</Button></Stack>
        : pet.watch?.target || label ? <Stack gap={1}>{pet.watch?.target ? <Text variant="small" tone="secondary">{`Watching: ${pet.watch.target}`}</Text> : null}{label ? <Text variant="small">{`Good at ${label}`}</Text> : null}</Stack> : undefined}
      chat={<><Conversation intro={invitationCards ?? undefined}>{history}
        {auth.authenticated && !auth.sessionEnded ? pet.willActivity?.map((activity, index) => <Message key={`will-activity-${activity.at}-${index}`} from="event">{`${name} declined a request · ${activity.code}`}</Message>) : null}
        {auth.authenticated && !auth.sessionEnded && wishOutcome?.source === 'pet_wish' ? <Message from="event">{`${name} earned ${nameOf(wishOutcome.item) ?? wishOutcome.item}!`}</Message> : null}
        {s.failure ? <Message from="error" actions={s.failure.noRetry ? undefined : <Button variant="secondary" size="compact" onClick={s.retryThought}>Try again</Button>}>{s.failure.code === 'empty_paid' ? emptyPaidLine(name) : lostLine(name)}</Message> : null}
        {s.ownLost && !s.busy ? <OwnLostMessage name={name} worker={lastWorker} onTryAgain={s.finishHire} /> : null}
        {s.busy ? <Thinking id={s.away ? 'errand-away' : undefined} wait={s.waiting ? WAIT_LINE : undefined}>{s.away ? sentLine(name) : s.asking ? askingLine(name, s.asking) : `${name} is thinking${s.jobMode === 'deep' ? ' hard' : ''}…`}</Thinking> : null}
      </Conversation><Dock>{field}<Live>{live}</Live><Live>{bubbleReply?.fresh ? `${name}: ${bubbleReply.text}` : ''}</Live><Live alert>{signedOut ? signInLines.map((line) => line.text).join(' ') : ''}</Live></Dock></>}
      hotbar={<Hotbar items={stageActions.items} menu={stageActions.menu} active={auth.authenticated && !auth.sessionEnded}
        menuMessage={share.message || undefined} onMenuReset={share.clearMessage}
        shareItems={[{ icon: 'share', label: 'Share a thought', onClick: () => void share.openKind('thought') },
          { icon: 'share', label: 'Share growth', onClick: () => void share.openKind('growth') },
          { icon: 'share', label: 'Share outfit', onClick: () => void share.openKind('outfit') }]} />}
    /></Inert>
    {myPetsOpen ? <MyPetsSheet tokenId={tokenId} /> : null}
    <ErrandSheet name={name} errand={errand} asleep={asleep} inert={feedCover.open} onFeed={() => openFeed({ tokenId, name, label: name, elsewhere: false })} />
    <WatchSheet tokenId={tokenId} name={name} open={watchOpen} draft={watchDraft} onDraft={setWatchDraft} onClose={() => setWatchOpen(false)} tokenOf={s.tokenOf} onOwnerLost={s.reread} onChanged={s.reread} />
    <FeedLayer column pageFullness={pet.fullness} />
    <GiftSheet tokenId={tokenId} name={name} stage={pet.stage} worn={pet.worn} onGiven={s.reread} />
    {wishNode}
    <SkillSheet name={name} skill={skill} hasLabel={label !== null} onClose={skill.close} hidden={adapter.open || code.open}
      sockets={{ onConnect: () => adapter.openNew(), onSource: (source) => adapter.openSource(source), onCode: () => code.openSheet() }} />
    <AdapterSheet name={name} adapter={adapter} tokenId={tokenId} onClose={() => { adapter.close(); skill.close(); }} />
    <CodeSheet name={name} sheet={code} onClose={() => { code.close(); skill.close(); }} />
    {anchorCardOpen && profile.phase === 'loading' ? <PetCard name={name} onClose={profile.close} returnFocusTo={() => document.querySelector('.ds-hud__nameplate')} /> : null}
    {anchorCardOpen && (profile.phase === 'error' || profile.phase === 'ready') ? <ProfileCard pet={profile.pet?.viewer === 'owner'
      ? { ...profile.pet, hireMode: pet.hireMode } : pet}
      boughtByOwner={wishOutcome?.source === 'owner' ? wishOutcome.item : null}
      error={profile.phase === 'error'} seal={seal.state} onSealRetry={seal.retry} onRetry={() => void profile.open()} onClose={profile.close}
      onSkill={() => { profile.close(); void skill.open(); }} onMode={(mode) => { if (auth.needSession()) void s.setHireMode(mode); }}
      onWish={() => { profile.close(); wishSheet.open(); }} onFeed={() => { profile.close(); act('feed', () => document.querySelector<HTMLElement>('.ds-hud__nameplate')); }} /> : null}
    {share.sheet}
    <OldReserveNotice tokenId={tokenId} name={name} reserve={pet.oldSharedReserve} onReleased={s.reread} />
    <Live>{skillSaved ? skillSavedLine(name) : ''}</Live>
    {skillSaved ? <Toast icon="check" silent onDone={toastHeld() ? undefined : () => setSkillSaved(false)}>{skillSavedLine(name)}</Toast> : null}
    <Live>{adapterLine ?? ''}</Live>
    {adapterLine ? <Toast icon="check" silent onDone={toastHeld() ? undefined : () => setAdapterLine(null)}>{adapterLine}</Toast> : null}
  </Shell>;
}

/** A signed-in player who isn't the owner, or a visitor with no session: one centred column — the pet, its plate,
 *  «Check it's really {name}», the asleep line, then «Feed {name}» and what the viewer can do next. */
function OutsiderPage({ pet, s, seal, ownerChanged = false }: { pet: Exclude<PetView, { viewer: 'owner' }>;
  s: ReturnType<typeof usePetScreen>; seal: ReturnType<typeof useSeal>; ownerChanged?: boolean }) {
  const { tokenId, name } = pet;
  const figure = useFigure();
  const { begin } = useSignIn();
  const auth = useAuth();
  const readCard = useCallback(async () => {
    try { return await workerApi.pet(await s.tokenOf(), tokenId); }
    catch (error) { if (error instanceof WorkerError && error.status === 401) auth.endSession(true, true); throw error; }
  }, [s.tokenOf, tokenId, auth.endSession]);
  const viewerChanged = useCallback(() => s.reread(), [s.reread]);
  const profile = useProfileCard(readCard, 'public', viewerChanged, !auth.sessionEnded, pet);
  const anchorCardOpen = !auth.sessionEnded && profile.phase !== 'closed';
  const changedLine = ownerChanged || (pet.viewer === 'guest' && s.notice === FORMER_OWNER_LINE)
    ? `${name} has a new owner. You can still visit ${name}.` : '';
  const viewer: Viewer = pet.viewer;
  const asleep = pet.fullness.state === 'asleep';
  const ctx = { tokenId, name, viewer };
  const slot = { tokenId, name, viewer, asleep };
  const me = s.me;
  const home = me?.currentPet ?? null;
  // the label under the name, for every viewer, inert (`Skill rule` › «label on the pet's page»); none for a pet with no skill
  // the badge is always passed, as the frames do: with no skill it draws nothing, and the plate keeps the frames' spacing
  const skillBadge = <SkillBadge name={name} label={pet.skill?.label} />;
  // A former owner can hatch again: current ownership, not the historical birth pointer, decides the offer.
  const fresh = viewer === 'guest' && me !== null && me.ownedCount === 0;
  const former = fresh && (me?.lastGifted?.tokenId === tokenId || me?.hatched?.tokenId === tokenId);
  const cover = useFeedCover(tokenId);
  const giftRequest = useGiftRequest();
  const givenHere = giftRequest?.tokenId === tokenId && giftRequest.given === true;
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
      {s.notice && s.notice !== FORMER_OWNER_LINE ? (
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
    return <Shell accent={accentOf(tokenId)} fill header={<Inert on={anchorCardOpen || givenHere ? true : covered}>
      <Hud name={name} condition={pet.fullness.state} level={pet.fullness.state === 'hungry' ? pet.fullness.level : undefined}
        cardOpen={anchorCardOpen} onCard={() => { if (!auth.sessionEnded) void profile.open(); else auth.needSession(); }}
        routes={<Cluster gap={2} nowrap><Only on="desktop"><Button variant="ghost" size="compact" icon="pets" href={`/pet/${home.tokenId}`}>{`Go to your ${home.name}`}</Button></Only>
          <Only on="phone"><IconButton variant="secondary" icon="pets" label={`Go to your ${home.name}`} href={`/pet/${home.tokenId}`} /></Only><Account {...slot} /></Cluster>} />
    </Inert>}>
      <Heading level={1} hidden>{name}</Heading>
      {changedLine ? <Banner tone="info">{changedLine}</Banner> : null}
      <Live>{changedLine}</Live>
      <ConnectionBanner banner={s.banner} name={name} tryAgain={s.tryAgain} />
      <SealBanner name={name} seal={seal} />
      <Inert on={anchorCardOpen || givenHere ? true : covered}><Stage asleep={asleep}
        pet={<PetFigure tokenId={tokenId} name={name} state={state} stage={pet.stage} mood={asleep ? null : pet.mood} size="hero" lost={figure.lost} onLost={figure.onLost} hub={figure.hub} {...wearProps(pet.worn)} />}
        motion={figure.motion}
        edge={<Stack gap={1}>{pet.watch?.target ? <Text variant="small" tone="secondary">{`Watching: ${pet.watch.target}`}</Text> : null}
          {pet.skill?.label ? <Text variant="small">{`Good at ${pet.skill.label}`}</Text> : null}
          <TextLink href={`/pet/${tokenId}/verify`} tone="trust" icon="verify">{`Check it's really ${name}`}</TextLink></Stack>}
        // the Check link stands in the Stage's edge and the work record in the card: the log has no intro card here
        chat={<Slot slot="advice" {...slot} advice={{ ...advice, check: null }} />}
        hotbar={<Hotbar items={guestStageActions(name, cover.opener, () => { if (auth.needSession()) runAction('feed', ctx); })} />}
      /></Inert>
      <FeedLayer column pageFullness={pet.fullness} />
      {givenHere ? <GiftSheet tokenId={tokenId} name={name} stage={pet.stage} worn={pet.worn} onGiven={() => undefined} /> : null}
      {anchorCardOpen && profile.phase === 'loading' ? <PetCard name={name} onClose={profile.close} returnFocusTo={() => document.querySelector('.ds-hud__nameplate')} /> : null}
      {anchorCardOpen && (profile.phase === 'error' || profile.phase === 'ready') ? <ProfileCard pet={profile.pet ?? pet} error={profile.phase === 'error'}
        seal={seal.state} onSealRetry={seal.retry} onRetry={() => void profile.open()} onClose={profile.close} /> : null}
      {tail}
    </Shell>;
  }
  return <Shell accent={accentOf(tokenId)} fill header={<Inert on={anchorCardOpen || givenHere ? true : covered}>
    <Hud name={name} condition={pet.fullness.state} level={pet.fullness.state === 'hungry' ? pet.fullness.level : undefined}
      cardOpen={anchorCardOpen} onCard={() => { if (!auth.sessionEnded) void profile.open(); else auth.needSession(); }}
      routes={home ? <Cluster gap={2} nowrap><Only on="desktop"><Button variant="ghost" size="compact" icon="pets" href={`/pet/${home.tokenId}`}>{`Go to your ${home.name}`}</Button></Only>
        <Only on="phone"><IconButton variant="secondary" icon="pets" label={`Go to your ${home.name}`} href={`/pet/${home.tokenId}`} /></Only><Account {...slot} /></Cluster>
        : <Account {...slot} />} />
  </Inert>}>
    <Heading level={1} hidden>{name}</Heading>
    {changedLine ? <Banner tone="info">{changedLine}</Banner> : null}
    <Live>{changedLine}</Live>
    <ConnectionBanner banner={s.banner} name={name} tryAgain={s.tryAgain} />
    <SealBanner name={name} seal={seal} />
    <Inert on={anchorCardOpen || givenHere ? true : covered}><Stage asleep={asleep}
      pet={<PetFigure tokenId={tokenId} name={name} state={state} stage={pet.stage} mood={asleep ? null : pet.mood} size="hero" lost={figure.lost} onLost={figure.onLost} hub={figure.hub} {...wearProps(pet.worn)} />}
      motion={figure.motion}
      edge={<Stack gap={1}>{pet.watch?.target ? <Text variant="small" tone="secondary">{`Watching: ${pet.watch.target}`}</Text> : null}
        {pet.skill?.label ? <Text variant="small">{`Good at ${pet.skill.label}`}</Text> : null}
        <TextLink href={`/pet/${tokenId}/verify`} tone="trust" icon="verify">{`Check it's really ${name}`}</TextLink></Stack>}
      chat={<><Conversation label={`Advice from ${name}`}>{s.notice === FORMER_OWNER_LINE || former ? <Note>{FORMER_OWNER_LINE}</Note> : null}</Conversation>
        <Dock><Stack gap={2}>{asleep ? <Text>{asleepLine}</Text> : null}
          {viewer === 'visitor' ? <Button variant="secondary" onClick={() => begin('signin')}>Sign in</Button> : null}
          {fresh ? <Button variant="secondary" href={hatchPath(tokenId)}>Get your own pet</Button> : null}
          <SignInOutcome column unreachable={offlineLine(name)} /></Stack></Dock></>}
      hotbar={<Hotbar items={guestStageActions(name, cover.opener, () => {
        if (viewer === 'visitor') begin('feed'); else if (auth.needSession()) runAction('feed', ctx);
      })} />}
    /></Inert>
    <FeedLayer column pageFullness={pet.fullness} />
    {givenHere ? <GiftSheet tokenId={tokenId} name={name} stage={pet.stage} worn={pet.worn} onGiven={() => undefined} /> : null}
    {anchorCardOpen && profile.phase === 'loading' ? <PetCard name={name} onClose={profile.close} returnFocusTo={() => document.querySelector('.ds-hud__nameplate')} /> : null}
    {anchorCardOpen && (profile.phase === 'error' || profile.phase === 'ready') ? <ProfileCard pet={profile.pet ?? pet} error={profile.phase === 'error'}
      seal={seal.state} onSealRetry={seal.retry} onRetry={() => void profile.open()} onClose={profile.close} /> : null}
    {tail}
  </Shell>;
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
  experience,
  workRecord,
}: {
  s: ReturnType<typeof usePetScreen>;
  d: ReturnType<typeof useDiary>;
  w: ReturnType<typeof useWardrobe>;
  diary: boolean;
  wardrobe: boolean;
  experience: boolean;
  workRecord: boolean;
}) {
  const { page } = s;
  if (page.kind === 'loading') return <LoadingView tokenId={s.tokenId} />;
  if (page.kind === 'not_found') return <PetNotFound />;
  if (page.kind === 'unreachable') {
    return <EmptyPetStage line={page.busy ? BUSY : UNREACHABLE} tokenId={s.tokenId} action={<Button onClick={s.tryAgain}>Try again</Button>} />;
  }
  if (experience) return <ExperienceNotesPage pet={page.pet} tokenOf={s.tokenOf} reread={s.reread} />;
  if (workRecord) return <WorkRecordPage pet={page.pet} />;
  if (page.pet.viewer !== 'owner') return <SealPet pet={page.pet} s={s} />;
  if (wardrobe) return <WardrobeOwner pet={page.pet} w={w} s={s} />;
  return diary ? <DiaryOwner pet={page.pet} d={d} s={s} /> : <SealPet pet={page.pet} s={s} />;
}

/** `diary`: the address is the Diary's (`/pet/<token_id>/diary`). Its page is the owner's awake pet's; a guest or a visitor on it gets
 *  the Pet screen's page for them, the address kept; an asleep pet's address is the Pet screen (`Diary screen` › entry point). */
export function PetScreen({ tokenId, from, diary = false, wardrobe = false, experience = false, workRecord = false }: { tokenId: string; from: string | null; diary?: boolean; wardrobe?: boolean; experience?: boolean; workRecord?: boolean }) {
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
    wardrobe: standingWardrobe || experience || workRecord,
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
        <PetView s={s} d={d} w={w} diary={standing} wardrobe={standingWardrobe} experience={experience} workRecord={workRecord} />
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
