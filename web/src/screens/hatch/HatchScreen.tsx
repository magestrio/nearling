import { useId, type FormEvent, type ReactNode } from 'react';
import { Block, Button, Center, Centerpiece, Cluster, DisclosureLine, Egg, Header, Heading, Nest, Note, Page, Shell, Stack, Text, TextField, TextLink } from '../../ds';
import { AccountControl } from '../../account/AccountControl';
import { resetTime } from '../../lib/time';
import { petPath } from '../../route';
import { useAuth } from '../../seams/auth';
import { SignInOutcome } from '../../signin/SignInOutcome';
import { useSignIn } from '../../signin/signIn';
import { useHatch } from './useHatch';
import './hatch.css';

// Hatch screen (add-pet › Hatch screen, Birth flow) built from design/bundle/screens/hatch.js: one centred column — the
// Egg, the heading, the name field with its lines, the two notices, then «Hatch my pet» or what stands in its place.
// On the phone the form scrolls and that action is pinned to the bottom (Centerpiece `scroll`). No pet yet: the accent
// of «no pet». The words are the Scenarios' and the frames' `copy`, verbatim.
const LIMIT_HINT = 'Up to 32 characters — fewer with emoji or accents.';
const PUBLIC_HINT = 'This name is public forever — even if this game shuts down.';
const RECEIPTS_LINE = "A thought's receipt shows how long the reply was and whether your pet thought hard — never what was said.";
const SAVED_LINE = "Saved food and a bought outfit are public on NEAR forever. The wish's words stay private.";
const AI_NOTICE =
  "To write your pet's replies, we send NEAR AI what you say and what your pet remembers about you and the friends who feed it. When your pet asks another pet for help, the question it writes goes to that pet too.";
const PAUSED = 'New pets are paused for now. You can still feed and visit pets you know.';
const CHECKING = 'Checking if hatching is open…';
const HATCHING = 'Hatching…';
const UNREACHABLE = "We can't reach the game right now. Try again in a moment.";
const BUSY = 'Lots of visitors right now. Try again in a minute.';
const NOT_HATCHED = "Your pet didn't hatch this time. Nothing was lost — try again.";

/** The first notice names the pet once there is a name; with none — «Your pet's name, character, ID, …». */
function publicNotice(name: string): string {
  const subject = name ? `Your pet's name "${name}", character` : "Your pet's name, character";
  return `${subject}, ID, hatch date, owner and who gave it to whom, growth, traits, streak and freezes (so the days you finish its ritual), every outfit, meal and thought receipt, every pet it asks for help or helps, whether a skill shaped it, and every price and fee are public forever — even if this game shuts down.`;
}

/** The two notices beside a pet on the Gift screen are the Hatch screen's own words. */
export function HatchNotices({ name }: { name: string }) {
  return <Stack gap={3}>
    <Block role="trust" icon="globe" quiet><Text variant="small">{publicNotice(name)}</Text><Text variant="small">{SAVED_LINE}</Text><Text variant="small">{RECEIPTS_LINE}</Text></Block>
    <Block role="mind" icon="bulb" quiet><Text variant="small">{AI_NOTICE}</Text></Block>
  </Stack>;
}

/** The Hatch consent stays in its button; each short notice opens its existing complete text independently. */
export function HatchDisclosureNotices({ name, sessionKey }: { name: string; sessionKey: string }) {
  return <Stack gap={2} key={sessionKey}>
    <DisclosureLine summary="Your pet's name, character and on-chain history are public forever." label="Read what's public">
      <Text variant="small">{publicNotice(name)}</Text>
      <Text variant="small">{SAVED_LINE}</Text>
      <Text variant="small">{RECEIPTS_LINE}</Text>
    </DisclosureLine>
    <DisclosureLine summary="Your words and your pet's memories about you and friends who feed it go to NEAR AI." label="Read what goes to NEAR AI">
      <Text variant="small">{AI_NOTICE}</Text>
    </DisclosureLine>
  </Stack>;
}

/** A line why, then what can be done — the one place for every «why» of this screen. The line is silent where it is
 *  drawn: the page's live region says it. */
function Why({ line, tone = 'plain', children }: { line: string; tone?: 'plain' | 'status' | 'error'; children?: ReactNode }) {
  return (
    <Stack gap={3}>
      <Note tone={tone} silent>
        {line}
      </Note>
      {children}
    </Stack>
  );
}

export function HatchScreen({ from }: { from: string | null }) {
  const auth = useAuth();
  const hatch = useHatch(from);
  const { begin } = useSignIn();
  const titleId = useId();
  const { view, name, cleaned, birth } = hatch;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (view.kind === 'form') void hatch.submit();
  };

  // «Account» stands in the header of every screen where the player has a session (`Account menu screen`)
  const header = auth.authenticated ? <Header end={<AccountControl />} /> : null;

  if (view.kind === 'already') {
    return (
      <Shell accent="none" header={<Header end={<AccountControl />} />}>
        <Page fill width="narrow">
          <Center>
            <Heading level={1} variant="lead" align="center" measure>
              You've already hatched a pet — one per player.
            </Heading>
            <Button href={petPath(view.tokenId)}>{`Go to ${view.name}`}</Button>
            <SignInOutcome text={name} />
          </Center>
        </Page>
      </Shell>
    );
  }

  if (view.kind === 'no-pets') {
    const { tokenId, name: giftedName } = view.lastGifted;
    const closedLine = view.reason === 'daily'
      ? `That's all the new pets for today. Hatching is back at ${resetTime(view.until)}. You can still feed and visit pets you know.`
      : PAUSED;
    return <Shell accent="none" header={header}>
      <Page fill width="narrow"><Center>
        <Nest />
        {view.closed ? <Note>{closedLine}</Note> : null}
        <Heading level={1} variant="lead" align="center" measure>{`You gave ${giftedName} a new home, so you don't have a pet right now. You can still feed and visit pets you know — and if someone gives you a pet, it'll show up here.`}</Heading>
        <Cluster gap={3} justify="center">
          <Button href={petPath(tokenId)}>{`Visit ${giftedName}`}</Button>
          {hatch.friend && hatch.friend !== 'loading' ? <Button variant="secondary" href={petPath(hatch.friend.tokenId)}>{`Back to ${hatch.friend.name}`}</Button> : null}
        </Cluster>
      </Center></Page>
    </Shell>;
  }

  // The way out of a closed screen: a player who never hatched and has no friend link can find a pet to ask.
  const noExit = view.kind === 'closed' && view.noPets;
  // «Find a pet to ask» stands under every Hatch state (frames `hatch-closed-today`: beside «Back to {friend_pet}»); in the
  // no-exit state it is the exit itself, so the line is not drawn a second time
  const showDiscoveryLink = !noExit;
  // The friend's pet is the exit of a closed screen: a quiet link under «Find a pet to ask» (frame `hatch-closed-today`)
  const friendExit = view.kind === 'closed' && hatch.friend && hatch.friend !== 'loading' ? hatch.friend : null;
  const wayOut =
    from && hatch.friend === 'loading' ? null : friendExit ? null : noExit ? <Button block variant="secondary" href="/hire">Find a pet to ask</Button> : (
      <Button block href="/">
        Go home
      </Button>
    );

  const hatchButton = (disabled: boolean) => (
    <Button block disabled={disabled} type="submit">
      Hatch my pet
    </Button>
  );

  let line = '';
  let action: ReactNode;
  switch (view.kind) {
    case 'checking':
      line = CHECKING;
      action = (
        <Why line={CHECKING} tone="status">
          {hatchButton(true)}
        </Why>
      );
      break;
    case 'unreachable': {
      line = view.busy ? BUSY : UNREACHABLE;
      action = (
        <Why line={line} tone="error">
          <Button block onClick={hatch.tryAgain}>
            Try again
          </Button>
          {hatchButton(true)}
        </Why>
      );
      break;
    }
    case 'closed':
      line =
        view.reason === 'daily'
          ? `That's all the new pets for today. Hatching is back at ${resetTime(view.until)}. You can still feed and visit pets you know.`
          : PAUSED;
      action = <Why line={line}>{wayOut}</Why>;
      break;
    case 'signed-out':
      action = (
        <Button block onClick={() => begin('signin')}>
          Sign in with Google to hatch your pet
        </Button>
      );
      break;
    case 'form':
      if (birth === 'not_hatched') {
        line = NOT_HATCHED;
        action = (
          <Why line={NOT_HATCHED} tone="error">
            <Button block onClick={() => void hatch.submit()}>
              Try again
            </Button>
          </Why>
        );
      } else if (birth === 'hatching') {
        line = HATCHING;
        action = (
          <Button block pending pendingLabel={HATCHING}>
            Hatch my pet
          </Button>
        );
      } else {
        action = hatchButton(name === '');
      }
      break;
  }

  return (
    <div className="ds-eggpage"><Shell accent="none" fill header={header}>
      <Page fill width="narrow">
        <form className="hatch-form" onSubmit={onSubmit} noValidate>
          {/* under the action in every view: the session can end under any of them, and a tap on «Account» then has the line
              and «Sign in» here; the name stays */}
          <Centerpiece
            scroll
            labelledBy={titleId}
            actions={
              <Stack gap={2}>
                {action}
                {showDiscoveryLink || friendExit ? <Stack gap={1}>
                  {showDiscoveryLink ? <TextLink href="/hire" tone="quiet" hit>Find a pet to ask</TextLink> : null}
                  {friendExit ? <TextLink href={petPath(friendExit.tokenId)} tone="quiet" hit>{`Back to ${friendExit.name}`}</TextLink> : null}
                </Stack> : null}
                <SignInOutcome text={name} />
              </Stack>
            }
            status={line}
          >
            <div className="ds-eggpage__form ds-stack" style={{ gap: 'var(--space-5)' }}>
              <Egg cracking={birth === 'hatching'} />
              <Heading level={1} align="center" id={titleId}>
                Hatch your pet
              </Heading>
              <TextField
                label="Name your pet"
                placeholder="e.g. Pixel"
                value={name}
                onChange={hatch.setName}
                readOnly={birth === 'hatching'}
                error={hatch.nameRefused ? "Let's pick a different name." : undefined}
                hint={cleaned ? [LIMIT_HINT, PUBLIC_HINT] : LIMIT_HINT}
              />
              <HatchDisclosureNotices name={cleaned} sessionKey={auth.authenticated ? auth.nearAccountId ?? 'pending-account' : 'signed-out'} />
            </div>
          </Centerpiece>
        </form>
      </Page>
    </Shell></div>
  );
}
