import { useEffect, useState } from 'react';
import { Button, Live, Note, Stack } from '../ds';
import { useAuth } from '../seams/auth';
import { monthOf } from './gate';
import { thisBrowser } from './inApp';
import { useOutcome } from './outcome';
import { SESSION_LINE } from './session';
import { useSignIn } from './signIn';

// The line under the action that started a sign-in, when it did not end in a session (add-account › Sign-in flow, from
// design/bundle/screens/account.js › outcome): «вход не удался», «новый после Google», «запасной путь на телефоне», and the
// gate that could not be read at the tap (`Connection rule` › «сервер недоступен», «слишком много запросов»: no walk to Google),
// and, where there is no Composer, the line of a session that ended under the page (`Session expiry flow`). The line is drawn
// silent and said by a Live that is on the page before its words. The page keeps the place and the action it had. The owner's
// page has a Composer: it takes the same lines from `useSignInLines` and stands the first in the field's note.
const FAILED = "We couldn't sign you in with Google. Try again in a moment.";
const FALLBACK = 'Trouble signing in? Try it in your browser.';
const UNREACHABLE = "We can't reach the game right now. Try again in a moment.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';

/** A page's first frame comes before the words: a region that gets them in the task that mounted it is one mounted with them. */
export const LIVE_WAIT_MS = 100;

export interface SignInLine {
  text: string;
  /** a failure: its line carries the coral icon where the page draws it that way (`column`) */
  failed?: boolean;
  action?: { label: string; onClick: () => void };
}

export interface SignInLinesOptions {
  /** the Connection rule's words of the screen it stands on */
  unreachable?: string;
  /** the text in the screen's field (the Hatch screen's name, the owner's draft), kept in the tab through a sign-in from the
   *  ended-session line */
  text?: string;
  /** what the tap on «Sign in» carries back: the action the player was at (the sheet it was on: `skill`, `errand`, `adapter`,
   *  `code`), `signin` by default */
  action?: 'signin' | 'skill' | 'errand' | 'adapter' | 'code';
}

/** What a sign-in, a read of the gate at its tap, or the end of a session left on this screen, in the order they are read. An
 *  outcome is newer than the ended session's line, which a tap on it began. A cancel has no line of its own on a desktop, so
 *  «Sign in» stays the way on. */
export function useSignInLines({ unreachable = UNREACHABLE, text, action = 'signin' }: SignInLinesOptions = {}): SignInLine[] {
  const auth = useAuth();
  const outcome = useOutcome();
  const { begin, readFailed, retry, openInBrowser } = useSignIn();
  const [phone] = useState(() => thisBrowser().phone);
  const tap = () => begin(action, text ? { text } : undefined);

  if (readFailed) return [{ text: readFailed === 'busy' ? BUSY : unreachable, action: { label: 'Try again', onClick: retry } }];
  const lines: SignInLine[] = [];
  if (outcome?.kind === 'mau') {
    lines.push({
      text: `Looks like you haven't played here this month, so we can't sign you in until ${monthOf(outcome.until ?? '')} 1. You can still look around.`,
    });
  } else if (outcome?.kind === 'failed') {
    lines.push({ text: FAILED, failed: true, action: { label: 'Try again', onClick: tap } });
  } else if (auth.sessionLine) {
    // a tap needed the session that ended while this page was open
    lines.push({ text: SESSION_LINE, action: { label: 'Sign in', onClick: tap } });
  }
  // a phone's sign-in that came back with no session, cancelled or not working: the way out to a real browser
  if (phone && outcome && outcome.kind !== 'mau') {
    lines.push({ text: FALLBACK, action: { label: 'Open in browser', onClick: () => openInBrowser('signin') } });
  }
  return lines;
}

/** The lines as the frames draw them, silent: a Live says them. `column` — the guest's page under its action (design/bundle/
 *  screens/account.js › outcome): the lines at the start of the column, a failure with its coral icon, the ways on as compact
 *  secondary buttons. */
export function SignInLines({ lines, column }: { lines: SignInLine[]; column?: boolean }) {
  if (lines.length === 0) return null;
  return (
    <Stack gap={2} align={column ? 'flex-start' : 'center'}>
      {lines.map((line) => (
        <Stack key={line.text} gap={2} align={column ? 'flex-start' : 'center'}>
          <Note tone={column && line.failed ? 'error' : 'plain'} silent>
            {line.text}
          </Note>
          {line.action ? (
            <Button variant={column ? 'secondary' : 'ghost'} size="compact" onClick={line.action.onClick}>
              {line.action.label}
            </Button>
          ) : null}
        </Stack>
      ))}
    </Stack>
  );
}

export function SignInOutcome({ column, ...options }: SignInLinesOptions & { column?: boolean }) {
  const lines = useSignInLines(options);
  const said = lines.map((l) => l.text).join(' ');
  // a screen can mount this with its lines (an outcome that was set before the screen under it existed): the Live goes on the
  // page empty and the words come after, or they are not heard
  const [heard, setHeard] = useState('');
  useEffect(() => {
    // emptied at once, so the same line after a «Try again» that failed as fast is a change, and is said again
    if (said === '') {
      setHeard('');
      return undefined;
    }
    const timer = setTimeout(() => setHeard(said), LIVE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [said]);

  return (
    <>
      <SignInLines lines={lines} column={column} />
      <Live>{heard}</Live>
    </>
  );
}
