import { useCallback, useEffect, useRef, useState } from 'react';
import { hasVisible } from '../../lib/nameClean';
import { formatCents } from '../../lib/price';
import { onClearOutcome } from '../../account/clearMemory';
import { hostOf, watchFlight } from '../../feeding/feedFlight';
import { onFed } from '../../feeding/feedRequest';
import { useLocation } from '../../route';
import { useAuth } from '../../seams/auth';
import { takeReturnText } from '../../signin/returnPlace';
import { WorkerError, waitLineMs, workerApi, type ConversationLine, type JobKind, type Me, type PetState, type PetView, type Thought } from '../../seams/worker';
import { runAction, takePendingAction } from './parts';

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

export interface Line {
  id: string;
  who: 'player' | 'pet' | 'event';
  text: string;
  /** arrived while the screen is open: it rises in */
  fresh?: boolean;
  /** the small line under a reply: «Thought hard · {price}» */
  meta?: string;
  /** the note under a reply that stopped at one thought's limit — the reply is still the newest thing the pet said */
  cutNote?: boolean;
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
}

export const POLL_IDLE_MS = 5000;
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

export function usePetScreen(tokenId: string, from: string | null) {
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
  // the mode of the job on its way: «is thinking…» or «is thinking hard…»
  const [jobMode, setJobMode] = useState<'chat' | 'deep'>('chat');
  // no reply for 10 s: the line under the thinking line
  const [waiting, setWaiting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // the friend's pet this pet's birth came from: «Back to {friend_pet}»
  const [friend, setFriend] = useState<{ tokenId: string; name: string } | null>(null);
  // a line the screen says once, with a Toast: the pet was given away under a clear (`Memory deletion flow` › «уже не владелец»)
  const [notice, setNotice] = useState<string | null>(null);

  const pageRef = useRef(page);
  // what the player sent with the job on its way, to put it back in the field or retry it when the job is refused
  const sent = useRef<{ job: string; lineId: string; text: string; mode: 'chat' | 'deep' } | null>(null);
  pageRef.current = page;
  const jobRef = useRef(job);
  jobRef.current = job;
  const draftRef = useRef(draft);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const retryRef = useRef<() => void>(() => undefined);
  const polling = useRef(false);
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
    (lineId: string, text: string) => {
      unconfirmed.current.delete(lineId);
      setLines((now) => (now ?? []).filter((l) => l.id !== lineId));
      if (draftRef.current === '') setDraft(text);
    },
    [setDraft],
  );

  /** A job the server has and this tab did not start (a reload, another tab, an answer that was lost): its thinking
   *  line and the player's own line come back, and a line that went after all leaves the field. */
  const adopt = useCallback(
    (view: Pick<PetState, 'pendingJob' | 'pendingMode' | 'pendingKind' | 'pendingText'>) => {
      const job = view.pendingJob;
      if (!job || jobRef.current !== null || sendingRef.current || finished.current.has(job)) return;
      const mode = view.pendingMode ?? 'chat';
      changeJob(job);
      setJobMode(mode);
      const text = view.pendingKind === 'reply' ? view.pendingText : null;
      if (text === null) return;
      const id = `you-${(localLine.current += 1)}`;
      unconfirmed.current.add(id);
      setLines((now) => [...(now ?? []), { id, who: 'player', text, fresh: true }]);
      sent.current = { job, lineId: id, text, mode };
      if (draftRef.current === text) setDraft('');
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
        setPage({ kind: 'pet', pet });
        setBanner(null);
        if (pet.viewer === 'owner') {
          epoch.current = pet.memoryEpoch;
          wakes.current = pet.wakes;
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
  }, [viewer, tokenOf]);

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
  const loadLines = useCallback(async (): Promise<ConversationLine[] | null> => {
    try {
      const token = await tokenOf();
      const history = await workerApi.conversation(token, tokenId);
      historyRead.current = true;
      const name = pageRef.current.kind === 'pet' ? pageRef.current.pet.name : '';
      // a line of a stage change this page did not hold before (the conversation was read already) came while it was open:
      // it rises in (`Growth flow` › «переход записан позже ответа»); on the first read, and after a clear, nothing is new
      const known = new Set((linesRef.current ?? []).map((l) => l.id));
      const reread = linesRef.current !== null && linesRef.current.length > 0;
      const past = history.lines.flatMap((l): Line[] =>
        l.who === 'pet' ? replyLines(l, name, false) : [{ id: l.id, who: l.who, text: l.text, fresh: reread && l.who === 'event' && !known.has(l.id) ? true : undefined }],
      );
      const held = new Set(past.map((l) => l.id));
      setLines((now) => {
        // what happened in this tab while the history was on its way stays after it
        const mine = (now ?? []).filter((l) => !held.has(l.id) && (l.who === 'player' ? unconfirmed.current.has(l.id) : l.fresh));
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
      setLines(null);
      changeJob(null);
      setFailure(null);
      sent.current = null;
      greeted.current = false;
      historyRead.current = false;
      unconfirmed.current.clear();
    }
  }, [viewer, loadLines, changeJob]);

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
    if (jobRef.current !== null) finished.current.add(jobRef.current);
    changeJob(null);
    if (was) unconfirmed.current.delete(was.lineId);
    const history = await loadLines();
    if (was && history && !history.some((l) => l.who === 'player' && l.text === was.text) && draftRef.current === '') setDraft(was.text);
  }, [changeJob, loadLines, setDraft]);

  /** The answer on its way and the lines of this page's own are over: the memory was cleared. The typed draft stays. */
  const forgetConversation = useCallback(() => {
    if (jobRef.current !== null) finished.current.add(jobRef.current);
    changeJob(null);
    sent.current = null;
    unconfirmed.current.clear();
    setFailure(null);
    // the pet doesn't speak first after a clear (`Memory deletion flow` › «стёр»)
    greeted.current = true;
  }, [changeJob]);

  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const token = await tokenOf();
      const asked = jobRef.current;
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
                tired: s.tired,
                until: s.until,
                paused: s.paused,
                deepPrice: s.deepPrice,
                hello: s.hello,
                memoryEpoch: s.memoryEpoch,
                mood: s.mood,
                traits: s.traits,
                energy: s.energy,
              },
            }
          : p,
      );
      // another tab of the owner cleared the memory: nothing of the conversation stays on this page, and what the server holds
      // is read again; a poll that was on its way before this tab's own clear carries the older number and is not a change
      if (s.memoryEpoch > epoch.current) {
        epoch.current = s.memoryEpoch;
        forgetConversation();
        setLines([]);
        void loadLines();
        return;
      }
      if (!historyRead.current) void loadLines();
      // the outcome belongs to the job this request asked about; a job that ended meanwhile is not read twice
      const mine = asked !== null && jobRef.current === asked;
      const thought = mine ? s.thought : undefined;
      if (thought) {
        const local = sent.current;
        if (local) unconfirmed.current.delete(local.lineId);
        finished.current.add(asked!);
        setLines((now) => {
          const list = now ?? [];
          // the history read meanwhile already holds it, the player's line with it
          if (list.some((l) => l.id === thought.id)) return list.filter((l) => l.id !== local?.lineId);
          return [...list, ...replyLines(thought, s.name, true)];
        });
        changeJob(null);
        setFailure(null);
        sent.current = null;
      } else if (mine && s.code) {
        const code = s.code;
        const was = sent.current?.job === asked ? sent.current : null;
        sent.current = null;
        finished.current.add(asked!);
        changeJob(null);
        if (code === 'ai_unavailable' || code === 'empty_paid') {
          // the player's line stays in the conversation; a greeting or a wake thought has none
          const kind = s.jobKind === 'wake' || s.jobKind === 'greeting' ? s.jobKind : was ? 'reply' : 'greeting';
          setFailure({ code, kind, lineId: was?.lineId, text: was?.text, mode: was?.mode });
        } else if (code === 'memory_cleared') {
          // the memory was cleared while the answer was on its way: its line never lands and the player's own line is gone with
          // the rest; the conversation is read again (`Memory deletion data` › «ответ в пути»)
          if (was) {
            unconfirmed.current.delete(was.lineId);
            setLines((now) => (now ?? []).filter((l) => l.id !== was.lineId));
          }
          void loadLines();
        } else if (was) {
          // asleep, tired, too hungry, paused, no network: nothing happened — the line goes back to the field
          giveBack(was.lineId, was.text);
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
      if (e instanceof WorkerError && e.code === 'no_job') void jobGone();
      else fail(e, () => void poll());
    } finally {
      polling.current = false;
    }
  }, [tokenOf, tokenId, loadLines, fail, giveBack, adopt, jobGone, changeJob, forgetConversation]);

  // The owner's page is kept current — food from a friend, the pause lifting, 00:00 UTC — and a thought's answer is
  // fetched; a hidden tab asks nothing, a tab that comes back asks at once.
  // An ended session stops the polls: no new data loads, and the page stands as it was (`Session expiry flow`).
  const ended = auth.sessionEnded;
  useEffect(() => {
    if (viewer !== 'owner' || ended) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) void poll();
    }, job ? POLL_JOB_MS : POLL_IDLE_MS);
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [viewer, ended, job, poll]);

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
    async (raw: string, mode: 'chat' | 'deep' = 'chat') => {
      const text = raw;
      if (!hasVisible(text) || jobRef.current !== null || sendingRef.current || pageRef.current.kind !== 'pet') return;
      // a session that ended: the line, nothing sent, the text stays in the field
      if (!authRef.current.needSession()) return;
      const id = `you-${(localLine.current += 1)}`;
      sendingRef.current = true;
      setSending(true);
      setFailure(null);
      setJobMode(mode);
      unconfirmed.current.add(id);
      setLines((now) => [...(now ?? []), { id, who: 'player', text, fresh: true }]);
      // «Try again» sends a line that is not the field's: what the player typed since stays there
      if (raw === draftRef.current) setDraft('');
      setSpoke(true);
      try {
        const token = await tokenOf();
        const answer = await workerApi.say(token, tokenId, text, mode);
        sent.current = { job: answer.job, lineId: id, text, mode };
        changeJob(answer.job);
        setBanner(null);
      } catch (e) {
        if (statusOf(e) === 401) {
          // the session ended under this tap: the same line as when it had ended before; nothing was sent, the text is back
          giveBack(id, text);
          authRef.current.endSession(true, true);
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
    void send(f.text, f.mode);
  }, [failure, askGreeting, askWake, send]);

  const tryAgain = useCallback(() => retryRef.current(), []);

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
        forgetConversation();
        epoch.current += 1;
        const id = `event-${(localLine.current += 1)}`;
        setLines([{ id, who: 'event', text: `${shown}'s memory is clear — same ${shown}, fresh start.`, fresh: true }]);
      }),
    [tokenId, forgetConversation],
  );
  const clearNotice = useCallback(() => setNotice(null), []);

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
    const text = takeReturnText(here);
    if (text !== null && ownerNow) setDraft(text);
  }, [decided, ownerNow, here, setDraft]);

  // Back from the sign-in with «Feed {name}» tapped: the feeding change takes the action, as the owner or as a guest.
  const pet = page.kind === 'pet' ? page.pet : null;
  useEffect(() => {
    if (!pet || pet.viewer === 'visitor') return;
    if (takePendingAction() === 'feed') runAction('feed', { tokenId, name: pet.name, viewer: pet.viewer });
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
    busy: job !== null || sending,
    spoke,
    me,
    send,
    retryThought,
    tryAgain,
    notice,
    clearNotice,
  };
}
