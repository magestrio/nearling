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
  action?: { label: string; onClick: () => void };
}

export interface SignInLinesOptions {
  /** the Connection rule's words of the screen it stands on */
  unreachable?: string;
  /** the text in the screen's field (the Hatch screen's name, the owner's draft), kept in the tab through a sign-in from the
   *  ended-session line */
  text?: string;
}

/** What a sign-in, a read of the gate at its tap, or the end of a session left on this screen, in the order they are read. An
 *  outcome is newer than the ended session's line, which a tap on it began. A cancel has no line of its own on a desktop, so
 *  «Sign in» stays the way on. */
export function useSignInLines({ unreachable = UNREACHABLE, text }: SignInLinesOptions = {}): SignInLine[] {
  const auth = useAuth();
  const outcome = useOutcome();
  const { begin, readFailed, retry, openInBrowser } = useSignIn();
  const [phone] = useState(() => thisBrowser().phone);
  const tap = () => begin('signin', text ? { text } : undefined);

  if (readFailed) return [{ text: readFailed === 'busy' ? BUSY : unreachable, action: { label: 'Try again', onClick: retry } }];
  const lines: SignInLine[] = [];
  if (outcome?.kind === 'mau') {
    lines.push({
      text: `Looks like you haven't played here this month, so we can't sign you in until ${monthOf(outcome.until ?? '')} 1. You can still look around.`,
    });
  } else if (outcome?.kind === 'failed') {
    lines.push({ text: FAILED, action: { label: 'Try again', onClick: tap } });
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

/** The lines as the frames draw them, silent: a Live says them. */
export function SignInLines({ lines }: { lines: SignInLine[] }) {
  if (lines.length === 0) return null;
  return (
    <Stack gap={2} align="center">
      {lines.map((line) => (
        <Stack key={line.text} gap={2} align="center">
          <Note tone="plain" silent>
            {line.text}
          </Note>
          {line.action ? (
            <Button variant="ghost" size="compact" onClick={line.action.onClick}>
              {line.action.label}
            </Button>
          ) : null}
        </Stack>
      ))}
    </Stack>
  );
}

export function SignInOutcome(options: SignInLinesOptions) {
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
      <SignInLines lines={lines} />
      <Live>{heard}</Live>
    </>
  );
}
