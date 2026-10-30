import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Actions, Banner, Button, Centerpiece, Header, Heading, Nest, Note, Page, Shell, Stack, Text, Toast } from '../../ds';
import { closedWords } from '../../signin/ClosedSheet';
import { SignInOutcome } from '../../signin/SignInOutcome';
import { useSignIn } from '../../signin/signIn';
import { consumeSignedOutLine, peekSignedOutLine, SIGNED_OUT_LINE } from '../../signin/signOut';
import { useHome } from './useHome';

// Home screen (add-account › Home screen, Sign-out flow) built from design/bundle/screens/account.js › home: one centred
// stack — the Nest, the hook, the lead, then «Hatch your pet» and «Sign in», or in their place what the closed sign-in says.
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
  const entries = (
    <Actions>
      <Button href={off ? undefined : '/hatch'} disabled={off}>
        Hatch your pet
      </Button>
      <Button variant="secondary" disabled={off} onClick={() => begin('signin')}>
        Sign in
      </Button>
    </Actions>
  );

  let actions: ReactNode;
  let status: ReactNode = '';
  let banner: ReactNode = null;
  let note: ReactNode = null;
  if (view.kind === 'closed') {
    const words = closedWords(view.all, view.until);
    actions = view.all ? (
      <Text align="center">{words}</Text>
    ) : (
      <Stack gap={3}>
        <Text align="center">{words}</Text>
        <Button block onClick={() => begin('signin', { returning: true })}>
          Played here before? Sign in
        </Button>
      </Stack>
    );
  } else {
    actions = entries;
  }
  if (view.kind === 'loading') {
    note = <Note tone="status">{OPENING}</Note>;
  } else if (view.kind === 'error') {
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
    // the Toast stands in the header's band, which Home doesn't have: the Banner would lie under it
    <Shell accent="none" fill header={fromSignOut && view.kind === 'error' ? <Header /> : null}>
      <Page fill width="narrow">
        {banner}
        <Centerpiece
          actions={
            <Stack gap={3}>
              {actions}
              {/* what a sign-in begun here left when it came back with no session (`Sign-in flow` › «вход не удался», «новый
                  после Google», the phone's fallback): under the entries, once the page is there to be tapped */}
              {off ? null : <SignInOutcome />}
            </Stack>
          }
          status={status}
        >
          <Stack gap={4} align="center">
            <Nest />
            <Heading level={1} align="center" measure id={TITLE_ID} tabIndex={signedOut && shown ? -1 : undefined}>
              {HOOK}
            </Heading>
            <Text variant="lead" align="center">
              {LEAD}
            </Text>
            {note}
          </Stack>
        </Centerpiece>
      </Page>
      {signedOut && shown && toast ? (
        <Toast
          icon="check"
          silent
          onDone={() => {
            setToast(false);
            setSignedOut(false);
          }}
        >
          {SIGNED_OUT_LINE}
        </Toast>
      ) : null}
    </Shell>
  );
}
