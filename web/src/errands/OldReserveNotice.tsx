import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Cluster, Note, Stack, Text } from '../ds';
import { useAuth } from '../seams/auth';
import { workerApi, WorkerError } from '../seams/worker';
import { closeApproval, nearAmount } from './sharedApproval';

type Reserve = { jobHash: string; amountYocto: string } | null;
type Phase = 'ready' | 'pending' | 'failed' | 'done';

// spec: add-pet-errands › Friend-funded errand flow › old reserve after memory clear and gift
// spec: add-pet-errands › Friend-funded errand flow › new owner releases old reserve
// spec: add-pet-errands › Friend-funded errand flow › old reserve release rejected
export function OldReserveNotice({ tokenId, name, reserve, onReleased }: {
  tokenId: string; name: string; reserve: Reserve; onReleased: () => void;
}) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const [phase, setPhase] = useState<Phase>('ready');
  const [released, setReleased] = useState<bigint | null>(null);
  const outcomeId = useId();
  const busy = useRef(false);
  const jobHash = reserve?.jobHash;
  const shownHash = useRef(jobHash);
  useEffect(() => {
    if (jobHash && shownHash.current !== jobHash) { setPhase('ready'); setReleased(null); }
    shownHash.current = jobHash;
  }, [jobHash]);
  useEffect(() => {
    if (phase === 'failed' || phase === 'done') document.getElementById(outcomeId)?.focus();
  }, [phase, outcomeId]);

  const check = useCallback(async () => {
    const token = await authRef.current.getIdentityToken();
    if (!token) return;
    try {
      const latest = await workerApi.pet(token, tokenId);
      if (latest.viewer === 'owner' && latest.oldSharedReserve === null) {
        setReleased(reserve ? BigInt(reserve.amountYocto) : null);
        setPhase('done');
        onReleased();
      }
    } catch { /* An unknown close keeps checking the same chain-backed read. */ }
  }, [tokenId, reserve?.amountYocto, onReleased]);
  useEffect(() => {
    if (phase !== 'pending') return;
    const timer = setInterval(() => { if (!document.hidden) void check(); }, 2500);
    const visible = () => { if (!document.hidden) void check(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [phase, check]);

  const release = async () => {
    if (!reserve || busy.current || !auth.needSession()) return;
    busy.current = true;
    setPhase('pending');
    try {
      const token = await auth.getIdentityToken();
      if (!token || !auth.nearAccountId) throw new WorkerError(401, 'signed_out');
      let approval;
      try { approval = await closeApproval(tokenId, auth.nearAccountId, auth.signNearHash, reserve.jobHash); }
      catch { setPhase('failed'); return; }
      const result = await workerApi.releaseSharedReserve(token, tokenId, approval);
      if ('ok' in result) {
        setReleased(BigInt(reserve.amountYocto));
        setPhase('done');
        onReleased();
      }
    } catch (error) {
      if (error instanceof WorkerError && error.status === 401) auth.endSession(true, true);
      else if (error instanceof WorkerError && error.status !== 0 && error.status !== 503) setPhase('failed');
      // A missing response can be a confirmed close: keep polling before offering a new approval.
    } finally { busy.current = false; }
  };

  if (phase === 'done') return released === null ? null : <Note tone="status" id={outcomeId} tabIndex={-1}>{`${nearAmount(released)} of food is ready for ${name}.`}</Note>;
  if (!reserve) return null;
  return <Stack gap={2}>
    <Cluster gap={2} align="center"><Text>{`${nearAmount(BigInt(reserve.amountYocto))} of food waits for an old job —`}</Text><Button variant="secondary" size="compact" off={phase === 'pending'} onClick={() => void release()}>Release</Button></Cluster>
    {phase === 'pending' ? <Note tone="status">Releasing food…</Note> : null}
    {phase === 'failed' ? <Cluster gap={2}><Note tone="error" id={outcomeId} tabIndex={-1}>We couldn't release this food. Try again.</Note><Button variant="secondary" size="compact" onClick={() => void release()}>Try again</Button></Cluster> : null}
  </Stack>;
}
