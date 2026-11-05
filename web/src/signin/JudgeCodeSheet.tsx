import { Button, Sheet, Stack, TextField } from '../ds';
import { config } from '../config';
import { petPath } from '../route';

export type JudgeError = 'unavailable' | 'invalid' | 'exhausted' | 'expired' | null;

const ERRORS: Record<Exclude<JudgeError, null>, string> = {
  unavailable: "We couldn't check that code. Try again.",
  invalid: "That code doesn't work. Check it and try again.",
  exhausted: 'This code has used both places. You can still explore the demo.',
  expired: 'This judge code has expired. You can still explore the demo.',
};

export function JudgeCodeSheet({ code, error, busy, onCode, onSubmit, onClose, returnFocusTo }: {
  code: string;
  error: JudgeError;
  busy: boolean;
  onCode: (code: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  returnFocusTo: () => HTMLElement | null;
}) {
  const terminal = error === 'exhausted' || error === 'expired';
  const words = error ? ERRORS[error] : '';
  return (
    <Sheet title="Have a judge code? Enter it to make your own pet." centered status={words} busy={busy} onClose={onClose} returnFocusTo={returnFocusTo}>
      <Stack gap={3}>
        <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
          <Stack gap={3}>
            <TextField label="Judge code" value={code} onChange={onCode} error={words || undefined} disabled={busy} />
            {terminal ? (
              <Button block href={config.demoPetId ? petPath(config.demoPetId) : undefined} disabled={!config.demoPetId}>
                View demo pet
              </Button>
            ) : (
              <Button block type="submit" disabled={busy}>{error === 'unavailable' ? 'Try again' : 'Continue with Google'}</Button>
            )}
          </Stack>
        </form>
      </Stack>
    </Sheet>
  );
}
