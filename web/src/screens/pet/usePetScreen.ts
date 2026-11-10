import { useCallback, useEffect, useRef, useState } from 'react';
import { hasVisible } from '../../lib/nameClean';
import { formatCents } from '../../lib/price';
import { onClearOutcome } from '../../account/clearMemory';
import { utcDayNow } from '../../diary/useDiary';
import { clearRiddleDrafts } from '../../diary/riddleDraft';
import { hostOf, watchFlight } from '../../feeding/feedFlight';
import { onFed } from '../../feeding/feedRequest';
import { clearedReportLine, emptyErrandLine, failureLine, nothingFoundLine, reportMeta, unclearLine } from '../../errands/lines';
import { useLocation } from '../../route';
import { useAuth } from '../../seams/auth';
import { takeReturnText } from '../../signin/returnPlace';
import {
  WorkerError,
  waitLineMs,
  workerApi,
  type ConversationLine,
  type ErrandForm,
  type ErrandState,
  type HireMode,
  type HireOffer,
  type JobKind,
  type Me,
  type PetState,
  type PetView,
  type Thought,
} from '../../seams/worker';
import { askedMeta, autoPaidLine, autoRefusedLine, hireClearedLine, hireDataFailedLine, hireDataFailedPaidLine, hireEmptyLine, hireFailedLine, hireRefusedLine, noFeeAnswerLine, offerLine, toLine } from '../../work/lines';
import { resetTime } from '../../lib/time';
import { peekPendingAction, runAction, takePendingAction } from './parts';

// The Pet screen's state (add-pet › Pet screen, Connection rule): what the page shows is chosen from the answer of
// `GET /api/pets/:id` — a viewer of `owner | guest | visitor` — and kept as the last known pet; a failed request after
// that is a banner over it, never a different page. The owner's page polls `GET …/state` every 5 s (1.5 s while a
// thought is on its way) and not while the tab is hidden; a guest's or a visitor's page looks at the pet again every 10 s,
// the same way (add-pet-life › Pet life data). The draft, the lines shown and the pet shown are the tab's
// memory (design.md › «Черновик реплики, показанный питомец…»): nothing here touches the browser's storage.
export type OwnerView = Extract<PetView, { viewer: 'owner' }>;

export type PetPage =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  /** nothing to show: the server or the network could not be read at the first load (`busy` — the 429) */
  | { kind: 'unreachable'; busy: boolean }
  | { kind: 'pet'; pet: PetView };

/** the connection line over the last known pet */
export type Banner = 'offline' | 'busy' | null;

/** The report of an errand as the log draws it (`Errand flow` › «report»): the find card under the pet's name. */
export interface ReportLine {
  form: ErrandForm;
  /** «True» / «False» as the stamp at the top; none for «Find out» and for «Unclear», whose line leads the card */
  verdict: 'True' | 'False' | null;
  /** the card's first line: «Unclear — …», or «… looked but found nothing solid on this.» */
  top: string | null;
  sources: Array<{ label: string; href: string | null }>;
  /** the exact price: «Read · 0.14¢», «3 searches · 1.42¢» */
  meta: string;
  /** the data sources that did not answer, and the skill's code when it did not, each a line under the words */
  missed: Array<string | { code: true }>;
  /** the claim of an «Is it true?» report, for the card the browser draws; null for the other forms */
  card: { claim: string; verdict: 'True' | 'False' | 'Unclear'; sources: number } | null;
}

export interface Line {
  id: string;
  who: 'player' | 'pet' | 'event' | 'worker' | 'error';
  text: string;
  previousOwner?: boolean;
  /** arrived while the screen is open: it rises in */
  fresh?: boolean;
  /** an errand's line made by this tab (the job of an errand that is away, the line of one that came back with nothing): a new
   *  read of the conversation leaves it in place */
  keep?: boolean;
  /** the errand's form above the job under «You» */
  kicker?: ErrandForm;
  /** a `pet` line that is an errand's report */
  report?: ReportLine;
  /** an `error` line that is an errand's: «Try again» opens Errand sheet with this form and job */
  retry?: { form: ErrandForm; job: string };
  /** an `error` line of a paid errand that came back with no report: what it cost, so the words follow the errand's end */
  paidCents?: number;
  /** the small line under a reply: «Thought hard · {price}», or «{name} asked {worker} · {price}» under a hire's answer */
  meta?: string;
  foot?: string;
  noVerify?: boolean;
  refusalId?: string;
  /** the note under a reply that stopped at one thought's limit — the reply is still the newest thing the pet said */
  cutNote?: boolean;
  /** the pet's own question to a worker, «To {worker}: …»: not the reply the turn waits for */
  question?: boolean;
  /** `worker`: whose words, and whether a private skill shaped them */
  worker?: { tokenId: string; name: string };
  skilled?: boolean;
  /** `worker`: the data sources its answer read (`Adapter call rule` › «hired answer line») */
  dataLabels?: string[];
}

/** One line of the server's conversation as lines of the screen (`Pet hire flow`: the pet's question to a worker, the worker's own
 *  words, the game's line of a hire that did not happen, the price under the answer). `fresh`: it rises in. */
export function lineOf(l: ConversationLine, name: string, fresh: boolean, before?: ConversationLine): Line[] {
  const text = l.text ?? '';
  switch (l.who) {
    case 'error':
      // a paid errand that came back with no report; «Try again» stands only under the one the owner's state still keeps (`loadLines`)
      return [{ id: l.id, who: 'error', text: emptyErrandLine(name, before?.kicker ?? 'find', l.priceCents ?? 0), fresh: fresh || undefined, paidCents: l.priceCents ?? 0 }];
    case 'worker':
      return [
        {
          id: l.id,
          who: 'worker',
          text,
          fresh,
          worker: { tokenId: l.worker?.tokenId ?? '', name: l.worker?.name ?? '' },
          skilled: l.skilled === true,
          ...(l.dataLabels && l.dataLabels.length > 0 ? { dataLabels: l.dataLabels } : {}),
          meta: l.hire ? askedMeta(name, l.hire) : undefined,
          foot: l.hire && 'noFee' in l.hire && l.hire.answerPriceCents != null ? noFeeAnswerLine(l.hire.worker, l.hire.answerPriceCents) : undefined,
        },
      ];
    case 'event': {
      if (l.code === 'gift') {
        const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(l.at));
        return [{ id: l.id, who: 'event', text: `${l.name ?? name} came to you as a gift on ${date}. The chats above are from before.`, fresh: fresh || undefined }];
      }
      if (!l.code) return [{ id: l.id, who: 'event', text, fresh: fresh || undefined }];
      const worker = l.worker?.name ?? '';
      const words =
        l.code === 'society_refused'
          ? l.hireMode === 'auto' ? autoRefusedLine(worker) : hireRefusedLine(worker, resetTime(l.refusalUntil))
          : l.code === 'character_refused' && l.refusal
            ? `${l.refusal.reason} ${name} will answer instead.`
          : l.code === 'hire_empty'
          ? hireEmptyLine(name, worker)
          : l.code === 'hire_data_failed'
            ? hireDataFailedLine(name, worker)
            : l.code === 'hire_data_failed_paid'
              ? hireDataFailedPaidLine(name, worker)
              : hireFailedLine(name, worker);
      return [{ id: l.id, who: l.code === 'society_refused' && l.hireMode === 'auto' ? 'pet' : 'event', text: words, fresh: fresh || undefined,
        noVerify: l.code === 'society_refused' && l.hireMode === 'auto',
        ...(l.code === 'character_refused' && l.refusal ? { refusalId: l.refusal.id } : {}) }];
    }
    case 'pet': {
      if (l.report) return [reportLineOf(l, name, fresh, before)];
      const said = l.hire && 'price' in l.hire && l.hire.mode === 'auto' ? `${text} ${autoPaidLine(l.hire.worker, l.hire.priceCents)}` : text;
      const lines = replyLines({ id: l.id, text: l.hireTo !== undefined ? toLine(l.hireTo, text) : said, cut: l.cut ?? null, priceCents: l.priceCents }, name, fresh);
      if (l.hireTo !== undefined) lines[0]!.question = true;
      if (l.hire) lines[0]!.meta = askedMeta(name, l.hire);
      if (l.hire && 'noFee' in l.hire && l.hire.answerPriceCents != null) lines[0]!.foot = noFeeAnswerLine(l.hire.worker, l.hire.answerPriceCents);
      return lines;
    }
    default:
      return [{ id: l.id, who: 'player', text, ...(l.kicker ? { kicker: l.kicker } : {}) }];
  }
}

/** An errand's report: the words, what it cites as links in new tabs, the verdict, the exact price. */
function reportLineOf(l: ConversationLine, name: string, fresh: boolean, before?: ConversationLine): Line {
  const r = l.report!;
  const stamp = r.verdict === 'true' ? 'True' : r.verdict === 'false' ? 'False' : null;
  // «Is it true?» without a verdict is «Unclear»: its line leads the card; a «Find out» that cites nothing says it found nothing solid
  const unclear = r.form === 'check' && stamp === null;
  const nothing = r.form === 'find' && r.sources.length === 0;
  return {
    id: l.id,
    who: 'pet',
    text: l.text ?? '',
    fresh: fresh || undefined,
    report: {
      form: r.form,
      verdict: stamp,
      top: unclear ? unclearLine(name) : nothing ? nothingFoundLine(name) : null,
      sources: r.sources.map((s) => ({ label: s.label, href: s.url ?? null })),
      meta: reportMeta(r.form, r.searches, r.priceCents),
      missed: r.missed,
      card: r.form === 'check' ? { claim: before?.text ?? '', verdict: stamp ?? 'Unclear', sources: r.sources.length } : null,
    },
  };
}

/** A thought that did not come: the player's line stays in the conversation under the line and «Try again»
 *  (`Connection rule` › «AI-провайдер недоступен», «пустой ответ за счёт питомца»). «Try again» depends on its `kind`:
 *  a reply goes again with its `text`, a greeting or a wake thought is asked for again. */
export interface Failure {
  code: 'ai_unavailable' | 'empty_paid';
  kind: JobKind;
  lineId?: string;
  text?: string;
  mode?: 'chat' | 'deep';
  /** the line was the answer to the question of this UTC day: «Try again» sends it as that answer */
  question?: number;
  /** the job was a tap on a hire (`Ask {worker}`, `No thanks`): the line it answers is already sent, so there is no «Try again» */
  noRetry?: true;
}

/** The Manual offer after it was answered (or went stale): its words stay in the conversation, tab memory, after the line that is
 *  the pet's question of that turn (`Pet hire flow` › «отказ в Manual», «offer goes stale»). */
export interface AnsweredOffer {
  id: string;
  text: string;
  /** the id of the line the card follows: the pet's question to the worker; null: the card stood with no question line yet */
  after: string | null;
}

/** A hire turn's marks (the tab's memory): the job that is one, so its end re-reads the conversation. */
type HireJobKind = 'hire' | 'decline' | 'finish';
const isHireKind = (kind: unknown): kind is HireJobKind => kind === 'hire' || kind === 'decline' || kind === 'finish';

/** The answer to the question of the day, on its way or landed, for the Diary to draw under the question until the diary itself
 *  holds the exchange. `day` null: adopted after a reload, of whatever day the diary shows. */
export interface Asked {
  day: number | null;
  text: string;
  reply: string | null;
}

export const POLL_IDLE_MS = 5000;
/** The line of a Pet screen that was the player's own a moment ago (`Will ownership rule` › «former owner opens»). */
export const FORMER_OWNER_LINE = 'This pet belongs to someone else now.';
export const POLL_JOB_MS = 1500;
/** A guest's or a visitor's page looks at the pet again this often (`Pet life data`: the face and the stage change on an open
 *  page «за секунды»); slower than the owner's, since a visitor's copy is up to 15 s old anyway */
export const POLL_GUEST_MS = 10_000;
/** `Conversation flow` › «долгий ответ»: no reply for 10 s */
export const WAIT_MS = 10_000;

/** A reply as lines of the conversation: the reply, and under a reply that stopped at the limit of one thought the
 *  note that says so (`Conversation flow` › «ответ оборван»). «Think hard» carries its exact price. */
export function replyLines(t: Pick<Thought, 'id' | 'text' | 'priceCents'> & { cut?: Thought['cut'] }, name: string, fresh: boolean): Line[] {
  const lines: Line[] = [
    { id: t.id, who: 'pet', text: t.text, fresh, meta: t.priceCents !== undefined ? `Thought hard · ${formatCents(t.priceCents)}` : undefined },
  ];
  if (t.cut === 'fuse') {
    lines.push({ id: `${t.id}:cut`, who: 'event', text: `That's as far as one thought goes. Ask ${name} to keep going.`, fresh, cutNote: true });
  }
  return lines;
}

const statusOf = (e: unknown) => (e instanceof WorkerError ? e.status : 0);

export function usePetScreen(tokenId: string, from: string | null, diary = false) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;

  const [page, setPage] = useState<PetPage>({ kind: 'loading' });
  const [banner, setBanner] = useState<Banner>(null);
  const [attempt, setAttempt] = useState(0);
  // null until the history is read
  const [lines, setLines] = useState<Line[] | null>(null);
  const [draft, setDraftState] = useState('');
  const [job, setJob] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // the owner's first line was sent in this tab: «Talk to {name}…» whatever the server still says
  const [spoke, setSpoke] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  // `me` read again: the advice column found the paying pet is not the player's (add-pet-work › Hire access data)
  const [meAttempt, setMeAttempt] = useState(0);
  // the text a sign-in from the ended-session line brought back to a guest's page: the advice column's field takes it, unsent
  const [carried, setCarried] = useState<string | null>(null);
  // the mode of the job on its way: «is thinking…» or «is thinking hard…»
  const [jobMode, setJobMode] = useState<'chat' | 'deep'>('chat');
  // no reply for 10 s: the line under the thinking line
  const [waiting, setWaiting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // the friend's pet this pet's birth came from: «Back to {friend_pet}»
  const [friend, setFriend] = useState<{ tokenId: string; name: string } | null>(null);
  // a line the screen says once, with a Toast: the pet was given away under a clear (`Memory deletion flow` › «уже не владелец»)
  const [notice, setNotice] = useState<string | null>(null);
  // An errand that came back with a block (`Errand flow` › «blocked after Send»): Errand sheet opens with this form and job. `n` so the
  // same words can come twice.
  const [reopen, setReopen] = useState<{ form: ErrandForm; job: string; n: number } | null>(null);
  // the answer to the question of the day: on its way or landed, until the Diary holds the exchange (`Daily ritual flow`)
  const [asked, setAsked] = useState<Asked | null>(null);
  // an answer to the question the thought refused: back in the Diary's field, with a count so the same words can come twice
  const [returned, setReturned] = useState<{ text: string; n: number } | null>(null);
  // the Diary is read again at once: a question's answer landed, or the server says the screen is behind
  const [nudge, setNudge] = useState(0);
  // The hire (add-pet-work › Pet hire flow), all of it the tab's memory: the offers answered (their words stay), the answer to the
  // offer on its way (the buttons are gone, the card's words stay), a price that rose (the card says so, with the buttons back), the
  // worker the pet is asking, and the own reply that did not come.
  const [answeredOffers, setAnsweredOffers] = useState<AnsweredOffer[]>([]);
  const [offerBusy, setOfferBusy] = useState(false);
  const [rose, setRose] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [ownLost, setOwnLost] = useState<{ turn: string } | null>(null);

  const pageRef = useRef(page);
  // what the player sent with the job on its way, to put it back in the field or retry it when the job is refused
  const sent = useRef<{ job: string; lineId: string; text: string; mode: 'chat' | 'deep'; question?: number } | null>(null);
  pageRef.current = page;
  const jobRef = useRef(job);
  jobRef.current = job;
  const draftRef = useRef(draft);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const retryRef = useRef<() => void>(() => undefined);
  const polling = useRef(false);
  // a look asked for while a poll is in flight: the poll began before what the look is for, so one more follows it
  const lookAgain = useRef(false);
  const greeted = useRef(false);
  const localLine = useRef(0);
  const sendingRef = useRef(false);
  // the conversation was read from the server at least once
  const historyRead = useRef(false);
  // lines of this tab the server does not hold yet: they outlive a new read of the conversation
  const unconfirmed = useRef(new Set<string>());
  // jobs whose outcome was taken: a poll that started before that must not pick them up again
  const finished = useRef(new Set<string>());
  // «{name} fell asleep.» stands for this sleep
  const sleepLined = useRef(false);
  // how many times the memory was cleared, as this page knows it: a poll that sees more has a clear of another tab to follow
  const epoch = useRef(0);
  // how many times a meal woke the pet, as this page knows it: sent with the poll, so a page learns of a wake that came after
  // it loaded and never replays an old one (`Sleep and wake flow` › «разбудил друг при открытой странице»)
  const wakes = useRef(0);
  // the job on its way is a hire turn (it asked a worker, or it answers an offer): its end re-reads the conversation, since the
  // question, the worker's words and the price are thoughts of the server the tab has not seen
  const hireJob = useRef<string | null>(null);
  // how many hires the batch settled, as this page knows it: a later number re-reads the conversation («· no fee» without a reload)
  const hiresSeen = useRef(0);
  // the offer standing at the last look: when it is gone its words stay as an answered one
  const offerSeen = useRef<HireOffer | null>(null);
  // The errand (add-pet-errands): the job of the one this tab sent (its outcome carries «memory cleared on the way»), the line this tab
  // drew for its job, the errand as the last look saw it (a change from `away` is its end), the failed one whose lines this page
  // drew or whose sheet it opened (a poll that sees it again does nothing), and the failed one a paid line's words follow.
  const errandJob = useRef<string | null>(null);
  const errandLine = useRef<string | null>(null);
  const errandSeen = useRef<ErrandState | null | undefined>(undefined);
  const errandShown = useRef<string | null>(null);
  const errandFailed = useRef<Extract<ErrandState, { state: 'failed' }> | null>(null);
  // the job and the line this page drew for a failed errand no thought holds (nothing was spent): gone with the failed errand
  const errandLocal = useRef<string[]>([]);
  // the line of an errand whose report a clear took on the way is drawn (from the state or from the job's outcome, whichever came
  // first): the other says it no second time
  const errandCleared = useRef(false);
  const awayRef = useRef(false);

  const setDraft = useCallback((text: string) => {
    draftRef.current = text;
    setDraftState(text);
  }, []);

  /** The job on its way, kept in the ref at once: a poll that starts before the next render must not read an outcome
   *  that was already taken. */
  const changeJob = useCallback((next: string | null) => {
    jobRef.current = next;
    setJob(next);
  }, []);

  /** The action did not happen: the line leaves the conversation and returns to the field (unless the player typed
   *  something new meanwhile). */
  const giveBack = useCallback(
    (lineId: string, text: string, question?: number) => {
      unconfirmed.current.delete(lineId);
      setLines((now) => (now ?? []).filter((l) => l.id !== lineId));
      if (question === undefined) {
        if (draftRef.current === '') setDraft(text);
      } else {
        // the answer to the question goes back to the Diary's field, not the Pet screen's
        setAsked(null);
        setReturned((r) => ({ text, n: (r?.n ?? 0) + 1 }));
      }
    },
    [setDraft],
  );

  /** A job the server has and this tab did not start (a reload, another tab, an answer that was lost): its thinking
   *  line and the player's own line come back, and a line that went after all leaves the field. */
  const adopt = useCallback(
    (view: Pick<PetState, 'pendingJob' | 'pendingMode' | 'pendingKind' | 'pendingText' | 'pendingQuestion' | 'pendingProgress'>) => {
      const job = view.pendingJob;
      if (!job || jobRef.current !== null || sendingRef.current || finished.current.has(job)) return;
      const mode = view.pendingMode ?? 'chat';
      changeJob(job);
      setJobMode(mode);
      // the turn asked a worker: the owner's line is the question's thought already, in the conversation the page reads
      if (view.pendingProgress) {
        hireJob.current = job;
        setSpoke(true);
        return;
      }
      const text = view.pendingKind === 'reply' ? view.pendingText : null;
      if (text === null) return;
      const id = `you-${(localLine.current += 1)}`;
      unconfirmed.current.add(id);
      setLines((now) => [...(now ?? []), { id, who: 'player', text, fresh: true }]);
      const question = view.pendingQuestion ? utcDayNow() : undefined;
      sent.current = { job, lineId: id, text, mode, question };
      if (question === undefined) {
        if (draftRef.current === text) setDraft('');
      } else {
        // the answer to the question: its place is the Diary's, under the question
        setAsked({ day: null, text, reply: null });
      }
      setSpoke(true);
    },
    [changeJob, setDraft],
  );

  const tokenOf = useCallback(async () => {
    const a = authRef.current;
    if (!a.authenticated) return null;
    const token = await a.getIdentityToken();
    // a token keeper with no token for a signed-in page: the session ended (`Session expiry flow`), as a `401` says it
    if (token === null) throw new WorkerError(401, 'signed_out');
    return token;
  }, []);

  /** One failure of a request: a dead address, a lost session, or the connection line. A `401` ends the session: the page
   *  stands as it is until a tap needs it — or, before anything was shown, is the visitor's at once. */
  const fail = useCallback((e: unknown, retry: () => void) => {
    const status = statusOf(e);
    retryRef.current = retry;
    if (status === 401) authRef.current.endSession(pageRef.current.kind === 'pet');
    else if (status === 404 && e instanceof WorkerError && e.code === 'no_pet') setPage({ kind: 'not_found' });
    else if (status === 403) setAttempt((a) => a + 1);
    else if (pageRef.current.kind === 'pet') setBanner(status === 429 ? 'busy' : 'offline');
    else setPage({ kind: 'unreachable', busy: status === 429 });
  }, []);

  // The pet: on load, when the sign-in changes, on «Try again».
  useEffect(() => {
    if (!auth.ready) {
      setPage((p) => (p.kind === 'pet' ? p : { kind: 'loading' }));
      return undefined;
    }
    let live = true;
    setPage((p) => (p.kind === 'pet' ? p : { kind: 'loading' }));
    void (async () => {
      try {
        const token = await tokenOf();
        const pet = await workerApi.pet(token, tokenId);
        if (!live) return;
        if (pageRef.current.kind === 'pet' && pageRef.current.pet.viewer === 'owner' && pet.viewer === 'guest') {
          setNotice((now) => now ?? FORMER_OWNER_LINE);
        }
        setPage({ kind: 'pet', pet });
        setBanner(null);
        if (pet.viewer === 'owner') {
          epoch.current = pet.memoryEpoch;
          wakes.current = pet.wakes;
          hiresSeen.current = pet.hiresSeen;
          adopt(pet);
        }
        // a meal or snack of this player's the server still holds for this pet (a reload, another tab): the tab watches its outcome,
        // so the page changes in seconds with no poll of its own (`Feeding transaction data` › «outcome with the sheet closed»)
        if (pet.viewer !== 'visitor' && pet.myFeed) {
          watchFlight(hostOf(authRef.current), {
            tokenId,
            id: pet.myFeed.id,
            source: pet.myFeed.source,
            wasAsleep: pet.fullness.state === 'asleep',
          });
        }
      } catch (e) {
        if (live) fail(e, () => setAttempt((a) => a + 1));
      }
    })();
    return () => {
      live = false;
    };
  }, [auth.ready, auth.authenticated, tokenId, attempt, tokenOf, fail, adopt]);

  const viewer = page.kind === 'pet' ? page.pet.viewer : null;
  const previousViewer = useRef<typeof viewer>(null);

  // What a guest can go to or be offered: their current pet, or «Get your own pet».
  useEffect(() => {
    if (viewer !== 'guest') {
      setMe(null);
      return undefined;
    }
    let live = true;
    void (async () => {
      try {
        const token = await tokenOf();
        const answer = await workerApi.me(token);
        if (live) setMe(answer);
      } catch {
        // no link to a pet of their own: the page stands without it
      }
    })();
    return () => {
      live = false;
    };
  }, [viewer, tokenOf, meAttempt]);

  // The friend's pet a newborn came from: «Back to {friend_pet}» (`Birth flow` › «пришёл по ссылке друга»).
  useEffect(() => {
    if (viewer !== 'owner' || from === null || from === tokenId) {
      setFriend(null);
      return undefined;
    }
    let live = true;
    void (async () => {
      try {
        const token = await tokenOf();
        const theirs = await workerApi.pet(token, from);
        if (live) setFriend({ tokenId: from, name: theirs.name });
      } catch {
        // no pet at that address: the player did not come from a friend's pet, no way back
      }
    })();
    return () => {
      live = false;
    };
  }, [viewer, from, tokenId, tokenOf]);

  /** Reads the conversation; the lines the server holds replace this tab's copy of them. Null when it could not. */
  const loadLines = useCallback(async (opts?: { fresh?: boolean }): Promise<ConversationLine[] | null> => {
    try {
      const token = await tokenOf();
      const history = await workerApi.conversation(token, tokenId);
      historyRead.current = true;
      const name = pageRef.current.kind === 'pet' ? pageRef.current.pet.name : '';
      // a line of a stage change this page did not hold before (the conversation was read already) came while it was open:
      // it rises in (`Growth flow` › «переход записан позже ответа»); on the first read, and after a clear, nothing is new.
      // The end of a hire turn reads it again, and everything the turn wrote that the page did not hold rises in.
      const known = new Set((linesRef.current ?? []).map((l) => l.id));
      const reread = linesRef.current !== null && linesRef.current.length > 0;
      const past = history.lines.flatMap((l, i): Line[] =>
        lineOf(l, name, l.who !== 'player' && !known.has(l.id) && ((reread && l.who === 'event') || (opts?.fresh === true && reread)), history.lines[i - 1])
          .map((line) => ({ ...line, previousOwner: l.previousOwner })),
      );
      // the newest paid errand that came back with nothing is the one the owner's state keeps for «Try again» (`Errand flow` › «failed
      // errand after a reload»): it says what it came to (a search that could not be reached and was paid for, a read the pet paid
      // for), not the generic words of the conversation's line, and it alone has «Try again» — an older one is history
      const failed = errandFailed.current;
      if (failed !== null && failed.priceCents !== undefined) {
        for (let i = past.length - 1; i >= 0; i -= 1) {
          if (past[i]!.paidCents === undefined) continue;
          const job = failed.job ?? (past[i - 1]?.who === 'player' ? past[i - 1]!.text : null);
          past[i] = { ...past[i]!, text: failureLine(name, { form: failed.form, reason: failed.reason, cents: failed.priceCents }), ...(job !== null ? { retry: { form: failed.form, job } } : {}) };
          break;
        }
      }
      const held = new Set(past.map((l) => l.id));
      setLines((now) => {
        // what happened in this tab while the history was on its way stays after it
        const mine = (now ?? []).filter((l) => !held.has(l.id) && (l.who === 'player' ? unconfirmed.current.has(l.id) : l.fresh || l.keep));
        return [...past, ...mine];
      });
      return history.lines;
    } catch (e) {
      fail(e, () => void loadLines());
      return null;
    }
  }, [tokenOf, tokenId, fail]);

  // The owner's conversation: read once the page is the owner's; gone with it when the pet is not theirs any more.
  useEffect(() => {
    if (viewer === 'owner') {
      if (!historyRead.current) void loadLines();
    } else {
      if (previousViewer.current === 'owner' && viewer === 'guest') {
        setDraft('');
        clearRiddleDrafts();
      }
      if (previousViewer.current === 'owner') setSpoke(false);
      setLines(null);
      changeJob(null);
      setFailure(null);
      sent.current = null;
      // the owner's hire (the offers answered, the reply lost, the worker asked) goes with the owner's page, and so does the errand
      errandJob.current = null;
      errandLine.current = null;
      errandSeen.current = undefined;
      errandShown.current = null;
      errandFailed.current = null;
      errandLocal.current = [];
      errandCleared.current = false;
      setReopen(null);
      hireJob.current = null;
      offerSeen.current = null;
      setAnsweredOffers([]);
      setOfferBusy(false);
      setRose(false);
      setAsking(null);
      setOwnLost(null);
      greeted.current = false;
      historyRead.current = false;
      unconfirmed.current.clear();
    }
    previousViewer.current = viewer;
  }, [viewer, loadLines, changeJob, setDraft]);

  const askWake = useCallback(async () => {
    try {
      const token = await tokenOf();
      const answer = await workerApi.retryWake(token, tokenId);
      if (answer.job) {
        changeJob(answer.job);
        setJobMode('chat');
      } else void loadLines();
    } catch (e) {
      fail(e, () => void askWake());
    }
  }, [tokenOf, tokenId, loadLines, fail, changeJob]);

  const askGreeting = useCallback(async () => {
    try {
      const token = await tokenOf();
      const answer = await workerApi.greeting(token, tokenId);
      if (answer.job) {
        changeJob(answer.job);
        setJobMode('chat');
      } else void loadLines();
    } catch (e) {
      greeted.current = false;
      fail(e, () => setAttempt((a) => a + 1));
    }
  }, [tokenOf, tokenId, loadLines, fail]);

  // The pet speaks first: a newborn with no line asks for its greeting (idempotent on the server). One ask per
  // page: a greeting that failed comes back through its own «Try again», never by itself.
  useEffect(() => {
    if (viewer !== 'owner' || lines === null || lines.length > 0 || job !== null || greeted.current || failure !== null) return;
    greeted.current = true;
    void askGreeting();
  }, [viewer, lines, job, failure, askGreeting]);

  /** The job's row is gone (cron removes finished jobs after a day): the conversation says how it ended. A line that
   *  never got an answer goes back to the field. */
  const jobGone = useCallback(async () => {
    const was = sent.current;
    sent.current = null;
    hireJob.current = null;
    setAsking(null);
    setOfferBusy(false);
    if (jobRef.current !== null) finished.current.add(jobRef.current);
    changeJob(null);
    if (was) unconfirmed.current.delete(was.lineId);
    const history = await loadLines();
    if (was && history && !history.some((l) => l.who === 'player' && l.text === was.text) && draftRef.current === '') setDraft(was.text);
  }, [changeJob, loadLines, setDraft]);

  /** The answer on its way and the lines of this page's own are over: the memory was cleared. The typed draft stays. */
  const forgetConversation = useCallback(() => {
    // a turn that asked a worker was on its way: its answer is lost with the rest, and the cleared conversation says so
    const hired = jobRef.current !== null && hireJob.current === jobRef.current;
    if (jobRef.current !== null) finished.current.add(jobRef.current);
    changeJob(null);
    sent.current = null;
    hireJob.current = null;
    unconfirmed.current.clear();
    // the job line of an errand that is away went with the conversation; the errand itself still ends or times out, and a failed
    // one kept for «Try again» is erased with the memory (`Errand flow` › «failed errand after a reload»)
    errandLine.current = null;
    errandFailed.current = null;
    errandLocal.current = [];
    setFailure(null);
    setAsked(null);
    setAnsweredOffers([]);
    setOfferBusy(false);
    setRose(false);
    setAsking(null);
    setOwnLost(null);
    offerSeen.current = null;
    // the pet doesn't speak first after a clear (`Memory deletion flow` › «стёр»)
    greeted.current = true;
    return hired;
  }, [changeJob]);

  /** The hire turn on its way is over, whatever it came to: its job, the line drawn for the owner's words (the conversation holds
   *  them now) and its marks are gone. */
  const endHire = useCallback(() => {
    const local = sent.current;
    if (local) unconfirmed.current.delete(local.lineId);
    sent.current = null;
    hireJob.current = null;
    changeJob(null);
    setAsking(null);
    setOfferBusy(false);
  }, [changeJob]);

  /** «{name}'s memory was cleared, so this answer wasn't kept…» in the cleared conversation (`Pet hire flow` › «hire memory cleared
   *  on the way»). */
  const hireClearedLineOf = useCallback((): Line => {
    const shown = pageRef.current.kind === 'pet' ? pageRef.current.pet.name : '';
    return { id: `event-${(localLine.current += 1)}`, who: 'event', text: hireClearedLine(shown), fresh: true };
  }, []);

  /** Takes the job line this tab drew for an errand out of the log: the conversation holds the job now, or the errand did not happen. */
  const dropErrandLine = useCallback(() => {
    const id = errandLine.current;
    errandLine.current = null;
    if (id === null) return;
    unconfirmed.current.delete(id);
    setLines((now) => (now ?? []).filter((l) => l.id !== id));
  }, []);

  /** The failed errand is gone (the next errand, «Try again» sent, in this tab or another): the job and the line this page drew for
   *  it go, and no line of the conversation has «Try again» any more (`Errand flow` › «failed errand after a reload»). */
  const dropFailedErrand = useCallback(() => {
    const local = errandLocal.current;
    errandLocal.current = [];
    for (const id of local) unconfirmed.current.delete(id);
    setLines((now) => {
      if (now === null || (local.length === 0 && !now.some((l) => l.retry))) return now;
      return now.filter((l) => !local.includes(l.id)).map((l) => (l.retry ? { ...l, retry: undefined } : l));
    });
  }, []);

  /** The job under «You» and the line a failed errand came back with, drawn by this page: nothing was spent, so no thought holds
   *  them (`Errand flow` › «not back in 3 minutes», «blocked after Send», `Read this flow`, `Find out flow`). */
  const drawFailedErrand = useCallback(
    (failed: Extract<ErrandState, { state: 'failed' }>, fresh: boolean) => {
      const job = failed.job;
      if (job === null) {
        dropErrandLine();
        return;
      }
      const shown = pageRef.current.kind === 'pet' ? pageRef.current.pet.name : '';
      let jobId = errandLine.current;
      if (jobId === null) {
        jobId = `errand-job-${(localLine.current += 1)}`;
        unconfirmed.current.add(jobId);
      }
      errandLine.current = null;
      const line: Line = {
        id: `errand-failed-${(localLine.current += 1)}`,
        who: 'error',
        text: failureLine(shown, { form: failed.form, reason: failed.reason }),
        keep: true,
        fresh: fresh || undefined,
        retry: { form: failed.form, job },
      };
      errandLocal.current = [jobId, line.id];
      const jobLine: Line = { id: jobId, who: 'player', text: job, kicker: failed.form, keep: true };
      setLines((now) => {
        const list = now ?? [];
        return [...(list.some((l) => l.id === jobId) ? list : [...list, jobLine]), line];
      });
    },
    [dropErrandLine],
  );

  /** «Send» went (`Errand flow` › «sent»): the job under «You» with its form, and the pet is away until the state says otherwise. */
  const errandSent = useCallback(
    (sent: { form: ErrandForm; job: string; id: string }) => {
      const away: ErrandState = { state: 'away', form: sent.form, job: sent.job, sentAt: Date.now() };
      errandJob.current = sent.id;
      errandShown.current = null;
      errandFailed.current = null;
      errandCleared.current = false;
      errandSeen.current = away;
      awayRef.current = true;
      setPage((p) => (p.kind === 'pet' && p.pet.viewer === 'owner' ? { kind: 'pet', pet: { ...p.pet, errand: away } } : p));
      dropErrandLine();
      dropFailedErrand();
      const id = `errand-job-${(localLine.current += 1)}`;
      unconfirmed.current.add(id);
      errandLine.current = id;
      setLines((now) => [...(now ?? []), { id, who: 'player', text: sent.job, kicker: sent.form, fresh: true, keep: true }]);
      setSpoke(true);
    },
    [dropErrandLine, dropFailedErrand],
  );

  /** Errand sheet closed. An errand that came back with a block opened it by itself; closed without a new «Send», the errand stays
   *  in the conversation like any other that came back without a report: its job and «Try again» (`Errand flow` › «blocked after
   *  Send», «failed errand after a reload»). */
  const errandSheetClosed = useCallback(() => {
    const failed = errandFailed.current;
    if (failed?.reason !== 'blocked' || errandLocal.current.length > 0) return;
    drawFailedErrand(failed, true);
  }, [drawFailedErrand]);

  /** «{name}'s memory was cleared while it was out…» in place of the report (`Errand flow` › «memory cleared on the way»). */
  const drawClearedReport = useCallback(
    (cents: number, fresh: boolean) => {
      dropErrandLine();
      const shown = pageRef.current.kind === 'pet' ? pageRef.current.pet.name : '';
      const id = `event-${(localLine.current += 1)}`;
      setLines((now) => [...(now ?? []), { id, who: 'event', text: clearedReportLine(shown, cents), fresh: fresh || undefined, keep: true }]);
    },
    [dropErrandLine],
  );

  /** What the errand came to, from the owner's state (`Errand flow`): the end of one that was away, one kept for «Try again», one a
   *  reload found away. */
  const settleErrand = useCallback(
    async (next: ErrandState | null) => {
      const before = errandSeen.current;
      errandSeen.current = next;
      errandFailed.current = next?.state === 'failed' ? next : null;
      awayRef.current = next?.state === 'away';
      // the failed errand this page drew is gone: the next errand, or «Try again» sent, in another tab
      if (next?.state !== 'failed' && before?.state === 'failed') dropFailedErrand();
      if (next?.state === 'done') {
        // a clear took the report on the way: the state says it to the first read that doesn't ask for the job (a reload's first look,
        // another tab's), and to every read that does until then; the job's own outcome says it too — the page says it once
        if (!errandCleared.current) {
          errandCleared.current = true;
          drawClearedReport(next.priceCents, before?.state === 'away');
        }
        return;
      }
      // a new errand (sent in another tab, or found by a first look): its end is still to come
      if (next?.state === 'away' && before?.state !== 'away') errandCleared.current = false;
      if (next?.state === 'failed') {
        const key = `${next.form}|${next.reason}|${next.job ?? ''}|${next.priceCents ?? ''}`;
        if (errandShown.current === key) return;
        errandShown.current = key;
        // another failed errand than the one drawn (sent and failed in another tab between two looks): the old one's lines go
        dropFailedErrand();
        if (next.reason === 'blocked' && before?.state === 'away') {
          // this page saw it go and nothing happened: Errand sheet opens with the form, the job and the first block (`blocked after
          // Send`); closed without a new «Send», the errand stays in the conversation (`errandSheetClosed`)
          dropErrandLine();
          const job = next.job;
          if (job !== null) setReopen((r) => ({ form: next.form, job, n: (r?.n ?? 0) + 1 }));
          return;
        }
        if (next.priceCents !== undefined) {
          // the pet paid: the conversation holds the job and its line
          dropErrandLine();
          await loadLines({ fresh: true });
          return;
        }
        // nothing was spent, so no thought holds the lines: this page draws the job and the line it came back with, a block found
        // on a first look too (a reload never opens the sheet by itself)
        drawFailedErrand(next, before?.state === 'away');
        return;
      }
      if (next?.state === 'away') {
        // a reload (or another tab) found the pet away: the job under «You» comes back from the state
        if (errandLine.current === null && next.job !== null && before === undefined) {
          const id = `errand-job-${(localLine.current += 1)}`;
          unconfirmed.current.add(id);
          errandLine.current = id;
          const text = next.job;
          setLines((now) => [...(now ?? []), { id, who: 'player', text, kicker: next.form, keep: true }]);
          setSpoke(true);
        }
        return;
      }
      if (before?.state === 'away') {
        // the pet is back with its report: the conversation holds the job and the report
        dropErrandLine();
        await loadLines({ fresh: true });
      }
    },
    [dropErrandLine, dropFailedErrand, drawFailedErrand, drawClearedReport, loadLines],
  );

  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const token = await tokenOf();
      const asked = jobRef.current ?? errandJob.current;
      const s: PetState = await workerApi.petState(token, tokenId, asked ?? undefined, wakes.current);
      const shown = pageRef.current.kind === 'pet' ? pageRef.current.pet.fullness.state : null;
      wakes.current = s.wakes;
      setBanner(null);
      setPage((p) =>
        p.kind === 'pet' && p.pet.viewer === 'owner'
          ? {
              kind: 'pet',
              pet: {
                ...p.pet,
                name: s.name,
                stage: s.stage,
                fullness: s.fullness,
                wish: s.wish ?? null,
                wishReserveYocto: s.wish?.reserveYocto ?? '0',
                wishActive: s.wish != null && s.wish.status !== 'paused',
                tired: s.tired,
                until: s.until,
                paused: s.paused,
                deepPrice: s.deepPrice,
                hello: s.hello,
                memoryEpoch: s.memoryEpoch,
                mood: s.mood,
                traits: s.traits,
                energy: s.energy,
                diaryUnread: s.diaryUnread,
                pendingQuestion: s.pendingQuestion,
                outfits: s.outfits,
                worn: s.worn,
                notices: s.notices,
                outfitPrice: s.outfitPrice,
                hireMode: s.hireMode,
                offer: s.offer,
                pendingProgress: s.pendingProgress,
                hiresSeen: s.hiresSeen,
                skill: s.skill,
                errand: s.errand ?? null,
              },
            }
          : p,
      );
      // another tab of the owner cleared the memory: nothing of the conversation stays on this page, and what the server holds
      // is read again; a poll that was on its way before this tab's own clear carries the older number and is not a change
      if (s.memoryEpoch > epoch.current) {
        epoch.current = s.memoryEpoch;
        const hired = forgetConversation();
        setLines(hired ? [hireClearedLineOf()] : []);
        void loadLines();
        // the errand's end the clear took comes once, and may come in this same answer: the cleared conversation says it
        if (s.errand?.state === 'done') await settleErrand(s.errand);
        return;
      }
      if (!historyRead.current) void loadLines();
      // the hires the batch settled since this page looked: a hire that the contract did not take reads «· no fee» with no reload
      if (s.hiresSeen !== hiresSeen.current) {
        hiresSeen.current = s.hiresSeen;
        if (historyRead.current) void loadLines();
      }
      // The errand's job ended: its outcome is a report, or why none came. What the errand came to is read from the state; a clear
      // that landed while the pet was out (`Errand flow` › «memory cleared on the way») is the state's `done` too, once, to the first
      // read — the job's outcome says it only when that read was another tab's, never a second time on this page.
      if (errandJob.current !== null && asked === errandJob.current && (s.code !== undefined || s.thought !== undefined)) {
        finished.current.add(asked);
        errandJob.current = null;
        const price = s.price;
        if (s.code === 'memory_cleared' && price && s.errand?.state !== 'done' && !errandCleared.current) {
          errandCleared.current = true;
          drawClearedReport(price.cents, true);
        }
      }
      await settleErrand(s.errand ?? null);
      // the outcome belongs to the job this request asked about; a job that ended meanwhile is not read twice
      const mine = asked !== null && jobRef.current === asked;
      // the turn asked a worker (it says so while it asks, and a tap on a hire is one): the conversation holds its question and the
      // worker's words, so the line this tab drew for the owner's words gives way to what the server holds
      // An Auto hire refused for the pair's break asks no worker (nothing to show while it runs): the job's end tells it, and the
      // refusal line is a thought of the server the tab has not seen (`Society hire flow` › «auto hire refused»)
      const refusedForBreak = s.events.some((event) => event.startsWith('society_refused:'));
      if (mine && (s.pendingProgress || isHireKind(s.jobKind) || refusedForBreak) && hireJob.current !== asked) {
        hireJob.current = asked;
        const local = sent.current?.job === asked ? sent.current : null;
        if (local) {
          unconfirmed.current.delete(local.lineId);
          setLines((now) => (now ?? []).filter((l) => l.id !== local.lineId));
        }
        void loadLines({ fresh: true });
      }
      const hired = mine && hireJob.current === asked;
      const thought = mine ? s.thought : undefined;
      if (thought && hired) {
        finished.current.add(asked!);
        endHire();
        setFailure(null);
        await loadLines({ fresh: true });
      } else if (thought) {
        const local = sent.current;
        if (local) unconfirmed.current.delete(local.lineId);
        finished.current.add(asked!);
        if (local?.question !== undefined) {
          // the pet's reply stands under the question at once; the Diary holds the exchange a moment later
          setAsked((a) => (a ? { ...a, reply: thought.text } : a));
          setNudge((n) => n + 1);
        }
        setLines((now) => {
          const list = now ?? [];
          // the history read meanwhile already holds it, the player's line with it
          if (list.some((l) => l.id === thought.id)) return list.filter((l) => l.id !== local?.lineId);
          return [...list, ...replyLines(thought, s.name, true)];
        });
        changeJob(null);
        setFailure(null);
        sent.current = null;
      } else if (mine && (s.code === 'offer' || s.code === 'price_rose' || s.code === 'own_lost')) {
        // a hire turn ended without the pet's own reply: on a Manual offer, a price that rose past the offer's, or an own reply that
        // was lost after the worker answered (`own_lost` comes with this tab's own job only: a reload shows the line and no button)
        finished.current.add(asked!);
        endHire();
        setFailure(null);
        setRose(s.code === 'price_rose');
        setOwnLost(s.code === 'own_lost' && s.ownLost ? s.ownLost : null);
        await loadLines({ fresh: true });
      } else if (mine && s.code) {
        const code = s.code;
        const was = sent.current?.job === asked ? sent.current : null;
        sent.current = null;
        finished.current.add(asked!);
        changeJob(null);
        hireJob.current = null;
        setAsking(null);
        setOfferBusy(false);
        if (code === 'ai_unavailable' || code === 'empty_paid') {
          // the player's line stays in the conversation; a greeting or a wake thought has none
          const kind = s.jobKind === 'wake' || s.jobKind === 'greeting' ? s.jobKind : was || isHireKind(s.jobKind) ? 'reply' : 'greeting';
          setFailure({ code, kind, lineId: was?.lineId, text: was?.text, mode: was?.mode, question: was?.question, ...(isHireKind(s.jobKind) ? { noRetry: true as const } : {}) });
        } else if (code === 'memory_cleared') {
          // the memory was cleared while the answer was on its way: its line never lands and the player's own line is gone with
          // the rest; the conversation is read again (`Memory deletion data` › «ответ в пути»). A turn that asked a worker says so.
          if (was) {
            unconfirmed.current.delete(was.lineId);
            setLines((now) => (now ?? []).filter((l) => l.id !== was.lineId));
          }
          if (hired) setLines((now) => [...(now ?? []), hireClearedLineOf()]);
          setAsked(null);
          void loadLines();
        } else if (was) {
          // asleep, tired, too hungry, paused, no network: nothing happened — the line goes back to the field
          giveBack(was.lineId, was.text, was.question);
          if (code === 'chain_unreachable') {
            retryRef.current = () => void poll();
            setBanner('offline');
          }
        }
      }
      // the food ran out, after a thought or in the night's diary: the line follows it (`Sleep and wake flow` › «Засыпает»)
      if (s.fullness.state !== 'asleep') sleepLined.current = false;
      const fellAsleep = s.events.includes('fell_asleep') || (s.fullness.state === 'asleep' && shown !== null && shown !== 'asleep');
      if (fellAsleep && !sleepLined.current) {
        sleepLined.current = true;
        const id = `event-${(localLine.current += 1)}`;
        setLines((now) => [...(now ?? []), { id, who: 'event', text: `${s.name} fell asleep.`, fresh: true }]);
      }
      // a meal woke the pet while the page was open: who fed it; its first thought is the job on its way, below
      if (s.events.includes('woke') && s.friend) {
        const id = `event-${(localLine.current += 1)}`;
        setLines((now) => [...(now ?? []), { id, who: 'event', text: `${s.friend} fed ${s.name}.`, fresh: true }]);
      }
      // a thought this tab did not start: the one on its way, or one that came and went between two looks
      adopt(s);
      if (s.lastThought && jobRef.current === null && historyRead.current && !linesRef.current?.some((l) => l.id === s.lastThought)) void loadLines();
    } catch (e) {
      if (e instanceof WorkerError && e.code === 'no_job' && errandJob.current !== null && jobRef.current === null) {
        // the errand's job row is gone: the state says how it ended
        errandJob.current = null;
      } else if (e instanceof WorkerError && e.code === 'no_job') void jobGone();
      else fail(e, () => void poll());
    } finally {
      polling.current = false;
      if (lookAgain.current) {
        lookAgain.current = false;
        void poll();
      }
    }
  }, [tokenOf, tokenId, loadLines, fail, giveBack, adopt, jobGone, changeJob, forgetConversation, endHire, hireClearedLineOf, settleErrand]);

  /** A read the screen asks for because the pet's own view moved (an item worn): a poll in flight does not stand in for it. */
  const lookNow = useCallback(async () => {
    if (polling.current) {
      lookAgain.current = true;
      return;
    }
    await poll();
  }, [poll]);

  // The owner's page is kept current — food from a friend, the pause lifting, 00:00 UTC — and a thought's answer is
  // fetched; a hidden tab asks nothing, a tab that comes back asks at once.
  // An ended session stops the polls: no new data loads, and the page stands as it was (`Session expiry flow`).
  const ended = auth.sessionEnded;
  // the pet is off on an errand: the page looks as often as for a thought on its way (`Errand flow`)
  const away = page.kind === 'pet' && page.pet.viewer === 'owner' && page.pet.errand?.state === 'away';
  // The errand is not in the pet's own view, only in the state: the first look comes at once, so a reload finds the pet away (or back
  // with the line it came back with) without waiting for the poll.
  const pollNow = useRef(poll);
  pollNow.current = poll;
  useEffect(() => {
    if (viewer === 'owner' && !ended) void pollNow.current();
  }, [viewer, ended]);
  useEffect(() => {
    if (viewer !== 'owner' || ended) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) void poll();
    }, job || away ? POLL_JOB_MS : POLL_IDLE_MS);
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [viewer, ended, job, away, poll]);

  // A guest's or a visitor's page looks at the pet again — the face of the day, the stage, the fullness — in the same
  // places: not in a hidden tab, at once on return, not after the session ended. A pet that is now this player's own
  // reloads the page as the owner's.
  const looking = useRef(false);
  const look = useCallback(async () => {
    if (looking.current) return;
    looking.current = true;
    try {
      const token = await tokenOf();
      const view = await workerApi.pet(token, tokenId);
      if (view.viewer === 'owner') {
        setAttempt((a) => a + 1);
        return;
      }
      setBanner(null);
      setPage((p) => (p.kind === 'pet' && p.pet.viewer !== 'owner' ? { kind: 'pet', pet: view } : p));
    } catch (e) {
      fail(e, () => void look());
    } finally {
      looking.current = false;
    }
  }, [tokenOf, tokenId, fail]);

  useEffect(() => {
    if ((viewer !== 'guest' && viewer !== 'visitor') || ended) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) void look();
    }, POLL_GUEST_MS);
    const onVisible = () => {
      if (!document.hidden) void look();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [viewer, ended, look]);

  /** «Send» / Enter (`chat`) or «Think hard» (`deep`): the player's line goes into the conversation at once, the
   *  reply comes by the job. */
  const send = useCallback(
    async (raw: string, mode: 'chat' | 'deep' = 'chat', question?: number) => {
      const text = raw;
      // nothing is sent while the pet is away on an errand: the Composer is busy, and a stale tab's line stops here (`Errand flow` › «sent»)
      if (!hasVisible(text) || jobRef.current !== null || sendingRef.current || awayRef.current || pageRef.current.kind !== 'pet') return;
      // a session that ended: the line, nothing sent, the text stays in the field
      if (!authRef.current.needSession()) return;
      const id = `you-${(localLine.current += 1)}`;
      sendingRef.current = true;
      setSending(true);
      setFailure(null);
      // a new line ends the chance of «Try again» for a lost own reply, and a Manual offer standing is declined by the line that came
      // instead (`Pet hire flow` › «отказ в Manual»): its buttons go, the pet answers its old line first
      setOwnLost(null);
      setRose(false);
      const offerStanding = question === undefined && pageRef.current.kind === 'pet' && pageRef.current.pet.viewer === 'owner' && pageRef.current.pet.offer !== null;
      if (offerStanding) setOfferBusy(true);
      setJobMode(mode);
      unconfirmed.current.add(id);
      setLines((now) => [...(now ?? []), { id, who: 'player', text, fresh: true }]);
      // «Try again» sends a line that is not the field's: what the player typed since stays there. The question's answer comes
      // from the Diary's own field, which the Diary empties itself.
      if (question === undefined) {
        if (raw === draftRef.current) setDraft('');
      } else {
        setAsked({ day: question, text, reply: null });
      }
      setSpoke(true);
      try {
        const token = await tokenOf();
        const answer = question === undefined ? await workerApi.say(token, tokenId, text, mode) : await workerApi.answerQuestion(token, tokenId, { text, day: question });
        sent.current = { job: answer.job, lineId: id, text, mode, question };
        if (offerStanding) hireJob.current = answer.job;
        changeJob(answer.job);
        setBanner(null);
      } catch (e) {
        setOfferBusy(false);
        if (statusOf(e) === 401) {
          // the session ended under this tap: the same line as when it had ended before; nothing was sent, the text is back
          giveBack(id, text, question);
          authRef.current.endSession(true, true);
          return;
        }
        if (question !== undefined) {
          const refusal = e instanceof WorkerError && e.status === 409 ? e.code : null;
          if (refusal === 'already') {
            // a stale tab: the answer is taken, here or in another tab; the line leaves, the field goes with its text, the screen
            // catches up (`Daily ritual flow` › «отвечает на вопрос дня»)
            unconfirmed.current.delete(id);
            setLines((now) => (now ?? []).filter((l) => l.id !== id));
            setAsked(null);
            setNudge((n) => n + 1);
          } else {
            giveBack(id, text, question);
            if (refusal === 'paused') {
              setPage((p) => (p.kind === 'pet' && p.pet.viewer === 'owner' ? { kind: 'pet', pet: { ...p.pet, paused: true } } : p));
            } else if (refusal !== null) {
              // `late` or `no_question`: the day moved on, or the entry is gone; the Diary reads itself again
              setNudge((n) => n + 1);
            } else {
              fail(e, () => setNudge((n) => n + 1));
            }
          }
          return;
        }
        if (draftRef.current === '') {
          // the action did not happen: the line leaves the conversation and stays in the field
          giveBack(id, text);
        } else {
          // the field holds something newer: the line keeps its place and its «Try again»
          setFailure({ code: 'ai_unavailable', kind: 'reply', lineId: id, text, mode });
        }
        if (e instanceof WorkerError && e.status === 409 && e.code === 'paused') {
          // chatting is paused on our side: the screen says so until the next look sees the pause lifted
          setPage((p) => (p.kind === 'pet' && p.pet.viewer === 'owner' ? { kind: 'pet', pet: { ...p.pet, paused: true } } : p));
        } else {
          fail(e, () => void send(draftRef.current, mode));
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [tokenOf, tokenId, fail, giveBack, setDraft, changeJob],
  );

  /** The owner's tap on a hire: the job it queued is the thing the page waits for, like a line's. */
  const startHire = useCallback(
    async (ask: (token: string | null) => Promise<{ job: string }>, worker: string | null) => {
      if (jobRef.current !== null || sendingRef.current || pageRef.current.kind !== 'pet') return;
      // a session that ended: the line, nothing sent
      if (!authRef.current.needSession()) return;
      setOfferBusy(true);
      setRose(false);
      setOwnLost(null);
      setAsking(worker);
      setJobMode('chat');
      // the buttons are gone: the focus goes to the input (DS › Message › Keyboard)
      document.querySelector<HTMLTextAreaElement>('.ds-composer__field')?.focus();
      sendingRef.current = true;
      setSending(true);
      try {
        const answer = await ask(await tokenOf());
        hireJob.current = answer.job;
        changeJob(answer.job);
        setBanner(null);
      } catch (e) {
        setOfferBusy(false);
        setAsking(null);
        if (statusOf(e) === 401) {
          authRef.current.endSession(true, true);
        } else if (e instanceof WorkerError && e.status === 409 && e.code === 'paused') {
          setPage((p) => (p.kind === 'pet' && p.pet.viewer === 'owner' ? { kind: 'pet', pet: { ...p.pet, paused: true } } : p));
        } else if (e instanceof WorkerError && e.status === 409) {
          // the offer or the lost reply is gone (another tab answered it, the pet fell asleep): the page reads it again
          void poll();
        } else {
          fail(e, () => void startHire(ask, worker));
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [tokenOf, fail, changeJob, poll],
  );

  /** «Ask {worker}» on the Manual offer, at the price the card names. */
  const askOffer = useCallback(() => {
    const p = pageRef.current;
    const offer = p.kind === 'pet' && p.pet.viewer === 'owner' ? p.pet.offer : null;
    if (offer === null) return;
    void startHire((token) => workerApi.askOffer(token, tokenId, offer.price.yocto), offer.worker);
  }, [startHire, tokenId]);

  /** «No thanks»: the pet answers on its own. */
  const declineOffer = useCallback(() => void startHire((token) => workerApi.declineOffer(token, tokenId), null), [startHire, tokenId]);

  /** «Try again» under a lost own reply: the own reply only, no new fee. */
  const finishHire = useCallback(() => void startHire((token) => workerApi.finishHire(token, tokenId), null), [startHire, tokenId]);

  /** The switch of the hiring mode: the page shows the new mode at once; a refusal puts the old one back (`Hire mode rule`). */
  const setHireMode = useCallback(
    async (mode: HireMode) => {
      const p = pageRef.current;
      if (p.kind !== 'pet' || p.pet.viewer !== 'owner' || p.pet.hireMode === mode) return;
      if (!authRef.current.needSession()) return;
      const before = p.pet.hireMode;
      const show = (m: HireMode) => setPage((now) => (now.kind === 'pet' && now.pet.viewer === 'owner' ? { kind: 'pet', pet: { ...now.pet, hireMode: m } } : now));
      show(mode);
      try {
        await workerApi.setHireMode(await tokenOf(), tokenId, mode);
      } catch (e) {
        show(before);
        if (statusOf(e) === 401) authRef.current.endSession(true, true);
        else if (e instanceof WorkerError && e.status === 409) void poll();
        else fail(e, () => void setHireMode(mode));
      }
    },
    [tokenOf, tokenId, fail, poll],
  );

  // The Manual offer after it was answered (or went stale): its words stay, after the pet's question of that turn. They are the tab's
  // memory — a reload shows the question and the pet's reply only.
  const standing = page.kind === 'pet' && page.pet.viewer === 'owner' ? page.pet.offer : null;
  useEffect(() => {
    const before = offerSeen.current;
    offerSeen.current = standing;
    if (before === null || standing !== null) return;
    const shown = pageRef.current.kind === 'pet' ? pageRef.current.pet.name : '';
    const questions = (linesRef.current ?? []).filter((l) => l.question);
    const after = questions.at(-1)?.id ?? null;
    setAnsweredOffers((now) => [...now, { id: `offer-${(localLine.current += 1)}`, text: offerLine(shown, before.worker, before.price.cents), after }]);
    setOfferBusy(false);
    setRose(false);
    // the focus was on a button that is gone: it goes to the input
    if (document.activeElement === document.body) document.querySelector<HTMLTextAreaElement>('.ds-composer__field')?.focus();
  }, [standing]);

  // No reply for 10 s: the waiting line joins the thinking line (`Conversation flow` › «долгий ответ»).
  useEffect(() => {
    setWaiting(false);
    if (job === null) return undefined;
    const timer = setTimeout(() => setWaiting(true), waitLineMs(WAIT_MS));
    return () => clearTimeout(timer);
  }, [job]);

  /** «Try again» under a thought that did not come: the same line again; a greeting or a wake thought is asked for again. */
  const retryThought = useCallback(() => {
    const f = failure;
    if (!f) return;
    setFailure(null);
    if (f.kind === 'greeting') {
      void askGreeting();
      return;
    }
    if (f.kind === 'wake') {
      void askWake();
      return;
    }
    if (f.text === undefined) return;
    if (f.lineId) unconfirmed.current.delete(f.lineId);
    setLines((now) => (now ?? []).filter((l) => l.id !== f.lineId));
    void send(f.text, f.mode, f.question);
  }, [failure, askGreeting, askWake, send]);

  const tryAgain = useCallback(() => retryRef.current(), []);
  /** Reads the pet again: the Diary met a `403`, so the pet may be someone else's now. */
  const reread = useCallback(() => setAttempt((a) => a + 1), []);

  // The outcome of the Clear memory dialog, which stands beside the page: «стёр» empties the conversation under the event line;
  // «уже не владелец» reads the pet again, now a guest's page, with the line (`Memory deletion flow`).
  useEffect(
    () =>
      onClearOutcome((o) => {
        if (o.tokenId !== tokenId) return;
        const shown = pageRef.current.kind === 'pet' ? pageRef.current.pet.name : '';
        if (o.result === 'not_owner') {
          setNotice(`${shown} belongs to a new owner now, so nothing was erased.`);
          setAttempt((a) => a + 1);
          return;
        }
        // a hire turn on its way is lost with the rest, and the cleared conversation says so after the fresh start
        const hired = forgetConversation();
        epoch.current += 1;
        // the entry is erased: a Diary that waited to open has nothing to open (`Daily ritual flow` › «сначала действие»)
        setPage((p) => (p.kind === 'pet' && p.pet.viewer === 'owner' ? { kind: 'pet', pet: { ...p.pet, diaryUnread: false, pendingQuestion: false } } : p));
        const id = `event-${(localLine.current += 1)}`;
        setLines([{ id, who: 'event', text: o.result === 'cleared_retry' ? "Memory cleared. This job's food is still reserved while we retry closing it." : o.hadExperience ? 'Experience notes cleared. Public work history remains.' : `${shown}'s memory is clear — same ${shown}, fresh start.`, fresh: true }, ...(hired ? [hireClearedLineOf()] : [])]);
      }),
    [tokenId, forgetConversation, hireClearedLineOf],
  );
  const clearNotice = useCallback(() => setNotice(null), []);
  const clearAsked = useCallback(() => setAsked(null), []);

  // Feed sheet beside the page: each answer of the open sheet carries the pet's fullness, and the plate shows the same one as the
  // sheet's head — also on a guest's page, which has no poll (`Feed sheet screen` › «лист обновляется сам»).
  useEffect(
    () =>
      onFed((event) => {
        if (event.tokenId !== tokenId) return;
        if (event.kind === 'fed') {
          // a meal was confirmed, the sheet open or not: the owner's page reads the pet at once, a guest's reads it once; the
          // fullness or the wake shows, with no message (`Feeding outcome rule` › «closed on its way»)
          if (pageRef.current.kind !== 'pet') return;
          if (pageRef.current.pet.viewer === 'owner') {
            void poll();
          } else {
            void (async () => {
              try {
                const view = await workerApi.pet(await tokenOf(), tokenId);
                setPage((p) => (p.kind === 'pet' && p.pet.viewer !== 'owner' ? { kind: 'pet', pet: view } : p));
              } catch {
                // the page stands as it was; the next look at it reads again
              }
            })();
          }
          return;
        }
        setPage((p) => {
          if (p.kind !== 'pet') return p;
          const shown = p.pet.fullness;
          if (shown.state === event.fullness.state && shown.level === event.fullness.level) return p;
          return { kind: 'pet', pet: { ...p.pet, fullness: event.fullness } };
        });
      }),
    [tokenId, poll, tokenOf],
  );

  // The text of a sign-in from the ended-session line, handed back to this address once its view is decided: the owner's field
  // takes it, unsent; a screen with no such field (the pet was given away, a dead link) takes it and drops it unseen
  // (`Session expiry flow` › `typed text after sign-in`, `Sign-in return data`).
  const here = useLocation();
  const decided = page.kind === 'pet' || page.kind === 'not_found';
  const ownerNow = viewer === 'owner';
  useEffect(() => {
    if (!decided) return;
    // the owner's text on the Diary's address is the Diary's question draft: its own hook takes it
    if (diary && ownerNow) return;
    const text = takeReturnText(here);
    if (text !== null && ownerNow) setDraft(text);
    else if (text !== null && viewer === 'guest') setCarried(text);
  }, [decided, ownerNow, viewer, here, setDraft, diary]);

  // Back from the sign-in with «Feed {name}» tapped: the feeding change takes the action, as the owner or as a guest.
  const pet = page.kind === 'pet' ? page.pet : null;
  useEffect(() => {
    if (!pet || pet.viewer === 'visitor') return;
    // the owner's page takes `skill` itself: Skill sheet opens again there
    if (peekPendingAction() === 'feed' && takePendingAction() === 'feed') runAction('feed', { tokenId, name: pet.name, viewer: pet.viewer });
  }, [pet?.viewer, pet?.name, tokenId]);

  return {
    tokenId,
    page,
    banner,
    lines,
    draft,
    setDraft,
    job,
    jobMode,
    waiting,
    failure,
    friend,
    busy: job !== null || sending || away,
    /** the pet is off on an errand: the stage is empty, the thinking line says so, the rail's errand item is off */
    away,
    errandSent,
    errandSheetClosed,
    /** an errand came back with a block: Errand sheet opens with this form and job */
    reopen,
    clearReopen: useCallback(() => setReopen(null), []),
    spoke,
    me,
    /** the advice column's seams with this page: a token, the connection line, `me` read again, the text a sign-in brought back */
    tokenOf,
    report: fail,
    refreshMe: useCallback(() => setMeAttempt((a) => a + 1), []),
    carried,
    takeCarried: useCallback(() => setCarried(null), []),
    send,
    retryThought,
    tryAgain,
    reread,
    notice,
    clearNotice,
    asked,
    clearAsked,
    returned,
    nudge,
    /** reads the pet's condition now (the Diary met a riddle answer the pet being asleep refused) */
    look: lookNow,
    // the hire (add-pet-work › Pet hire flow)
    /** the worker the turn on its way asks: «{name} is asking {worker}…» in place of «is thinking…» */
    asking: job !== null || sending ? (pet?.viewer === 'owner' ? pet.pendingProgress?.asking : undefined) ?? asking : null,
    answeredOffers,
    /** the card's buttons: gone while an answer to the offer is on its way */
    offerBusy,
    /** the card names a price that rose: «{worker} is busier now…» */
    rose,
    ownLost,
    askOffer,
    declineOffer,
    finishHire,
    setHireMode,
  };
}
