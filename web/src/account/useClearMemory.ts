import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi } from '../seams/worker';
import { closeApproval, sharedJobOf } from '../errands/sharedApproval';

// `Memory deletion flow` › «стирает», «стёр», «уже не владелец» and the errors of `Clear memory dialog screen`; what the dialog reads
// from the answer is design.md › «What the dialog reads from the answer».
export type ClearPhase =
  | { kind: 'idle' }
  | { kind: 'clearing' }
  /** `failed`: the server said nothing was erased; `busy`: `429`; `unknown`: no answer, the outcome is not known */
  | { kind: 'error'; why: 'failed' | 'busy' | 'unknown' };

/** The answer that says nothing was erased: the server read it all and refused or failed before the batch. */
function nothingErased(e: WorkerError): boolean {
  if (e.status === 404) return true;
  if (e.status === 400 || e.status === 409) return e.code === 'close_refused';
  if (e.status === 500) return e.code === 'clear_failed';
  if (e.status === 503) return e.code === 'chain_unreachable' || e.code === 'auth_unavailable';
  return false;
}

export function useClearMemory(tokenId: string, outcome: { done: () => void; retry: () => void; notOwner: () => void; close: () => void }) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const out = useRef(outcome);
  out.current = outcome;
  const [phase, setPhase] = useState<ClearPhase>({ kind: 'idle' });
  // a repeat tap while the request is on its way sends nothing: the ref answers before the next render does
  const running = useRef(false);

  const clear = useCallback(async () => {
    if (running.current) return;
    // a session that ended while the dialog stood open: the dialog closes and the line stands instead
    if (!authRef.current.needSession()) {
      out.current.close();
      return;
    }
    running.current = true;
    setPhase({ kind: 'clearing' });
    try {
      const token = await authRef.current.getIdentityToken();
      if (token === null) throw new WorkerError(401, 'signed_out');
      let chain;
      try { chain = await sharedJobOf(tokenId); }
      catch { throw new WorkerError(503, 'chain_unreachable'); }
      if (chain === null) throw new WorkerError(503, 'chain_unreachable');
      let approval;
      if (chain.shared_job && chain.shared_job.state !== 'settled') {
        try { approval = await closeApproval(tokenId, authRef.current.nearAccountId ?? '', authRef.current.signNearHash, chain.shared_job.hash); }
        catch { throw new WorkerError(409, 'close_refused'); }
      }
      const result = await workerApi.clearMemory(token, tokenId, approval);
      if ('code' in result && result.code === 'close_retry') out.current.retry();
      else out.current.done();
    } catch (e) {
      const error = e instanceof WorkerError ? e : new WorkerError(0, 'unreachable');
      if (error.status === 401) {
        // `Session expiry flow`: the dialog closes, the same line, nothing erased
        out.current.close();
        authRef.current.endSession(true, true);
      } else if (error.status === 403) {
        out.current.notOwner();
      } else if (error.status === 429) {
        setPhase({ kind: 'error', why: 'busy' });
      } else if (nothingErased(error)) {
        setPhase({ kind: 'error', why: 'failed' });
      } else {
        setPhase({ kind: 'error', why: 'unknown' });
      }
    } finally {
      running.current = false;
    }
  }, [tokenId]);

  return { phase, clear };
}
