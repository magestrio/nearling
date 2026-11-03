import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi } from '../seams/worker';
import type { SkillRead, SourceView, Token } from '../seams/worker-types';

// The state machine of Skill sheet (`Skill sheet screen`, `Skill writing flow`). All of it is the tab's memory but the skill the server
// keeps: the two fields as typed, the outcome line at the body's top, what an unsaved close throws away. Writing a skill costs nothing
// and needs no awake pet, so nothing here reads the pet's food.

export interface SkillHost {
  tokenOf: () => Promise<Token | null>;
  /** the page's own answer to a refusal of the owner's right (`403 not_owner`: the page turns to the guest's) or of the session
   *  (`401`); the sheet closes with it */
  refused: (e: unknown) => void;
}

/** The line at the body's top: what the last «Save skill» or «Forget this skill» came to. */
export type SkillTop =
  | { kind: 'forgotten' }
  | { kind: 'failed'; again: 'save' | 'forget' }
  | { kind: 'session' }
  /** what a step of the sheet left behind: «Connected. …», «{label} removed. …», «Saved. {name} can run its code …» */
  | { kind: 'line'; text: string };

export type SkillPhase = 'closed' | 'loading' | 'error' | 'open';

const statusOf = (e: unknown) => (e instanceof WorkerError ? e.status : 0);
const codeOf = (e: unknown) => (e instanceof WorkerError ? e.code : '');

export function useSkill(tokenId: string, host: SkillHost, onSaved: (label: string | null, saved: boolean) => void) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const hostRef = useRef(host);
  hostRef.current = host;
  const [phase, setPhase] = useState<SkillPhase>('closed');
  const [label, setLabelState] = useState('');
  const [instruction, setInstructionState] = useState('');
  // the label the server keeps, null with no skill saved: «Forget this skill» is there, and the sheet's badge is solid while
  // the field still holds it
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const written = savedLabel !== null;
  // it was when the sheet opened: the title says «{name}'s skill» until the sheet closes, a forgotten skill too
  const [openedWritten, setOpenedWritten] = useState(false);
  const [top, setTop] = useState<SkillTop | null>(null);
  // the skill's outside parts as the server keeps them: its data sources and whether it has code (`Skill sheet` sockets)
  const [sources, setSources] = useState<SourceView[]>([]);
  const [hasCode, setHasCode] = useState(false);
  const [labelError, setLabelError] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useRef(0);
  const busyRef = useRef(false);

  const setLabel = useCallback((v: string) => {
    setLabelState(v);
    setLabelError(false);
  }, []);
  const setInstruction = useCallback((v: string) => setInstructionState(v), []);

  const fields = useRef({ label, instruction });
  fields.current = { label, instruction };

  const close = useCallback(() => {
    live.current += 1;
    setPhase('closed');
    setTop(null);
    setLabelError(false);
    setBusy(false);
    busyRef.current = false;
  }, []);

  /** Opens the sheet: the skill is read first (the instruction is decrypted for this answer only); a read that fails is the sheet's
   *  `error`. `typed` — both fields as a sign-in brought them back: open again, unsaved. */
  const open = useCallback(async (typed?: { label: string; instruction: string }): Promise<SkillRead | null> => {
    const gen = (live.current += 1);
    setTop(null);
    setLabelError(false);
    setPhase('loading');
    try {
      const token = await hostRef.current.tokenOf();
      if (token === null) {
        if (gen === live.current) setPhase('error');
        return null;
      }
      const answer = await workerApi.skill(token, tokenId);
      if (gen !== live.current) return null;
      setSources(answer.sources ?? []);
      setHasCode(answer.code != null);
      setSavedLabel(answer.skill?.label ?? null);
      setOpenedWritten(answer.skill !== null);
      setLabelState(typed?.label ?? answer.skill?.label ?? '');
      setInstructionState(typed?.instruction ?? answer.skill?.instruction ?? '');
      setPhase('open');
      return answer;
    } catch (e) {
      if (gen !== live.current) return null;
      if (statusOf(e) === 401 || (statusOf(e) === 403 && codeOf(e) === 'not_owner')) {
        close();
        hostRef.current.refused(e);
        return null;
      }
      setPhase('error');
      return null;
    }
  }, [tokenId, close]);

  /** The sockets again, from the server's read, after a step of the sheet (a source saved or removed, code saved or removed); the
   *  fields the player typed stay as they are. A skill that is gone (forgotten in another tab) turns the sockets off. */
  const refresh = useCallback(
    async (line?: string) => {
      const gen = live.current;
      try {
        const token = await hostRef.current.tokenOf();
        const answer = await workerApi.skill(token, tokenId);
        if (gen !== live.current) return;
        setSources(answer.sources ?? []);
        setHasCode(answer.code != null);
        if (answer.skill === null) setSavedLabel(null);
      } catch (e) {
        if (gen !== live.current) return;
        if (statusOf(e) === 403 && codeOf(e) === 'not_owner') {
          close();
          hostRef.current.refused(e);
        } else if (statusOf(e) === 401) {
          // the session ended under a step of the sheet (Adapter sheet, Skill code sheet): the sheet and both fields stay, with the
          // line of `Session expiry flow` — unless the step's own outcome line came with it (that one is true, and the next tap says
          // the session ended)
          authRef.current.endSession(true, true);
          if (line === undefined) setTop({ kind: 'session' });
        }
        // any other failure leaves the sockets as the sheet last drew them
      } finally {
        if (gen === live.current && line !== undefined) setTop({ kind: 'line', text: line });
      }
    },
    [tokenId, close],
  );

  /** A line at the body's top, in the sheet's own outcome place. */
  const note = useCallback((text: string) => setTop({ kind: 'line', text }), []);

  const fail = useCallback(
    (e: unknown, again: 'save' | 'forget') => {
      const status = statusOf(e);
      if (status === 401 || (status === 403 && codeOf(e) === 'not_owner')) {
        close();
        hostRef.current.refused(e);
        return;
      }
      setTop({ kind: 'failed', again });
    },
    [close],
  );

  /** «Save skill». A session that ended meets the line of `Session expiry flow` instead: nothing is sent, the fields stay. */
  const save = useCallback(async () => {
    const f = fields.current;
    // text is text: a label of spaces is the server's to refuse (`label not accepted`)
    if (busyRef.current || f.label === '' || f.instruction === '') return;
    if (!authRef.current.needSession()) {
      setTop({ kind: 'session' });
      return;
    }
    const gen = live.current;
    busyRef.current = true;
    setBusy(true);
    setTop(null);
    try {
      const token = await hostRef.current.tokenOf();
      const saved = await workerApi.saveSkill(token, tokenId, { label: f.label, instruction: f.instruction });
      if (gen !== live.current) return;
      // the sheet closes on a save; Pet screen shows the label and says it
      close();
      onSaved(saved.skill.label, true);
    } catch (e) {
      if (gen !== live.current) return;
      if (statusOf(e) === 400 && codeOf(e) === 'bad_label') setLabelError(true);
      else fail(e, 'save');
    } finally {
      if (gen === live.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [tokenId, close, fail, onSaved]);

  /** «Forget this skill»: the skill is gone, the fields keep their text until the sheet closes. */
  const forget = useCallback(async () => {
    if (busyRef.current) return;
    if (!authRef.current.needSession()) {
      setTop({ kind: 'session' });
      return;
    }
    const gen = live.current;
    busyRef.current = true;
    setBusy(true);
    setTop(null);
    try {
      const token = await hostRef.current.tokenOf();
      await workerApi.forgetSkill(token, tokenId);
      if (gen !== live.current) return;
      setSavedLabel(null);
      setSources([]);
      setHasCode(false);
      setTop({ kind: 'forgotten' });
      onSaved(null, false);
    } catch (e) {
      if (gen !== live.current) return;
      fail(e, 'forget');
    } finally {
      if (gen === live.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [tokenId, fail, onSaved]);

  const again = useCallback(() => {
    if (top?.kind === 'failed') void (top.again === 'save' ? save() : forget());
  }, [top, save, forget]);

  return { phase, label, setLabel, instruction, setInstruction, sources, hasCode, refresh, note, written, savedLabel, openedWritten, top, labelError, busy, open, close, save, forget, again, fields };
}
