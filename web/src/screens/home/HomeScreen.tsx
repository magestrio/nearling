import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Actions, Banner, Button, Dock, Header, Heading, Live, Meadow, Note, Only, Page, Shell, Stack, Text, TextLink, Toast } from '../../ds';
import { config } from '../../config';
import { AccountControl } from '../../account/AccountControl';
import { closedWords } from '../../signin/ClosedSheet';
import { SignInOutcome } from '../../signin/SignInOutcome';
import { useOutcome } from '../../signin/outcome';
import { useSignIn } from '../../signin/signIn';
import { consumeSignedOutLine, peekSignedOutLine, SIGNED_OUT_LINE } from '../../signin/signOut';
import { toastHeld } from '../../seams/worker';
import { petPath } from '../../route';
import { useHome } from './useHome';
import { meadowNumbers, meadowPets } from './showcase';
import { useShowcase } from './useShowcase';
import './home.css';

// Home screen (add-account › Home screen, Sign-out flow) follows design/bundle/screens/account.js › home: the header,
// hook, action and Meadow in the room below. The public copy is independent of admission.
// A signed-in player with a pet goes to it; a petless player stays with the public meadow and discovery paths.
const HOOK = 'This pet pays for its own thoughts. When the money runs out, it falls asleep.';
const LEAD = 'Hatch a pet that talks with you, remembers you and grows up.';
const OPENING = 'Opening the game…';
const UNREACHABLE = "We can't reach the game right now. Try again in a moment.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';
const TITLE_ID = 'home-title';

export function HomeScreen() {
  const { view, tryAgain } = useHome();
  const showcase = useShowcase(view.kind !== 'leaving');
  const { begin, openJudge } = useSignIn();
  // a failed Google return after a judge code: the frame draws «Try Google again» in the phone's pinned Dock, under the entries
  const judgeFailed = useOutcome()?.kind === 'judge_failed';
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

  const petless = view.kind === 'petless' || view.kind === 'petless-loading' || view.kind === 'petless-error';
  const off = view.kind === 'loading' || view.kind === 'error';
  const entry = (block: boolean) => <Button href={off ? undefined : '/hatch'} disabled={off} block={block}>Hatch your pet</Button>;
  const returning = (block: boolean) => <Button block={block} onClick={() => begin('signin', { returning: true })}>Played here before? Sign in</Button>;
  const actions = (block: boolean, below?: ReactNode) => {
    const row = <Actions>{view.kind === 'petless-error'
      ? <Button variant="secondary" onClick={tryAgain} block={block}>Try again</Button>
      : action?.(block)}<Button variant="secondary" href={off ? undefined : '/hire'} disabled={off} block={block}>Find a pet to ask</Button></Actions>;
    return view.kind === 'closed' && !view.all
      ? <Stack gap={2} align="center">{row}<TextLink href="#judge" tone="quiet" iconEnd="chevron" onClick={openJudge}>Enter judge code</TextLink>{below}</Stack>
      : row;
  };
  let action: ((block: boolean) => ReactNode) | null = entry;
  let words: ReactNode = null;
  let status: ReactNode = '';
  let banner: ReactNode = null;
  if (petless) {
    const line = view.kind === 'petless-loading' ? 'Finding your pets…'
      : view.kind === 'petless-error' ? "We couldn't check your pets. Try again."
        : view.birth.open ? 'No pet of your own right now.'
          : view.birth.reason === 'daily' ? "That's all the new pets for today." : 'New pets are paused for now.';
    words = <Stack gap={2} align="center">
      <Text align="center">{line}</Text>
      {view.kind === 'petless' ? view.knownPets.map((pet) =>
        <TextLink key={pet.tokenId} href={petPath(pet.tokenId)} hit>Visit {pet.name}</TextLink>) : null}
    </Stack>;
    status = line;
  } else if (view.kind === 'closed') {
    words = <div className="home-closed-notice"><Text align="center" measure>{closedWords(view.all, view.until)}</Text></div>;
    action = view.all ? null : returning;
  } else if (view.kind === 'evidence') {
    action = null;
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
    <Shell accent="none" fill header={<Header end={view.kind === 'closed' ? null : view.kind === 'evidence' || petless ? <AccountControl /> : <Button variant="secondary" size="compact" disabled={off} onClick={() => begin('signin')}>Sign in</Button>} />}>
      <Page width="default">
        <Stack gap={petless ? 3 : 5}>
          {signedOut && shown && toast ? <div className="home-signout-spacer" aria-hidden="true" /> : null}
          {banner}
          <Stack gap={petless ? 2 : 4} align="center">
            <Heading level={1} variant={petless ? 'title-1' : 'display'} wide align="center" id={TITLE_ID} tabIndex={signedOut && shown ? -1 : undefined}>{HOOK}</Heading>
            <Text variant="lead" align="center">{LEAD}</Text>
            {words}
            {view.kind === 'evidence' ? null : <Only on="desktop">{actions(false, judgeFailed && !off ? <SignInOutcome /> : null)}</Only>}
            {off || judgeFailed ? null : <SignInOutcome />}
          </Stack>
        </Stack>
      </Page>
      <Page fill>
        <Meadow
          pets={showcase.kind === 'ready' ? meadowPets(showcase.copy) : []}
          label="Pets in the game"
          numbers={showcase.kind === 'loading' ? 'loading' : showcase.kind === 'ready' ? meadowNumbers(showcase.copy) : undefined}
          explore={<TextLink href={`https://${config.nearNetwork === 'testnet' ? 'testnet.' : ''}nearblocks.io/address/${encodeURIComponent(config.contractId)}`} external>See it on the NEAR explorer</TextLink>}
          motion
        />
        {view.kind === 'evidence' ? null : <Only on="phone"><Dock>{actions(true, judgeFailed && !off ? <SignInOutcome /> : null)}</Dock></Only>}
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
