import { useCallback, useEffect, useRef, useState } from 'react';
import { hasVisible } from '../lib/nameClean';
import { onFed } from '../feeding/feedRequest';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi } from '../seams/worker';
import type { ErrandBlock, ErrandForm, ErrandQuote, Token } from '../seams/worker-types';
import { track } from '../track';
import { LIMIT } from './lines';
import { sendPrice } from './price';

// The state machine of Errand sheet (`Errand sheet screen`, `Errand flow`). All of it is the tab's memory: the picked form, the text of
// each form (switching back brings it), the quote last read, the line at the body's top. A reload throws the sheet and its draft away
// (§8 › Черновик реплики); a sign-in from the ended-session line brings the form and the text back through the return place.

export interface ErrandHost {
  tokenOf: () => Promise<Token | null>;
  /** the page's own answer to a refusal of the owner's right (`403 not_owner`) or of the session (`401`); the sheet closes with it */
  refused: (e: unknown) => void;
  /** a request that failed for the network: the page's connection line, with the retry */
  failed: (e: unknown, retry: () => void) => void;
  /** «Send» went: the sheet is closed, the page shows the pet away */
  sent: (errand: { form: ErrandForm; job: string; id: string }) => void;
  /** the pet is away already (`409 away`: another tab sent an errand): the sheet closes, the page reads the pet */
  away: () => void;
  /** a value that changes when the pet's condition does (asleep, energy, the cap, a pause): the open sheet reads the quote again */
  watch: string;
  tokenId: string;
}

const statusOf = (e: unknown) => (e instanceof WorkerError ? e.status : 0);
const codeOf = (e: unknown) => (e instanceof WorkerError ? e.code : '');
const NO_TEXT: Record<ErrandForm, string> = { read: '', find: '', check: '' };

export function useErrand(host: ErrandHost) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const hostRef = useRef(host);
  hostRef.current = host;

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ErrandForm>('read');
  const [jobs, setJobs] = useState<Record<ErrandForm, string>>(NO_TEXT);
  const [quotes, setQuotes] = useState<Partial<Record<ErrandForm, ErrandQuote>>>({});
  // the quote of the picked form could not be read
  const [error, setError] = useState(false);
  const errorRef = useRef(false);
  const [sending, setSending] = useState(false);
  // a tap found the session ended: the line with «Sign in» at the body's top
  const [session, setSession] = useState(false);
  // «Send» found no network or a server error: the page's connection line says it, and so does the sheet's status — the page's
  // live region is out of reach under the sheet (DS › Sheet › Focus). Until the next «Send» or form.
  const [sendFailed, setSendFailed] = useState(false);
  // a block that holds now stood in «Send»'s place at the tap: the focus goes to the field (DS › Sheet › Focus); counted, so a
  // second block focuses it again
  const [blockedAtSend, setBlockedAtSend] = useState(0);
  const live = useRef(0);
  const sendingRef = useRef(false);
  const formRef = useRef(form);
  formRef.current = form;
  const openRef = useRef(open);
  openRef.current = open;
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const reported = useRef(new Set<ErrandForm>());

  /** Reads the quote of `which`; a read that finishes after the sheet moved on is dropped. */
  const read = useCallback(async (which: ErrandForm) => {
    const gen = (live.current += 1);
    try {
      const token = await hostRef.current.tokenOf();
      if (token === null) throw new WorkerError(401, 'signed_out');
      const quote = await workerApi.errand(token, hostRef.current.tokenId, which);
      if (gen !== live.current || !openRef.current) return;
      setQuotes((now) => ({ ...now, [which]: quote }));
      if (formRef.current === which) {
        errorRef.current = false;
        setError(false);
      }
    } catch (e) {
      if (gen !== live.current || !openRef.current) return;
      if (statusOf(e) === 403 && codeOf(e) === 'not_owner') {
        setOpen(false);
        hostRef.current.refused(e);
        return;
      }
      // a session that ended: the page stands as it is, the sheet with it and the quote it had; the line comes when «Send» is tapped
      if (statusOf(e) === 401) {
        hostRef.current.refused(e);
        return;
      }
      setQuotes((now) => ({ ...now, [which]: undefined }));
      if (formRef.current === which) {
        errorRef.current = true;
        setError(true);
      }
    }
  }, []);

  /** Opens the sheet. `typed` — the form and text a sign-in or a «Try again» brings: that form is picked with that text, the other
   *  forms keep theirs. The quotes are read afresh. */
  const openSheet = useCallback(
    (typed?: { form: ErrandForm; job: string }) => {
      const which = typed?.form ?? formRef.current;
      if (typed) {
        setJobs((now) => ({ ...now, [typed.form]: typed.job }));
        jobsRef.current = { ...jobsRef.current, [typed.form]: typed.job };
      }
      setForm(which);
      formRef.current = which;
      setQuotes({});
      errorRef.current = false;
      setError(false);
      setSession(false);
      setSendFailed(false);
      reported.current = new Set();
      openRef.current = true;
      setOpen(true);
      void read(which);
    },
    [read],
  );

  const close = useCallback(() => {
    live.current += 1;
    openRef.current = false;
    setOpen(false);
    setSession(false);
    setSendFailed(false);
    setSending(false);
    sendingRef.current = false;
  }, []);

  const pick = useCallback(
    (next: ErrandForm) => {
      setForm(next);
      formRef.current = next;
      errorRef.current = false;
      setError(false);
      setSession(false);
      setSendFailed(false);
      void read(next);
    },
    [read],
  );

  const setJob = useCallback((text: string) => {
    setJobs((now) => ({ ...now, [formRef.current]: text }));
    jobsRef.current = { ...jobsRef.current, [formRef.current]: text };
  }, []);

  /** The quote of the picked form again: «Try again», the pet's condition moved, the tab came back. The text stays. */
  const refresh = useCallback(() => {
    if (!openRef.current) return;
    void read(formRef.current);
  }, [read]);

  // the pet fell asleep, the energy or the cap lifted at 00:00 UTC, a pause went: the open sheet reads the quote again
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    refresh();
  }, [host.watch, refresh]);

  // the tab hidden and back: the price may have moved
  useEffect(() => {
    if (!open) return undefined;
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [open, refresh]);

  // Feed sheet beside this one: a meal that landed brings «Send» back (`Errand flow` › «can't pay»)
  useEffect(
    () =>
      onFed((event) => {
        if (event.tokenId === hostRef.current.tokenId && event.kind === 'fed') refresh();
      }),
    [refresh],
  );

  const quote = quotes[form] ?? null;
  const job = jobs[form];
  const block: ErrandBlock | null = quote?.block ?? null;

  // `errand_blocked`: the first block shown, once per opening and form (a pause logs nothing here)
  useEffect(() => {
    if (!open || block === null || block.reason === 'paused' || reported.current.has(form)) return;
    reported.current.add(form);
    track('errand_blocked', { form, reason: block.reason });
  }, [open, block, form]);

  const filled = hasVisible(job);
  const price = quote ? sendPrice(form, quote, job) : null;
  const canSend = open && quote !== null && block === null && filled && !error && !sending;

  /** «Send · …». A session that ended meets the line of `Session expiry flow`; a block that holds now is told in «Send»'s place. */
  const send = useCallback(async () => {
    const which = formRef.current;
    const text = jobsRef.current[which];
    if (sendingRef.current || errorRef.current || !hasVisible(text) || [...text].length > LIMIT[which]) return;
    if (!authRef.current.needSession()) {
      setSession(true);
      return;
    }
    const gen = live.current;
    sendingRef.current = true;
    setSending(true);
    setSession(false);
    setSendFailed(false);
    try {
      const token = await hostRef.current.tokenOf();
      const answer = await workerApi.sendErrand(token, hostRef.current.tokenId, { form: which, job: text });
      if (gen !== live.current) return;
      close();
      hostRef.current.sent({ form: which, job: text, id: answer.job });
    } catch (e) {
      if (gen !== live.current) return;
      const status = statusOf(e);
      if (status === 409 && codeOf(e) === 'blocked') {
        // a stale quote, or another tab's spend: the block that holds now stands in «Send»'s place; the text stays
        const found = (e as WorkerError).body as { block?: ErrandBlock } | null;
        if (found?.block) setQuotes((now) => (now[which] ? { ...now, [which]: { ...now[which], block: found.block ?? null } } : now));
        else void read(which);
        setBlockedAtSend((n) => n + 1);
      } else if (status === 409 && codeOf(e) === 'away') {
        close();
        hostRef.current.away();
      } else if (status === 401) {
        // the session ended under this tap: the line of `Session expiry flow`, nothing was sent, the text stays
        authRef.current.endSession(true, true);
        setSession(true);
      } else if (status === 403 && codeOf(e) === 'not_owner') {
        close();
        hostRef.current.refused(e);
      } else if (status === 0 || status >= 500) {
        hostRef.current.failed(e, () => void send());
        setSendFailed(true);
      } else {
        void read(which);
      }
    } finally {
      if (gen === live.current) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  }, [close, read]);

  return { open, form, job, jobs, quote, error, sending, session, sendFailed, blockedAtSend, block, price, canSend, openSheet, close, pick, setJob, refresh, send };
}
