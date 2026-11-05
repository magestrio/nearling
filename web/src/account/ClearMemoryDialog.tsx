import { useEffect, useId, useRef } from 'react';
import { Button, Note, Sheet, Stack, Text } from '../ds';
import { resetTime } from '../lib/time';
import { useClearMemory } from './useClearMemory';

// Clear memory dialog screen (add-account) built from design/bundle/screens/account.js › clearDialog: a centred alert dialog
// whose focus lands on «Keep memory», never on the destructive «Clear memory». The words are the Scenarios'. The error line
// takes the focus where it stands (the sheet's status stays silent: the line is `role="alert"`).
const BUSY = 'Lots of visitors right now. Try again in a minute.';

const forgets = (name: string) =>
  `${name} will forget your chats, diary, skill with its data sources and code, and what it knows about you, its feeders and the pets it helped. Your published data sources leave the catalog. A backup may keep a copy up to 30 days; NEAR AI may keep what it received.`;
const SHARED_JOB = (name: string) => `Clearing memory will close this shared link. You'll sign approval so unused food can return to ${name}.`;
const stays = (name: string, time: string) =>
  `${name}'s name, character, growth, streak, outfits and food stay, and what's public about ${name} stays public forever. An answer to today's riddle is cleared too and won't be checked at ${time}. Old thought receipts can't be fully checked after this. This can't be undone.`;
const clearing = (name: string) => `Clearing ${name}'s memory…`;
const failed = (name: string) => `We couldn't clear ${name}'s memory. Nothing was erased — try again.`;
const unknown = (name: string) => `We couldn't confirm whether ${name}'s memory was cleared. Reload to see where things stand.`;

export function ClearMemoryDialog({
  tokenId,
  name,
  onClose,
  onDone,
  onNotOwner,
  returnFocusTo,
  unsettledSharedJob = false,
}: {
  tokenId: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
  onNotOwner: () => void;
  returnFocusTo: () => HTMLElement | null;
  unsettledSharedJob?: boolean;
}) {
  const { phase, clear } = useClearMemory(tokenId, { done: onDone, notOwner: onNotOwner, close: onClose });
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

  const line = failure === 'unknown' ? unknown(name) : failure === 'busy' ? BUSY : failure === 'failed' ? failed(name) : null;
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
      {unsettledSharedJob ? <Note tone="plain">{SHARED_JOB(name)}</Note> : null}
      <Text>{stays(name, resetTime())}</Text>
      <div ref={actions}>
        <Stack gap={2}>
          <Button block disabled={busy} onClick={onClose}>
            Keep memory
          </Button>
          {act}
        </Stack>
      </div>
    </Sheet>
  );
}
