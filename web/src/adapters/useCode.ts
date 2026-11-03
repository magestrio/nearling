import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi } from '../seams/worker';
import type { Token, ToolView } from '../seams/worker-types';

// The state machine of Skill code sheet (`Skill code sheet screen`, `Skill code flow`): the code as typed, the function and the sample
// values of «Test run», the last run's outcome, the functions it found with their ticks, «Save code» and «Remove code». Writing code is
// free and sends nothing to the model; what is typed is the tab's memory (kept while the page stands, gone with a reload), the code
// the server keeps is read when the sheet opens.
//
// «Save code» stands on one rule: a test run of THIS code passed (`passedCode` is the code of the last pass — the server holds the same
// as the day's passing hash), the saved code too: unchanged, it still needs one test of the day. An edit moves `code` off `passedCode` and the button goes off again; a
// save the server refuses as `not_tested` (00:00 UTC passed since the pass) drops the pass and says so (`stale`).

export interface CodeHost {
  tokenOf: () => Promise<Token | null>;
  /** the page's answer when the pet is no longer owned (`403 not_owner`) */
  refused: (e: unknown) => void;
  /** the code was saved or removed: the sheet is gone, Skill sheet comes back with the line */
  done: (result: { kind: 'saved' | 'removed' }) => void;
}

export type CodeRequest = 'load' | 'test' | 'save' | 'remove';
/** The line at the body's top: a request that did not come back (with «Try again»), or the ended session. */
export type CodeTop = { kind: 'failed'; again: CodeRequest } | { kind: 'session' };
/** What «Test run» came to, under the field. `cap` and `game_cap` are the two refusals of a day's limit. */
export type CodeOutcome =
  | { kind: 'ok'; output: string }
  | { kind: 'limit' }
  | { kind: 'error'; text: string }
  | { kind: 'undeclared'; fn: string }
  | { kind: 'cap' }
  | { kind: 'game_cap' };

export interface CodeFieldsTyped {
  code: string;
  fn: string;
  values: string;
}

const statusOf = (e: unknown) => (e instanceof WorkerError ? e.status : 0);
const codeOf = (e: unknown) => (e instanceof WorkerError ? e.code : '');

const MAX_CODE_BYTES = 32 * 1024;
const fitsCode = (code: string) => new TextEncoder().encode(code).length <= MAX_CODE_BYTES;

export function useCode(tokenId: string, host: CodeHost) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const hostRef = useRef(host);
  hostRef.current = host;
  const [open, setOpen] = useState(false);
  // the code is read from the server before the field can be typed in
  const [loaded, setLoaded] = useState(false);
  const [code, setCodeState] = useState('');
  const [fn, setFnState] = useState('');
  const [values, setValuesState] = useState('');
  // the code the server keeps, null with none
  const [savedCode, setSavedCode] = useState<string | null>(null);
  const [functions, setFunctions] = useState<ToolView[]>([]);
  const [ticks, setTicks] = useState<string[]>([]);
  const [passedCode, setPassedCode] = useState<string | null>(null);
  // the server refused a save: the day turned since the pass (`Skill code flow` › «test from an earlier day»)
  const [stale, setStale] = useState(false);
  const [testsLeft, setTestsLeft] = useState(20);
  const savedNames = useRef(new Set<string>());
  const [outcome, setOutcome] = useState<CodeOutcome | null>(null);
  // the outcome is of the run just made: its console scrolls into view
  const [fresh, setFresh] = useState(false);
  const [top, setTop] = useState<CodeTop | null>(null);
  const [busy, setBusy] = useState<CodeRequest | null>(null);
  const live = useRef(0);
  const busyRef = useRef(false);
  // what the player typed and has not saved: a reopened sheet keeps it (`Skill code sheet screen`: the code stays in the tab)
  const dirty = useRef(false);
  const fields = useRef({ code, fn, values, ticks });
  fields.current = { code, fn, values, ticks };

  const close = useCallback(() => {
    live.current += 1;
    setOpen(false);
    setTop(null);
    setBusy(null);
    busyRef.current = false;
  }, []);

  /** One request of the sheet: the session first (an ended one meets its line and nothing is sent), then the call. */
  const run = useCallback(
    async <T,>(kind: CodeRequest, work: (token: Token | null) => Promise<T>, ok: (r: T) => void, handle?: (status: number, code: string) => boolean) => {
      if (busyRef.current) return;
      if (!authRef.current.needSession()) {
        setTop({ kind: 'session' });
        return;
      }
      const gen = live.current;
      busyRef.current = true;
      setBusy(kind);
      setTop(null);
      try {
        const token = await hostRef.current.tokenOf();
        const result = await work(token);
        if (gen !== live.current) return;
        ok(result);
      } catch (e) {
        if (gen !== live.current) return;
        const status = statusOf(e);
        const code = codeOf(e);
        if (status === 401) {
          authRef.current.endSession(true, true);
          setTop({ kind: 'session' });
          return;
        }
        if (status === 403 && code === 'not_owner') {
          close();
          hostRef.current.refused(e);
          return;
        }
        if (handle?.(status, code)) return;
        setTop({ kind: 'failed', again: kind });
      } finally {
        if (gen === live.current) {
          busyRef.current = false;
          setBusy(null);
        }
      }
    },
    [close],
  );

  /** Reads the code the server keeps; the field takes it unless the player has typed something that is not saved. */
  const load = useCallback(
    () =>
      run(
        'load',
        (token) => workerApi.code(token, tokenId),
        (read) => {
          setSavedCode(read.code);
          savedNames.current = new Set(read.functions.map((f) => f.name));
          setFunctions(read.functions);
          setTicks(read.functions.filter((f) => f.ticked).map((f) => f.name));
          setTestsLeft(read.testsLeft);
          if (!dirty.current) setCodeState(read.code ?? '');
          if (read.testsLeft === 0) setOutcome((o) => o ?? { kind: 'cap' });
          setLoaded(true);
        },
      ),
    [run, tokenId],
  );

  /** «Add code» / «{name}'s code», or a sign-in's return: `typed` — the three fields as the ended session left them (unsaved, no outcome). */
  const openSheet = useCallback(
    (typed?: CodeFieldsTyped) => {
      live.current += 1;
      setTop(null);
      setBusy(null);
      busyRef.current = false;
      setLoaded(false);
      setOutcome(null);
      setFresh(false);
      setStale(false);
      if (typed) {
        dirty.current = true;
        setCodeState(typed.code);
        setFnState(typed.fn);
        setValuesState(typed.values);
        setPassedCode(null);
      }
      setOpen(true);
      void load();
    },
    [load],
  );

  const setCode = useCallback((v: string) => {
    dirty.current = true;
    fields.current.code = v;
    setCodeState(v);
  }, []);
  const setFn = useCallback((v: string) => {
    dirty.current = true;
    setFnState(v);
  }, []);
  const setValues = useCallback((v: string) => {
    dirty.current = true;
    setValuesState(v);
  }, []);
  const tick = useCallback((name: string, on: boolean) => setTicks((t) => (on ? (t.includes(name) ? t : [...t, name]) : t.filter((n) => n !== name))), []);

  /** «Test run»: the function with its sample values, once, on the code as typed. */
  const test = useCallback(
    () => {
      const submitted = { code: fields.current.code, fn: fields.current.fn.trim(), values: fields.current.values };
      if (!fitsCode(submitted.code) || submitted.code.trim() === '' || submitted.fn === '' || testsLeft === 0) return Promise.resolve();
      return run(
        'test',
        (token) => workerApi.testCode(token, tokenId, submitted),
        (r) => {
          setFresh(true);
          setStale(false);
          // a run that ran, or loaded the module to find the function missing, uses one of the day's (`Skill code data` › «an undeclared function»)
          setTestsLeft((n) => Math.max(0, n - 1));
          if (r.outcome === 'undeclared') {
            setOutcome({ kind: 'undeclared', fn: r.fn });
            return;
          }
          if (r.outcome === 'ok') {
            setOutcome({ kind: 'ok', output: r.output });
            setFunctions(r.functions);
            setTicks(r.functions.filter((f) => f.tickable && (!savedNames.current.has(f.name) || fields.current.ticks.includes(f.name))).map((f) => f.name));
            setPassedCode(submitted.code);
          } else if (r.outcome === 'limit') setOutcome({ kind: 'limit' });
          else setOutcome({ kind: 'error', text: r.error });
        },
        (status, code) => {
          if (status === 429 && code === 'tests_used_up') {
            setTestsLeft(0);
            setOutcome({ kind: 'cap' });
            setFresh(true);
            return true;
          }
          if (status === 429 && code === 'game_capped') {
            setOutcome({ kind: 'game_cap' });
            setFresh(true);
            return true;
          }
          return false;
        },
      );
    },
    [run, tokenId, testsLeft],
  );

  /** «Save code»: only the code a test run passed (the server checks the same), with the functions as ticked. */
  const save = useCallback(
    () => {
      if (!fitsCode(fields.current.code)) return Promise.resolve();
      return run(
        'save',
        (token) => workerApi.saveCode(token, tokenId, { code: fields.current.code, ticks: fields.current.ticks }),
        () => {
          dirty.current = false;
          close();
          hostRef.current.done({ kind: 'saved' });
        },
        (status, code) => {
          if (status === 409 && code === 'not_tested') {
            setPassedCode(null);
            setStale(true);
            return true;
          }
          return false;
        },
      );
    },
    [run, tokenId, close],
  );

  /** «Remove code». */
  const remove = useCallback(
    () =>
      run(
        'remove',
        (token) => workerApi.removeCode(token, tokenId),
        () => {
          dirty.current = false;
          setCodeState('');
          setFnState('');
          setValuesState('');
          setPassedCode(null);
          close();
          hostRef.current.done({ kind: 'removed' });
        },
      ),
    [run, tokenId, close],
  );

  /** «Try again»: the request that did not come back, once more. */
  const again = useCallback(() => {
    if (top?.kind !== 'failed') return;
    void { load, test, save, remove }[top.again]();
  }, [top, load, test, save, remove]);

  const tooLong = !fitsCode(code);
  const canSave = loaded && !tooLong && code !== '' && passedCode === code;
  const canTest = loaded && !tooLong && testsLeft > 0 && code.trim() !== '' && fn.trim() !== '';

  return {
    open,
    loaded,
    code,
    fn,
    values,
    savedCode,
    written: savedCode !== null,
    functions,
    ticks,
    outcome,
    fresh,
    top,
    busy,
    testsLeft,
    tooLong,
    canSave,
    canTest,
    stale,
    fields,
    openSheet,
    close,
    setCode,
    setFn,
    setValues,
    tick,
    test,
    save,
    remove,
    again,
  };
}
