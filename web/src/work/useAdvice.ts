import { useCallback, useEffect, useRef, useState } from 'react';
import { onFed } from '../feeding/feedRequest';
import { POLL_GUEST_MS, POLL_JOB_MS, WAIT_MS } from '../screens/pet/usePetScreen';
import type { Advice } from '../screens/pet/parts';
import { useAuth } from '../seams/auth';
import { WorkerError, waitLineMs, workerApi, type AdviceRead, type PetState } from '../seams/worker';

// The state machine of the guest's advice column (`Advice flow`), all of it the tab's memory but what the server holds: the question
// in the field, the lines of the log, the job on its way. The server holds the asker's last exchange (`last`) and a question on its way
// (`pending`), so a reload brings both back; everything else — a price that rose, a line of an advice that did not come — is the tab's.

/** The lines of the log. `asked`: the question under «You»; `answer`: the friend's pet's, in its own voice; `event` / `error`: the
 *  game's, written by the component from the code (the names are known there). */
export type Entry =
  | { id: string; kind: 'asked'; text: string; fresh?: boolean }
  | { id: string; kind: 'answer'; thoughtId: string; text: string; skilled: boolean; dataLabels?: string[]; noHireFee?: boolean; answerPriceCents?: number; fresh?: boolean }
  | { id: string; kind: 'event'; code: 'couldnt_help'; fresh?: boolean }
  | { id: string; kind: 'error'; code: 'empty' | 'cleared' | 'data_failed' | 'data_failed_paid'; fresh?: boolean };

/** What stops an ask now, in the order `Advice flow` › several at once shows them: only the first is drawn. */
export type Blocker = 'paused' | 'worker_asleep' | 'relationship' | 'worker_resting' | 'cant_pay' | 'tired';

export function blockerOf(facts: { workerAsleep: boolean; read: AdviceRead | null }): Blocker | null {
  const { read } = facts;
  if (read?.paused) return 'paused';
  if (facts.workerAsleep || read?.workerAsleep) return 'worker_asleep';
  if (read?.refusalUntil && Date.parse(read.refusalUntil) > Date.now()) return 'relationship';
  if (read?.resting) return 'worker_resting';
  if (read && (read.payer.state === 'short' || read.payer.state === 'asleep')) return 'cant_pay';
  if (read?.payer.state === 'tired') return 'tired';
  return null;
}

// a little after a named time, so the server's clock has passed it too; a timer holds at most 2^31 − 1 ms
const AFTER_END_MS = 1500;
const MAX_TIMER_MS = 2 ** 31 - 1;

const statusOf =(e: unknown) => (e instanceof WorkerError ? e.status : 0);
const codeOf = (e: unknown) => (e instanceof WorkerError ? e.code : '');

export function useAdvice(worker: { tokenId: string; name: string; asleep: boolean }, host: Advice) {
  const auth = useAuth();
  const hostRef = useRef(host);
  hostRef.current = host;
  const authRef = useRef(auth);
  authRef.current = auth;
  const payerId = host.payer.tokenId;

  const [read, setRead] = useState<AdviceRead | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraftState] = useState('');
  const [job, setJob] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  // the price rose under the tap: the line says so until the next tap
  const [rose, setRose] = useState(false);

  const draftRef = useRef(draft);
  const jobRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  const counter = useRef(0);
  const readGen = useRef(0);
  const finished = useRef(new Set<string>());
  // the question each job carries, to put back in the field when it does not come
  const asking = useRef<{ job: string | null; entry: string; text: string } | null>(null);
  // this tab has lines of its own: a later read does not replace them with the server's
  const local = useRef(false);

  const setDraft = useCallback((text: string) => {
    draftRef.current = text;
    setDraftState(text);
  }, []);

  const changeJob = useCallback((next: string | null) => {
    jobRef.current = next;
    setJob(next);
  }, []);

  /** The column's read: the price, how the paying pet and the friend's pet stand. `open`: the first read of this column — it brings
   *  back the question on its way or the last exchange, when this tab has no lines of its own. */
  const load = useCallback(
    async (open = false) => {
      const gen = (readGen.current += 1);
      try {
        const token = await hostRef.current.tokenOf();
        if (token === null) return;
        const answer = await workerApi.advice(token, worker.tokenId, payerId);
        if (gen !== readGen.current) return;
        setRead(answer);
        if (open && !local.current) {
          if (answer.pending) {
            const id = `asked-${(counter.current += 1)}`;
            asking.current = { job: answer.pending.job, entry: id, text: answer.pending.question };
            setEntries([{ id, kind: 'asked', text: answer.pending.question }]);
            changeJob(answer.pending.job);
          } else if (answer.last) {
            const last = answer.last;
            setEntries([
              { id: `asked-${(counter.current += 1)}`, kind: 'asked', text: last.question },
              { id: `answer-${last.id}`, kind: 'answer', thoughtId: last.id, text: last.text, skilled: last.skilled, dataLabels: last.dataLabels, noHireFee: last.noHireFee, answerPriceCents: last.answerPriceCents },
            ]);
          }
        }
      } catch (e) {
        if (gen !== readGen.current) return;
        if (statusOf(e) === 403 && codeOf(e) === 'not_payer') hostRef.current.payerChanged();
        else hostRef.current.report(e, () => void load(open));
      }
    },
    [worker.tokenId, payerId, changeJob],
  );

  // Opening the column: the read, once for this pair; the lines of the tab go with the pair.
  useEffect(() => {
    setRead(null);
    setEntries([]);
    changeJob(null);
    local.current = false;
    asking.current = null;
    void load(true);
    return () => {
      readGen.current += 1;
    };
  }, [worker.tokenId, payerId, load, changeJob]);

  // The tab comes back, or the friend's pet falls asleep or wakes: the column reads again.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);
  const wasAsleep = useRef(worker.asleep);
  useEffect(() => {
    if (wasAsleep.current !== worker.asleep) void load();
    wasAsleep.current = worker.asleep;
  }, [worker.asleep, load]);

  // A meal of the paying pet's, the sheet open or closed: it may pay now, «Ask» is back with the question (`свой питомец накормлен`).
  useEffect(() => onFed((event) => event.kind === 'fed' && event.tokenId === payerId && void load()), [payerId, load]);

  // The text a sign-in from the ended-session line brought back.
  useEffect(() => {
    if (host.carried === null) return;
    if (draftRef.current === '') setDraft(host.carried);
    host.takeCarried();
  }, [host, setDraft]);

  // No answer for 10 s: the waiting line joins the thinking line (`Advice flow` › вопрос отправлен).
  useEffect(() => {
    setWaiting(false);
    if (job === null) return undefined;
    const timer = setTimeout(() => setWaiting(true), waitLineMs(WAIT_MS));
    return () => clearTimeout(timer);
  }, [job]);

  /** The question did not go through: its line leaves the log and it is back in the field, unless the player typed something new. */
  const giveBack = useCallback((add?: Entry) => {
    const asked = asking.current;
    asking.current = null;
    setEntries((now) => {
      const rest = asked ? now.filter((e) => e.id !== asked.entry) : now;
      return add ? [...rest, add] : rest;
    });
    if (asked && draftRef.current === '') {
      draftRef.current = asked.text;
      setDraftState(asked.text);
    }
  }, []);

  const couldntHelp = useCallback((): Entry => ({ id: `line-${(counter.current += 1)}`, kind: 'event', code: 'couldnt_help', fresh: true }), []);
  const failed = useCallback((code: 'empty' | 'cleared' | 'data_failed' | 'data_failed_paid'): Entry => ({ id: `line-${(counter.current += 1)}`, kind: 'error', code, fresh: true }), []);

  /** The payer's job is over: the answer, or why there is none. */
  const settle = useCallback(
    (state: PetState) => {
      const was = jobRef.current;
      if (was === null || finished.current.has(was)) return;
      finished.current.add(was);
      changeJob(null);
      const thought = state.thought;
      if (thought && thought.kind === 'advice' && state.code !== 'memory_cleared') {
        asking.current = null;
        setEntries((now) => [...now, { id: `answer-${thought.id}`, kind: 'answer', thoughtId: thought.id, text: thought.text, skilled: thought.skilled === true, dataLabels: thought.dataLabels, noHireFee: thought.noHireFee, answerPriceCents: thought.answerPriceCents, fresh: true }]);
        setRose(false);
        void load();
        return;
      }
      switch (state.code) {
        case 'price_rose':
          giveBack();
          setRose(true);
          if (state.price) setRead((r) => (r ? { ...r, price: state.price! } : r));
          void load();
          return;
        case 'society_refused':
          giveBack();
          if (state.refusalUntil) setRead((r) => r ? { ...r, refusalUntil: state.refusalUntil } : r);
          void load();
          return;
        case 'worker_asleep':
          giveBack(couldntHelp());
          hostRef.current.look();
          void load();
          return;
        case 'worker_resting':
        case 'short':
        case 'asleep':
        case 'tired':
          giveBack();
          void load();
          return;
        case 'paused':
          // the page's read says so (`paused`): the line stands until the pause lifts
          giveBack();
          void load();
          return;
        case 'empty_paid':
          giveBack(failed('empty'));
          void load();
          return;
        case 'data_failed':
          // the worker's skill got no data: nothing was spent (or the paying pet's food paid for the try), the question is kept
          giveBack(failed(state.paid === true ? 'data_failed_paid' : 'data_failed'));
          void load();
          return;
        case 'memory_cleared':
          giveBack(failed('cleared'));
          void load();
          return;
        case 'no_pet':
          giveBack();
          hostRef.current.payerChanged();
          hostRef.current.look();
          return;
        default:
          // ai_unavailable, chain_unreachable: nothing was spent, the question is kept
          giveBack(couldntHelp());
          void load();
      }
    },
    [changeJob, giveBack, couldntHelp, failed, load],
  );

  // The paying pet's job, asked about as its owner's page does: `GET /api/pets/:payer/state?job=`.
  useEffect(() => {
    if (job === null) return undefined;
    let live = true;
    let checking = false;
    const check = async () => {
      if (document.hidden || checking) return;
      checking = true;
      try {
        const token = await hostRef.current.tokenOf();
        if (token === null) return;
        const state = await workerApi.petState(token, payerId, job);
        if (live && !state.pending) settle(state);
      } catch (e) {
        if (!live) return;
        if (statusOf(e) === 404 && codeOf(e) === 'no_job') {
          // the job is not there any more (a clear erased it): what the server holds is read again
          finished.current.add(job);
          giveBack();
          changeJob(null);
          void load();
        } else hostRef.current.report(e, () => undefined);
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), POLL_JOB_MS);
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [job, payerId, settle, giveBack, changeJob, load]);

  const busy = job !== null || sending;
  const blocker = blockerOf({ workerAsleep: worker.asleep, read });
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;

  // While anything stops an ask the column reads again at the guest page's own pace, so «Ask {name} · {price}» comes back by itself
  // when the pause lifts or the paying pet is fed elsewhere (another tab, a friend), with no reload and no edit (`Advice flow` ›
  // «several at once»); a blocker that ends at a named time is also read at that time, so it does not wait for the next poll.
  const held = blocker !== null;
  useEffect(() => {
    if (!held) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_GUEST_MS);
    return () => clearInterval(timer);
  }, [held, load]);

  // The times the read names, as a key: the timer is set when the key changes, not on every render. A time already behind when the
  // read lands (a slow page, a clock ahead of the Worker's) still gets its one read, 1.5 s on; the same read again has the same key,
  // so it does not loop.
  const endsKey = [read?.payer.state === 'tired' ? read.payer.until : null, read?.resting?.until, read?.dropsAt, read?.refusalUntil]
    .map((iso) => (iso ? Date.parse(iso) : Number.NaN))
    .filter((at) => Number.isFinite(at))
    .sort((a, b) => a - b)
    .join(',');
  useEffect(() => {
    if (!held || endsKey === '') return undefined;
    const now = Date.now();
    const next = endsKey.split(',').map(Number).find((at) => at > now);
    const timer = setTimeout(() => void load(), Math.min((next === undefined ? 0 : next - now) + AFTER_END_MS, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [held, endsKey, load]);

  /** «Ask {name} · {price}» or Enter: the question goes at the price the column shows, a ceiling. */
  const ask = useCallback(
    async (raw: string) => {
      const text = raw;
      const current = read;
      // what stops an ask stops the Enter of the field too: the question waits where it is
      if (jobRef.current !== null || sendingRef.current || current === null || blockerRef.current !== null || text.trim() === '') return;
      // a session that ended: the line, nothing sent
      if (!authRef.current.needSession()) return;
      const entry = `asked-${(counter.current += 1)}`;
      sendingRef.current = true;
      setSending(true);
      setRose(false);
      local.current = true;
      asking.current = { job: null, entry, text };
      setEntries((now) => [...now, { id: entry, kind: 'asked', text, fresh: true }]);
      if (draftRef.current === raw) setDraft('');
      try {
        const token = await hostRef.current.tokenOf();
        const answer = await workerApi.askAdvice(token, worker.tokenId, { payer: payerId, text, price: current.price.yocto });
        if (asking.current?.entry === entry) asking.current.job = answer.job;
        changeJob(answer.job);
      } catch (e) {
        const status = statusOf(e);
        const code = codeOf(e);
        giveBack();
        if (status === 401) authRef.current.endSession(true, true);
        else if (status === 409 && code === 'pending') {
          // another tab asked already: the question on its way is read and shown here
          local.current = false;
          void load(true);
        }
        else if (status === 409 && code === 'paused') void load();
        else if (status === 403 && code === 'not_payer') hostRef.current.payerChanged();
        else if (status === 409 && code === 'same_owner') hostRef.current.look();
        else hostRef.current.report(e, () => void ask(draftRef.current));
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [read, worker.tokenId, payerId, changeJob, giveBack, load, setDraft],
  );

  return { read, entries, draft, setDraft, busy, waiting, rose, blocker, ask };
}
