import { useEffect, useRef } from 'react';
import { Button, Composer, Conversation, Dock, Inert, Live, Message, Note, Only, Stack, Text, Thinking, type Accent } from '../ds';
import { useFeedRequest } from '../feeding/feedRequest';
import { resetTime } from '../lib/time';
import { formatCents } from '../lib/price';
import { makePet } from '../pet/proto/generator.js';
import { runAction, type SlotProps } from '../screens/pet/parts';
import { pausedLine, WAIT_LINE } from '../screens/pet/lines';
import { useAuth } from '../seams/auth';
import { SignInLines, useSignInLines } from '../signin/SignInOutcome';
import {
  adviceButton,
  adviceClearedLine,
  adviceEmptyLine,
  adviceLabel,
  advicePlaceholder,
  cantPayLine,
  couldntHelpLine,
  feedMine,
  myPetTiredLine,
  paysLine,
  priceDropsLine,
  priceRoseLine,
  savedLine,
  SKILLED_LINE,
  skillShapesLine,
  workerAsleepLine,
  workerRestingLine,
} from './lines';
import { useAdvice, type Entry } from './useAdvice';

// The guest's advice column (add-pet-work › Advice flow), drawn from design/bundle/screens/pet.js › guestAdvice and work.js: the
// log where the owner's conversation stands, the field with «Ask {name} · {price}» in the Composer's end, and under it who pays.
// What stops an ask is one line in the button's place, the first of the five in the order of `several at once`.

const accentOf = (tokenId: string): Accent => makePet(tokenId).hue as Accent;

function EntryMessage({ entry, worker, myPet }: { entry: Entry; worker: { tokenId: string; name: string }; myPet: string }) {
  switch (entry.kind) {
    case 'asked':
      return (
        <Message from="player" speaker="You" fresh={entry.fresh}>
          {entry.text}
        </Message>
      );
    case 'answer': {
      // under the answer: where it is kept, then — when a private skill shaped it — what a check can't show (`Worker rule`)
      const meta = entry.skilled ? [savedLine(myPet), SKILLED_LINE] : savedLine(myPet);
      return (
        <Message
          from="worker"
          speaker={worker.name}
          hue={accentOf(worker.tokenId)}
          fresh={entry.fresh}
          verify={{ href: `/pet/${worker.tokenId}/verify/${entry.thoughtId}`, label: 'Check this thought' }}
          meta={meta}
        >
          {entry.text}
        </Message>
      );
    }
    case 'event':
      return (
        <Message from="event" fresh={entry.fresh}>
          {couldntHelpLine(worker.name)}
        </Message>
      );
    case 'error':
      // a cleared memory is the game's own event line, as on the hire side; only an answer lost in the empty case is an error
      return entry.code === 'cleared' ? (
        <Message from="event" fresh={entry.fresh}>
          {adviceClearedLine(myPet)}
        </Message>
      ) : (
        <Message from="error" fresh={entry.fresh}>
          {adviceEmptyLine(worker.name, myPet)}
        </Message>
      );
  }
}

/** The advice column of a friend's page for a player with a pet of their own. Without `advice` (a visitor, a guest with no pet) it
 *  draws nothing. */
export function AdviceColumn(props: SlotProps) {
  const { advice } = props;
  if (!advice) return null;
  return <Column {...props} advice={advice} />;
}

function Column({ tokenId, name, asleep, advice }: SlotProps & { advice: NonNullable<SlotProps['advice']> }) {
  const auth = useAuth();
  const myPet = advice.payer.name;
  const a = useAdvice({ tokenId, name, asleep }, advice);
  const { read, blocker } = a;
  const request = useFeedRequest();
  const signInLines = useSignInLines({ unreachable: advice.offline, text: a.draft });
  const [lead, ...moreLines] = signInLines;
  const signedOut = auth.sessionLine;

  const price = read ? formatCents(read.price.cents) : null;
  const until = (iso: string | null | undefined) => resetTime(iso);
  const line = (() => {
    switch (blocker) {
      case 'paused':
        // the pause line names the pet the player talks to (`Connection rule` › «разговор на паузе»)
        return pausedLine(name);
      case 'worker_asleep':
        return workerAsleepLine(name);
      case 'worker_resting':
        return workerRestingLine(name, until(read?.resting?.until));
      case 'cant_pay':
        return [cantPayLine(name, read?.price.cents ?? 0, myPet), read?.dropsAt ? priceDropsLine(name, until(read.dropsAt)) : null].filter(Boolean).join(' ');
      case 'tired':
        return myPetTiredLine(myPet, until(read?.payer.until));
      default:
        return a.rose && read ? priceRoseLine(name, read.price.cents) : null;
    }
  })();

  const asked = a.entries.length > 0;
  const pays = (
    <Stack gap={2}>
      <Text variant="small" tone="secondary">
        {paysLine(myPet, name)}
      </Text>
      {read?.skilled ? (
        <Text variant="small" tone="secondary">
          {skillShapesLine(name)}
        </Text>
      ) : null}
    </Stack>
  );
  const feedOpen = request !== null && request.elsewhere && request.tokenId === advice.payer.tokenId;
  const feedMineNow = () => {
    if (auth.needSession()) runAction('feed', { tokenId: advice.payer.tokenId, name: myPet, viewer: 'owner', elsewhere: true });
  };

  // What the page needs of the column: a question on its way, and an own pet that can't pay.
  const { onStatus } = advice;
  const cantPayNow = blocker === 'cant_pay' && !signedOut;
  useEffect(() => {
    onStatus({ thinking: a.busy, cantPay: cantPayNow });
  }, [onStatus, a.busy, cantPayNow]);
  useEffect(() => () => onStatus({ thinking: false, cantPay: false }), [onStatus]);

  // The tap on «Ask {name} · {price}» ended in a line that takes the button's place (tired, resting): the focus it held would fall to
  // the page, so it goes to the field (DS › Composer › Keyboard: the focus stays in the field when a line takes a button's place).
  const askHadFocus = useRef(false);
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      askHadFocus.current = e.target instanceof Element && e.target.closest('.ds-composer__end button[type="submit"]') !== null;
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);
  const buttonGone = !signedOut && (blocker === 'worker_resting' || blocker === 'tired');
  useEffect(() => {
    if (!buttonGone || !askHadFocus.current) return;
    askHadFocus.current = false;
    if (document.activeElement === document.body || document.activeElement === null) {
      document.querySelector<HTMLTextAreaElement>('.ds-composer__field')?.focus();
    }
  }, [buttonGone]);

  const end = signedOut ? (
    lead?.action ? (
      <Button size="compact" onClick={lead.action.onClick}>
        {lead.action.label}
      </Button>
    ) : null
  ) : blocker === 'cant_pay' ? (
    // the state's one filled action: «Feed {name}» on the page steps down while the own pet can't pay
    <Button size="compact" icon="feed" haspopup="dialog" expanded={feedOpen || undefined} onClick={feedMineNow}>
      {feedMine(myPet)}
    </Button>
  ) : blocker === 'worker_resting' || blocker === 'tired' ? null : (
    <Button
      size="compact"
      variant="secondary"
      iconEnd="send"
      type="submit"
      price={price}
      busy={a.busy}
      off={blocker !== null || read === null}
      onClick={() => void a.ask(a.draft)}
    >
      {adviceButton(name)}
    </Button>
  );

  return (
    <>
      <Inert on={advice.covered}>
        <Conversation
          label={adviceLabel(name)}
          intro={
            asked ? (
              <Stack gap={3}>
                {advice.check}
                {pays}
              </Stack>
            ) : (
              advice.check
            )
          }
          introOn="phone"
        >
          {a.entries.map((entry) => (
            <EntryMessage key={entry.id} entry={entry} worker={{ tokenId, name }} myPet={myPet} />
          ))}
          {a.busy ? (
            <Thinking key="thinking" wait={a.waiting ? WAIT_LINE : undefined}>
              {`${name} is thinking…`}
            </Thinking>
          ) : null}
        </Conversation>
        <Dock>
          <Stack gap={3}>
            <Composer
              placeholder={advicePlaceholder(name)}
              value={a.draft}
              onChange={a.setDraft}
              onSend={(text) => void a.ask(text)}
              disabled={Boolean(signedOut)}
              note={signedOut ? <Note>{lead?.text}</Note> : line ? <Note>{line}</Note> : null}
              end={end}
            />
            {signedOut ? <SignInLines lines={moreLines} /> : null}
            {asked ? <Only on="desktop">{pays}</Only> : pays}
            <Live>{signedOut ? '' : (line ?? '')}</Live>
            <Live alert>{signedOut ? signInLines.map((l) => l.text).join(' ') : ''}</Live>
          </Stack>
        </Dock>
      </Inert>
    </>
  );
}
