import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Actions, Banner, Button, Dock, Header, Heading, Live, Meadow, Note, Only, Page, Shell, Stack, Text, Toast } from '../../ds';
import { closedWords } from '../../signin/ClosedSheet';
import { SignInOutcome } from '../../signin/SignInOutcome';
import { useSignIn } from '../../signin/signIn';
import { consumeSignedOutLine, peekSignedOutLine, SIGNED_OUT_LINE } from '../../signin/signOut';
import { toastHeld } from '../../seams/worker';
import { useHome } from './useHome';
import { MEADOW_PETS } from './meadowPets';

// Home screen (add-account › Home screen, Sign-out flow) follows design/bundle/screens/account.js › home: the header,
// hook, action and Meadow in the room below. The samples in Meadow have no account or chain state.
// A signed-in player never sees it (`useHome` leads them to their pet). The words are the Scenarios' and the frames' `copy`.
const HOOK = 'This pet pays for its own thoughts. When the money runs out, it falls asleep.';
const LEAD = 'Hatch a pet that talks with you, remembers you and grows up.';
const OPENING = 'Opening the game…';
const UNREACHABLE = "We can't reach the game right now. Try again in a moment.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';
const TITLE_ID = 'home-title';

export function HomeScreen() {
  const { view, tryAgain } = useHome();
  const { begin } = useSignIn();
  // after a sign-out: the Toast and the Live say it once, and the focus lands on the h1 (design/ds/README.md › Menu)
  const [fromSignOut] = useState(peekSignedOutLine);
  const [signedOut, setSignedOut] = useState(fromSignOut);
  const [toast, setToast] = useState(true);
  useEffect(() => () => consumeSignedOutLine(), []);

  // the error too: a server that is down fails the sign-out's call and Home's read alike, and the sign-out has no failure
  const shown = view.kind === 'signed-out' || view.kind === 'closed' || view.kind === 'error';
  const focused = useRef(false);
  useEffect(() => {
    if (!signedOut || !shown || focused.current) return;
    focused.current = true;
    document.getElementById(TITLE_ID)?.focus();
  }, [signedOut, shown]);

  if (view.kind === 'leaving') return null;

  const off = view.kind === 'loading' || view.kind === 'error';
  const entry = (block: boolean) => <Button href={off ? undefined : '/hatch'} disabled={off} block={block}>Hatch your pet</Button>;
  const returning = (block: boolean) => <Button block={block} onClick={() => begin('signin', { returning: true })}>Played here before? Sign in</Button>;
  const actions = (block: boolean) => <Actions>{action?.(block)}<Button variant="secondary" href={off ? undefined : '/hire'} disabled={off} block={block}>Find a pet to ask</Button></Actions>;
  let action: ((block: boolean) => ReactNode) | null = entry;
  let words: ReactNode = null;
  let status: ReactNode = '';
  let banner: ReactNode = null;
  if (view.kind === 'closed') {
    words = <Text align="center" measure>{closedWords(view.all, view.until)}</Text>;
    action = view.all ? null : returning;
  } else {
    if (view.kind === 'loading') words = <Note tone="status">{OPENING}</Note>;
  }
  if (view.kind === 'error') {
    const line = view.busy ? BUSY : UNREACHABLE;
    status = fromSignOut ? `${SIGNED_OUT_LINE} ${line}` : line;
    banner = (
      <Banner
        action={
          <Button variant="secondary" size="compact" onClick={tryAgain}>
            Try again
          </Button>
        }
      >
        {line}
      </Banner>
    );
  } else if (signedOut && shown) {
    status = SIGNED_OUT_LINE;
  }

  return (
    <Shell accent="none" fill header={<Header end={view.kind === 'closed' ? null : <Button variant="secondary" size="compact" disabled={off} onClick={() => begin('signin')}>Sign in</Button>} />}>
      <Page width="default">
        <Stack gap={5}>
          {banner}
          <Stack gap={4} align="center">
            <Heading level={1} variant="display" wide align="center" id={TITLE_ID} tabIndex={signedOut && shown ? -1 : undefined}>{HOOK}</Heading>
            <Text variant="lead" align="center">{LEAD}</Text>
            {words}
            <Only on="desktop">{actions(false)}</Only>
            {off ? null : <SignInOutcome />}
          </Stack>
        </Stack>
      </Page>
      <Page fill>
        <Only on="phone"><Dock>{actions(true)}</Dock></Only>
        <Meadow pets={MEADOW_PETS} motion />
      </Page>
      <Live>{status}</Live>
      {signedOut && shown && toast ? (
        <Toast
          icon="check"
          silent
          onDone={
            toastHeld()
              ? undefined
              : () => {
                  setToast(false);
                  setSignedOut(false);
                }
          }
        >
          {SIGNED_OUT_LINE}
        </Toast>
      ) : null}
    </Shell>
  );
}
