import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from '../route';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi, type DiaryView } from '../seams/worker';
import { takeReturnText } from '../signin/returnPlace';
import { eraseRiddleDraft, loadRiddleDraft, saveRiddleDraft, type RiddleDraft } from './riddleDraft';

// The Diary screen's state (`Diary screen`, `Connection rule`): the Worker's diary of the day, polled every 5 s while the screen
// stands and not in a hidden tab, at once on return. It is called from the Pet screen, which stays under the Diary, so what the
// player typed outlives «Back to {name}» and a new day. A load that fails with nothing to show, or with a day that has moved on,
// is the screen's «error»; one that fails over a diary of today is the connection line over it (`Connection rule`).
export type DiaryLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; diary: DiaryView }
  /** `last`: the last known diary, which stays under the line with what was typed in its fields */
  | { kind: 'error'; last: DiaryView | null };

export type DiaryBanner = 'offline' | 'busy' | null;

export const POLL_DIARY_MS = 5000;
const DAY_MS = 86_400_000;

/** The UTC day of the player's clock. A diary whose day is behind it is a day that has moved on. */
export const utcDayNow = () => Math.floor(Date.now() / DAY_MS);

const statusOf = (e: unknown) => (e instanceof WorkerError ? e.status : 0);

/** The riddle of a day closed at the next 00:00 UTC (ISO): the `{time}` of the late line. */
const closeOf = (day: number) => new Date((day + 1) * DAY_MS).toISOString();

export function useDiary({
  tokenId,
  active,
  owner,
  decided,
  reread,
  nudge = 0,
  returned = null,
  askLook,
}: {
  tokenId: string;
  /** the Diary stands now: awake pet of the owner, at its address */
  active: boolean;
  /** the page is the owner's */
  owner: boolean;
  /** the Pet screen has decided what this address shows */
  decided: boolean;
  /** the pet is not this player's any more (`403`): the Pet screen reads it again */
  reread: () => void;
  /** the Pet screen asks for the diary again at once: it changes by one each time */
  nudge?: number;
  /** an answer to the question the thought refused, for the field */
  returned?: { text: string; n: number } | null;
  /** the pet's condition is read again at once (a riddle answer found it asleep) */
  askLook?: () => void;
}) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const ended = auth.sessionEnded;

  const [load, setLoad] = useState<DiaryLoad>({ kind: 'loading' });
  const [banner, setBanner] = useState<DiaryBanner>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  // the question's draft is the tab's memory; the riddle's also lives in the session (`typed riddle answer`)
  const [question, setQuestionState] = useState('');
  const [riddle, setRiddleState] = useState<RiddleDraft | null>(null);
  const riddleRef = useRef(riddle);
  riddleRef.current = riddle;
  const riddleRead = useRef(false);
  const inFlight = useRef(false);
  // the newest request wins: a read after a send must not be overtaken by a poll that began before it
  const seq = useRef(0);
  // a stand of the Diary: an answer that belongs to an earlier one is dropped
  const stand = useRef(0);
  // the read marks this stand has sent, by day and by whether the entry was on screen
  const marked = useRef(new Set<string>());
  const marking = useRef(false);
  const retryRef = useRef<() => void>(() => undefined);
  // the riddle answer on its way, and the line of a late one (`Riddle rule` › «ответ опоздал»): the time its riddle closed
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [late, setLate] = useState<string | null>(null);

  const tokenOf = useCallback(async () => {
    const a = authRef.current;
    if (!a.authenticated) return null;
    const token = await a.getIdentityToken();
    // a token keeper with no token for a signed-in page: the session ended, as a `401` says it
    if (token === null) throw new WorkerError(401, 'signed_out');
    return token;
  }, []);

  const dropRiddle = useCallback(() => {
    eraseRiddleDraft(tokenId);
    riddleRef.current = null;
    setRiddleState(null);
  }, [tokenId]);

  /** Reads the diary. `force`: a read the screen asks for itself (after a send), which a poll in flight does not stand in for. */
  const fetchDiary = useCallback(
    async (force = false) => {
      if (inFlight.current && !force) return;
      inFlight.current = true;
      const mine = stand.current;
      const order = (seq.current += 1);
      try {
        const diary = await workerApi.diary(await tokenOf(), tokenId);
        if (mine !== stand.current || order !== seq.current) return;
        setLoad({ kind: 'ready', diary });
        setBanner(null);
        // the typed riddle answer comes back once, when the diary's day is known: another day's is removed
        if (!riddleRead.current) {
          riddleRead.current = true;
          const kept = loadRiddleDraft(tokenId, diary.day);
          if (kept !== null && riddleRef.current === null) setRiddleState(kept);
        }
      } catch (e) {
        if (mine !== stand.current || order !== seq.current) return;
        retryRef.current = () => void fetchDiary(true);
        const status = statusOf(e);
        if (status === 401) {
          authRef.current.endSession(true);
          return;
        }
        if (status === 403) {
          // the pet is someone else's now: the riddle answer typed for it goes with the owner's page (`Ritual data`)
          dropRiddle();
          reread();
          return;
        }
        const known = loadRef.current.kind === 'ready' ? loadRef.current.diary : loadRef.current.kind === 'error' ? loadRef.current.last : null;
        if (known !== null && known.day === utcDayNow()) setBanner(status === 429 ? 'busy' : 'offline');
        else setLoad({ kind: 'error', last: known });
      } finally {
        if (order === seq.current) inFlight.current = false;
      }
    },
    [tokenOf, tokenId, reread, dropRiddle],
  );

  // Opening: a diary is read afresh each time the screen stands (`Diary screen` › «loading»); the polls follow. The late line
  // is the tab's memory of one stand: Back drops it.
  useEffect(() => {
    if (!active) return undefined;
    stand.current += 1;
    marked.current.clear();
    setLoad({ kind: 'loading' });
    setBanner(null);
    setLate(null);
    void fetchDiary();
    return () => {
      stand.current += 1;
      inFlight.current = false;
    };
  }, [active, fetchDiary]);

  // Kept current — the entry that appears, the riddle that opens, a new day — not in a hidden tab, at once on return, not after
  // the session ended (`Session expiry flow`).
  useEffect(() => {
    if (!active || ended) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) void fetchDiary();
    }, POLL_DIARY_MS);
    const onVisible = () => {
      if (!document.hidden) void fetchDiary();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, ended, fetchDiary]);

  // The Pet screen asks for the diary again at once: the pet's reply landed, or an answer found the screen behind.
  const nudged = useRef(nudge);
  useEffect(() => {
    if (nudged.current === nudge) return;
    nudged.current = nudge;
    if (active && !ended) void fetchDiary(true);
  }, [nudge, active, ended, fetchDiary]);

  // The read mark (`Daily ritual flow`): sent from a Diary that really stands, at any opening, and again when the entry appears on
  // it. A mark that failed is sent by the next poll; one that went is not sent again for the same day and entry.
  const shown = active && load.kind === 'ready' ? load.diary : null;
  useEffect(() => {
    if (shown === null || ended || marking.current) return;
    const key = `${shown.day}:${shown.entry.kind === 'text'}`;
    if (marked.current.has(key)) return;
    marking.current = true;
    const mine = stand.current;
    void (async () => {
      try {
        await workerApi.readDiary(await tokenOf(), tokenId, shown.day);
        if (mine === stand.current) marked.current.add(key);
      } catch (e) {
        if (statusOf(e) === 401 && mine === stand.current) authRef.current.endSession(true);
      } finally {
        marking.current = false;
      }
    })();
  }, [shown, ended, tokenOf, tokenId]);

  // The question's draft from a sign-in begun on the ended-session line, handed back to this address once its view is decided.
  const here = useLocation();
  useEffect(() => {
    if (!decided || !owner) return;
    const text = takeReturnText(here);
    if (text !== null) setQuestionState(text);
  }, [decided, owner, here]);

  // An answer to the question the thought refused is back in the field, unless the player has typed something new meanwhile.
  useEffect(() => {
    if (returned !== null) setQuestionState((now) => (now === '' ? returned.text : now));
  }, [returned]);

  const setQuestion = useCallback((text: string) => setQuestionState(text), []);

  /** The riddle's field changed. The draft keeps the day of the riddle the text was typed for, until it is empty. */
  const setRiddle = useCallback(
    (text: string, day: number) => {
      const next = text === '' ? null : { day: riddleRef.current?.day ?? day, text };
      riddleRef.current = next;
      setRiddleState(next);
      saveRiddleDraft(tokenId, next);
    },
    [tokenId],
  );

  /** «Send answer» (`Riddle rule`): the draft goes with the day it was typed for. The server tells `accepted`, `already` (a stale
   *  tab: the screen catches up) or `late` (the field clears, the line says when it closed). */
  const sendRiddle = useCallback(async () => {
    const draft = riddleRef.current;
    if (draft === null || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    const mine = stand.current;
    try {
      const { status } = await workerApi.answerRiddle(await tokenOf(), tokenId, { text: draft.text, day: draft.day });
      dropRiddle();
      setBanner(null);
      if (status === 'late') {
        setLate(closeOf(draft.day));
      } else {
        setLate(null);
        if (status === 'accepted') {
          // the answer stands in the field's place at once; the read that follows holds it too
          setLoad((now) =>
            now.kind === 'ready' && now.diary.riddle.kind === 'open'
              ? {
                  kind: 'ready',
                  diary: {
                    ...now.diary,
                    riddle: { kind: 'answered', day: now.diary.riddle.day, text: now.diary.riddle.text, answer: draft.text },
                    parts: now.diary.parts.filter((p) => p !== 'riddle'),
                  },
                }
              : now,
          );
        }
      }
      if (mine === stand.current) void fetchDiary(true);
    } catch (e) {
      const status = statusOf(e);
      if (status === 401) {
        authRef.current.endSession(true, true);
      } else if (status === 403) {
        dropRiddle();
        reread();
      } else if (status === 409) {
        // asleep: the screen learns it from the pet's own look; not sealed: the diary says what is there
        const code = e instanceof WorkerError ? e.code : '';
        if (code === 'asleep') askLook?.();
        else void fetchDiary(true);
      } else if (status !== 400) {
        setBanner(status === 429 ? 'busy' : 'offline');
        retryRef.current = () => void fetchDiary(true);
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [tokenOf, tokenId, dropRiddle, fetchDiary, reread, askLook]);

  const tryAgain = useCallback(() => retryRef.current(), []);

  const view = load.kind === 'ready' ? load.diary : null;
  return { load, view, banner, question, setQuestion, riddle, setRiddle, sendRiddle, sending, late, dropRiddle, tryAgain };
}
