import { useEffect, useId, useRef } from 'react';
import { Button, Note, Sheet, Stack, Text } from '../ds';
import { resetTime } from '../lib/time';
import { useClearMemory } from './useClearMemory';
import { sharedJobOf } from '../errands/sharedApproval';
import { useState } from 'react';
import { useAuth } from '../seams/auth';
import { workerApi } from '../seams/worker';

// Clear memory dialog screen (add-account) built from design/bundle/screens/account.js › clearDialog: a centred alert dialog
// whose focus lands on «Keep memory», never on the destructive «Clear memory». The words are the Scenarios'. The error line
// takes the focus where it stands (the sheet's status stays silent: the line is `role="alert"`).
const BUSY = 'Lots of visitors right now. Try again in a minute.';

const forgets = (name: string) =>
  `${name} will forget your chats, diary, skill with its data sources and code, and what it knows about you, its feeders and the pets it helped. Your published data sources leave the catalog. A backup may keep a copy up to 30 days; NEAR AI may keep what it received.`;
const SHARED_JOB = (name: string) => `Clearing memory will close this shared link. You'll sign approval so unused food can return to ${name}.`;
const stays = (name: string, time: string) =>
  `${name}'s name, character, growth, streak, outfits and food stay, and what's on the chain about ${name} stays public forever. An answer to today's riddle is cleared too and won't be checked at ${time}. Old thought receipts can't be fully checked after this. This can't be undone.`;
const EXPERIENCE_WARNING = 'Work notes and the public field will be erased. Paid work counts and receipts stay public forever.';
const clearing = (name: string) => `Clearing ${name}'s memory…`;
const failed = (name: string) => `We couldn't clear ${name}'s memory. Nothing was erased — try again.`;
const WILL_FAILED = "Memory wasn't cleared. Try again.";
const unknown = (name: string) => `We couldn't confirm whether ${name}'s memory was cleared. Reload to see where things stand.`;

export function ClearMemoryDialog({
  tokenId,
  name,
  onClose,
  onDone,
  onRetry,
  onNotOwner,
  returnFocusTo,
  unsettledSharedJob = false,
}: {
  tokenId: string;
  name: string;
  onClose: () => void;
  onDone: (hadExperience: boolean) => void;
  onRetry: (hadExperience: boolean) => void;
  onNotOwner: () => void;
  returnFocusTo: () => HTMLElement | null;
  unsettledSharedJob?: boolean;
}) {
  const auth = useAuth();
  const [hasExperience, setHasExperience] = useState<boolean | null>(null);
  const { phase, clear } = useClearMemory(tokenId, { done: () => onDone(hasExperience !== false), retry: () => onRetry(hasExperience !== false), notOwner: onNotOwner, close: onClose });
  const [hasSharedJob, setHasSharedJob] = useState(unsettledSharedJob);
  useEffect(() => {
    let live = true;
    void sharedJobOf(tokenId).then((pet) => {
      if (live) setHasSharedJob(Boolean(pet?.shared_job && pet.shared_job.state !== 'settled'));
    }).catch(() => {});
    return () => { live = false; };
  }, [tokenId]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const token = await auth.getIdentityToken();
      if (!token) return;
      const [notes, record] = await Promise.allSettled([workerApi.experience(token, tokenId), workerApi.workRecord(tokenId)]);
      if (!live) return;
      if (notes.status === 'fulfilled' && (notes.value.notes.length > 0 || notes.value.field !== null)) setHasExperience(true);
      else if (record.status === 'fulfilled' && (record.value.counts.paidHires > 0 || record.value.counts.completedErrands > 0 || record.value.field !== null)) setHasExperience(true);
      else if (notes.status === 'fulfilled' && record.status === 'fulfilled') setHasExperience(false);
    })().catch(() => {});
    return () => { live = false; };
  }, [tokenId, auth]);
  const busy = phase.kind === 'clearing';
  const failure = phase.kind === 'error' ? phase.why : null;
  const lineId = useId();
  const actions = useRef<HTMLDivElement>(null);

  // The safe action takes the focus on open (the Sheet's own focus runs first, on its first control, «Close»).
  useEffect(() => {
    actions.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  // An error is said by its own line, which takes the focus.
  useEffect(() => {
    if (failure) document.getElementById(lineId)?.focus();
  }, [failure, lineId]);

  const line = failure === 'unknown' ? unknown(name) : failure === 'busy' ? BUSY : failure === 'failed' ? (phase.kind === 'error' && phase.hasWish ? WILL_FAILED : failed(name)) : null;
  const act =
    failure === 'unknown' ? (
      <Button block variant="danger" onClick={() => window.location.reload()}>
        Reload
      </Button>
    ) : failure ? (
      <Button block variant="danger" onClick={() => void clear()}>
        Try again
      </Button>
    ) : (
      <Button block variant="danger" pending={busy} pendingLabel={clearing(name)} onClick={() => void clear()}>
        Clear memory
      </Button>
    );

  return (
    <Sheet
      title={`Clear ${name}'s memory?`}
      centered
      alert
      busy={busy}
      status={busy ? clearing(name) : ''}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      {line ? (
        <Note tone="error" id={lineId} tabIndex={-1}>
          {line}
        </Note>
      ) : null}
      <Text>{forgets(name)}</Text>
      {hasSharedJob ? <Note tone="plain">{SHARED_JOB(name)}</Note> : null}
      <Text>{stays(name, resetTime())}</Text>
      <div ref={actions}>
        <Stack gap={2}>
          <Button block disabled={busy} onClick={onClose}>
            Keep memory
          </Button>
          {hasExperience !== false ? <Text variant="small">{EXPERIENCE_WARNING}</Text> : null}
          {act}
        </Stack>
      </div>
    </Sheet>
  );
}
