import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Block,
  Button,
  Cluster,
  Composer,
  Header,
  Heading,
  Inert,
  Live,
  Message,
  Note,
  Page,
  Shell,
  Skeleton,
  Stack,
  Streak,
  Surface,
  Text,
  TextField,
  TextLink,
  Thinking,
  type Accent,
} from '../ds';
import { hasVisible } from '../lib/nameClean';
import { formatCents } from '../lib/price';
import { workerApi } from '../seams/worker';
import { centsAtRate } from '../verification/checkMachine';
import { nearPrice } from '../watch/view';
import { PetFigure } from '../pet/PetFigure';
import { petPath } from '../route';
import { wearProps } from '../wardrobe/catalogue';
import { emptyPaidLine, lostLine, pausedLine, thinkingLine, tiredLine, WAIT_LINE } from '../screens/pet/lines';
import type { OwnerView, usePetScreen } from '../screens/pet/usePetScreen';
import { useAuth } from '../seams/auth';
import type { DiaryView } from '../seams/worker-types';
import { SESSION_LINE } from '../signin/session';
import { SignInLines, useSignInLines } from '../signin/SignInOutcome';
import { endNote, entryDraw, nextSaid, partLines, riddleDraw, streakDraw, type EntryDraw, type Sayable } from './diaryView';
import { errorLine, fellAsleepLine, HINT_LINE, HELD_LINE, keptRiddleLine, lateLine, loadingLine, signedOutLine } from './lines';
import type { useDiary } from './useDiary';

// Diary screen (add-daily-ritual › Diary screen) built from design/bundle/screens/diary.js: one centred column — the streak first,
// the entry with the small pet at its start and its last line the question of the day, the answer with «Answer {name}» in its bar,
// then the riddle (yesterday's verdict above today's riddle, its field and «Send answer»), and «All done for today!» at the end
// once the ritual is done. The words are the Scenarios' and the frames' `copy`, verbatim, laid out by `diaryView.ts`.
const RIDDLE_ID = 'riddle-today';
/** The first line of what replaced a field that held the focus: the asleep line, the late line, the riddle's answer. */
const HANDOFF_ID = 'diary-handoff';
/** The same for the question's field: the exchange. An id of its own, for it stands beside the riddle's answer. */
const EXCHANGE_ID = 'diary-exchange';
const FIELDS = '.ds-composer, .ds-field';

type DiaryState = ReturnType<typeof useDiary>;
type PetScreenState = ReturnType<typeof usePetScreen>;

/** What the page's live region says: a line that comes is written after the render it came in, into a region that is there. */
function useSaid(now: Sayable): string {
  const seen = useRef<{ before: Sayable; said: string[] }>({ before: { states: [], parts: null }, said: [] });
  const [said, setSaid] = useState('');
  useEffect(() => {
    const next = nextSaid(seen.current.said, seen.current.before, now);
    seen.current = { before: now, said: next };
    setSaid(next.join(' '));
  }, [JSON.stringify(now)]);
  return said;
}

function Skeletons({ name }: { name: string }) {
  return (
    <>
      {/* said by the page's own live region too, which outlives this view */}
      <Note tone="status" id="diary-loading" silent>
        {loadingLine(name)}
      </Note>
      <Stack gap={3}>
        <Skeleton shape="name" />
        <Skeleton shape="line" />
        <Skeleton shape="line" />
        <Skeleton shape="short" />
      </Stack>
      <Composer
        disabled
        label={loadingLine(name)}
        end={
          <Button size="compact" iconEnd="send" disabled>
            {`Answer ${name}`}
          </Button>
        }
      />
      <TextField
        labelledBy="diary-loading"
        disabled
        action={
          <Button variant="secondary" disabled>
            Send answer
          </Button>
        }
      />
    </>
  );
}

function Entry({ pet, today, previousOwner }: { pet: OwnerView; today: EntryDraw; previousOwner?: boolean }) {
  if (today.kind === 'line') {
    return (
      <Surface>
        <Text>{today.text}</Text>
      </Surface>
    );
  }
  const surface = (
    <Surface>
      <Stack gap={3}>
        <Cluster gap={3}>
          <PetFigure tokenId={pet.tokenId} name={pet.name} state={pet.fullness.state} stage={pet.stage} mood={pet.fullness.state === 'asleep' ? null : pet.mood} size="sm" decorative still {...wearProps(pet.worn)} />
          <Text variant="small" tone="secondary">
            {pet.name}
          </Text>
        </Cluster>
        <Stack gap={2}>
          {today.lines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          {today.question !== null ? <Text variant="body-strong">{today.question}</Text> : null}
          {today.social?.map((line, i) => <Text key={`social-${i}`}>{line}</Text>)}
        </Stack>
        {previousOwner ? <Text variant="small" tone="secondary">{`${pet.name} wrote this before coming to you.`}</Text> : null}
        {today.work !== null ? (
          <Text variant="small" tone="secondary">
            {today.work}
          </Text>
        ) : null}
      </Stack>
    </Surface>
  );
  return previousOwner ? <Stack gap={2}><Text variant="small" tone="secondary">Previous owner</Text>{surface}</Stack> : surface;
}

export function DiaryPage({
  pet,
  d,
  s,
  accent,
  account,
  banner,
  bannerLine,
  offline,
  covered,
  layer,
  onFeed,
}: {
  pet: OwnerView;
  d: DiaryState;
  /** the Pet screen's state: the question's answer goes through it, as any line to the pet does */
  s: PetScreenState;
  accent: Accent;
  /** «Account», the header's end; the page draws none of its own after the session ended */
  account: ReactNode;
  /** the connection line over the last known diary (`Connection rule`) and what the page's live region says of it */
  banner: ReactNode;
  bannerLine: string;
  /** the Connection rule's words of this pet, for a sign-in that could not read the gate */
  offline: string;
  /** Feed sheet or another sheet is over the page on this viewport: the page is out of reach */
  covered: boolean;
  /** Feed sheet and what stands over the page with it */
  layer: ReactNode;
  /** «Feed {name}» of the asleep state: the same action as the Pet screen's */
  onFeed: () => void;
}) {
  const { tokenId, name } = pet;
  const auth = useAuth();
  const lines = useSignInLines({ unreachable: offline, text: d.question });
  const [lead, ...more] = lines;
  const signedOut = auth.sessionLine;
  const leadText = lead?.text === SESSION_LINE ? signedOutLine(name) : lead?.text;
  const asleep = pet.fullness.state === 'asleep';
  const tired = !asleep && pet.tired;
  const paused = !asleep && !tired && pet.paused;

  // the diary on screen: the answer, or the last known one under the error line
  const load = d.load;
  const rawView: DiaryView | null = load.kind === 'ready' ? load.diary : load.kind === 'error' ? load.last : null;
  const view: DiaryView | null = rawView && (signedOut || !auth.authenticated)
    ? { ...rawView, entry: rawView.entry.kind === 'text' ? { ...rawView.entry, socialLines: [] } : rawView.entry }
    : rawView;
  const socialSeen = useRef(new Set<string>());
  const socialKey = view?.entry.kind === 'text' && view.entry.socialLines?.length ? `${tokenId}:${view.day}:${view.entry.id}` : null;
  useEffect(() => {
    if (!socialKey || signedOut || !auth.authenticated || auth.sessionEnded || socialSeen.current.has(socialKey)) return;
    socialSeen.current.add(socialKey);
    void auth.getIdentityToken().then((token) => {
      if (!token) return;
      return workerApi.societyDiarySeen(token, tokenId, { eventId: crypto.randomUUID(), tabId: crypto.randomUUID(), playerId: crypto.randomUUID(), petId: crypto.randomUUID() });
    }).catch(() => {});
  }, [socialKey, signedOut, auth, tokenId]);
  const [watchRates, setWatchRates] = useState<Record<string, string>>({});
  const watchIds = view?.watch?.map((item) => item.receiptId).join('|') ?? '';
  useEffect(() => {
    if (!watchIds || !auth.authenticated || auth.sessionEnded) return;
    let live = true;
    void auth.getIdentityToken().then(async (token) => {
      if (!token) return;
      const rates = await Promise.all((view?.watch ?? []).map(async (item) => {
        try {
          const pointer = await workerApi.verificationThought(token, tokenId, item.receiptId);
          return [item.receiptId, pointer.nearUsdRate ?? ''] as const;
        } catch { return [item.receiptId, ''] as const; }
      }));
      if (live) setWatchRates(Object.fromEntries(rates));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [watchIds, tokenId, auth.authenticated, auth.sessionEnded]);

  // The answer to the question: on its way or landed, drawn under the question until the diary itself holds the exchange
  const asked = view !== null && view.exchange === null && s.asked !== null && (s.asked.day === null || s.asked.day === view.day) ? s.asked : null;
  const questionFailed = s.failure !== null && s.failure.question !== undefined;

  // The focus goes with a field that went (asleep, the answer sent, the riddle answered, a late answer with no field left): it stood
  // on a field's control that is gone, and moves to the first line of what replaced it (`Diary screen` › «asleep»; DS › Composer ›
  // Keyboard). React sends no blur for what its own commit removes, so a control that went stays `held`.
  const held = useRef<Element | null>(null);
  const handoff = (to: string) => {
    if (held.current === null || held.current.isConnected) return;
    held.current = null;
    document.getElementById(to)?.focus();
  };
  const onFocus = (e: { target: EventTarget }) => {
    held.current = e.target instanceof Element && e.target.closest(FIELDS) !== null ? e.target : null;
  };
  const onBlur = () => {
    held.current = null;
  };
  const wasAsleep = useRef(asleep);
  useEffect(() => {
    if (asleep && !wasAsleep.current) handoff(HANDOFF_ID);
    wasAsleep.current = asleep;
  }, [asleep]);
  useEffect(() => {
    if (asked !== null) handoff(EXCHANGE_ID);
  }, [asked !== null]);
  const riddleGone = view !== null && (view.riddle.kind === 'answered' || (d.late !== null && view.riddle.kind !== 'open'));
  useEffect(() => {
    if (riddleGone) handoff(HANDOFF_ID);
  }, [riddleGone]);

  // What takes the head of the column comes into view, with the page scrolled down to a field (the phone's riddle stands far below
  // the fold). A tap that met the ended session: the focus moves to «Sign in» (DS › ItemGrid › After an outcome). A failed poll takes
  // no focus and leaves a field that holds it, so typing is not interrupted. A sheet over the page comes first: the tap in it closes it.
  const failed = load.kind === 'error' && !signedOut;
  const topHead = useRef<HTMLDivElement>(null);
  const outOfSession = signedOut && !covered;
  useEffect(() => {
    if (!outOfSession) return;
    window.scrollTo(0, 0);
    topHead.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [outOfSession]);
  const failedInSight = failed && !covered;
  useEffect(() => {
    if (failedInSight && !document.activeElement?.matches('input, textarea')) window.scrollTo(0, 0);
  }, [failedInSight]);

  // Every control that needs a session asks first: with the session ended it shows the line and sends nothing, the typed text
  // stays in its field (`Diary screen` › «signed-out»).
  const answer = () => {
    if (!hasVisible(d.question) || view === null || s.busy) return;
    if (!auth.needSession()) return;
    const text = d.question;
    d.setQuestion('');
    void s.send(text, 'chat', view.day);
  };
  const sendRiddle = () => {
    if (!hasVisible(d.riddle?.text ?? '') || d.sending) return;
    if (!auth.needSession()) return;
    void d.sendRiddle();
  };
  const onRiddleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      sendRiddle();
    }
  };

  const header = (
    <Header
      start={
        <Button variant="ghost" size="compact" icon="back" href={petPath(tokenId)}>
          {`Back to ${name}`}
        </Button>
      }
      end={signedOut ? null : account}
    />
  );

  let top: ReactNode = null;
  if (signedOut) {
    top = (
      <div ref={topHead}>
        <Stack gap={3}>
          <Note tone="plain" silent>
            {leadText}
          </Note>
          {lead?.action ? (
            <Cluster>
              <Button onClick={lead.action.onClick}>{lead.action.label}</Button>
            </Cluster>
          ) : null}
          <SignInLines lines={more} />
        </Stack>
      </div>
    );
  } else if (failed) {
    top = (
      <Stack gap={3}>
        <Note tone="error">{errorLine(name)}</Note>
        <Cluster>
          <Button variant="secondary" onClick={d.tryAgain}>
            Try again
          </Button>
        </Cluster>
      </Stack>
    );
  }

  const thinking = !asleep && asked !== null && asked.reply === null && s.busy;
  const lateNow = d.late !== null && !asleep && view !== null && view.riddle.kind !== 'answered' ? lateLine(d.late, view.riddle.kind === 'open') : '';
  const states = signedOut
    ? [leadText ?? '', ...more.map((l) => l.text)]
    : load.kind === 'loading'
      ? [loadingLine(name)]
      : [
          asleep ? fellAsleepLine(name) : '',
          asleep && d.riddle !== null ? keptRiddleLine(name) : '',
          thinking ? thinkingLine(name) : '',
          lateNow,
          bannerLine,
          tired ? tiredLine(name, pet.until) : paused ? pausedLine(name) : '',
        ];

  let parts: string[] | null = null;
  let body: ReactNode = null;
  if (load.kind === 'loading') {
    body = <Skeletons name={name} />;
  } else if (view !== null) {
    const streak = streakDraw(view);
    const entry = entryDraw(view.entry, name, view.until, view.closedAt);
    const riddle = riddleDraw(view);
    // the question whose answer is on its way is no part left (`Daily ritual flow` › «part still to do»)
    const end = endNote(asked !== null ? { ...view, parts: view.parts.filter((p) => p !== 'question') } : view);
    const askable = view.entry.kind === 'text' && view.entry.question !== null;
    const note = tired ? tiredLine(name, pet.until) : paused ? pausedLine(name) : null;
    const watchLines = view.watch?.map((item) => {
      const hundredths = centsAtRate(item.priceYocto, watchRates[item.receiptId] || null);
      const price = hundredths === null ? nearPrice(item.priceYocto) : hundredths >= 1 && hundredths <= 9 ? `0.0${hundredths}¢` : formatCents(hundredths / 100);
      return <Surface key={item.receiptId}><Stack gap={2}>
        <Text>{`${name} checked ${item.target}: ${item.change}`}</Text>
        {item.sources.map((source) => <TextLink key={source} href={source} external>{source}</TextLink>)}
        <Text variant="small" tone="secondary">{price}</Text>
        <TextLink href={`/pet/${tokenId}/verify/${item.receiptId}`} icon="verify">Check this thought</TextLink>
      </Stack></Surface>;
    }) ?? [];

    const exchange = view.exchange ?? (asked !== null ? { answer: asked.text, reply: asked.reply } : null);
    parts = partLines(streak, entry, riddle, exchange?.reply != null ? `${name}: ${exchange.reply}` : null, end?.text ?? null);
    // a line that arrives rises in; the one a reload found on its way (`day` null) is history shown on open, the reply to it is not
    const exchanged =
      exchange !== null ? (
        <div id={EXCHANGE_ID} tabIndex={-1}>
          <Stack as="ol" gap={3}>
            <Message from="player" speaker="You" fresh={asked !== null && asked.day !== null}>
              {exchange.answer}
            </Message>
            {exchange.reply !== null ? (
              <Message from="pet" speaker={name} fresh={asked !== null}>
                {exchange.reply}
              </Message>
            ) : questionFailed ? (
              <Message
                from="error"
                actions={
                  <Button variant="secondary" size="compact" onClick={s.retryThought}>
                    Try again
                  </Button>
                }
              >
                {s.failure?.code === 'empty_paid' ? emptyPaidLine(name) : lostLine(name)}
              </Message>
            ) : thinking ? (
              <Thinking wait={s.waiting ? WAIT_LINE : undefined}>{thinkingLine(name)}</Thinking>
            ) : null}
          </Stack>
        </div>
      ) : null;

    // asleep, the handoff is the asleep line: one element carries the id
    const answerHandoff = asleep ? {} : { id: HANDOFF_ID, tabIndex: -1 };
    const riddleBlock = (
      <Block role="mind" icon="puzzle">
        {d.late !== null && !asleep && riddle.today.kind !== 'answered' ? (
          <Text id={HANDOFF_ID} tabIndex={-1}>
            {lateLine(d.late, riddle.today.kind === 'open')}
          </Text>
        ) : null}
        {riddle.yesterday !== null ? (
          <Text variant="small" tone="secondary">
            {riddle.yesterday}
          </Text>
        ) : null}
        {riddle.today.kind === 'held' ? <Text>{HELD_LINE}</Text> : null}
        {riddle.today.kind !== 'held' ? (
          <Heading level={2} variant="title-3" id={RIDDLE_ID}>
            {riddle.today.text}
          </Heading>
        ) : null}
        {riddle.today.kind === 'open' && !asleep ? (
          <div onKeyDown={onRiddleKey}>
            <TextField
              labelledBy={RIDDLE_ID}
              maxLength={40}
              value={d.riddle?.text ?? ''}
              onChange={(text) => d.setRiddle(text, riddle.today.kind === 'open' ? riddle.today.day : view.day)}
              hint={HINT_LINE}
              action={
                <Button variant="secondary" off={!hasVisible(d.riddle?.text ?? '')} busy={d.sending} onClick={sendRiddle}>
                  Send answer
                </Button>
              }
            />
          </div>
        ) : null}
        {riddle.today.kind === 'answered' ? (
          riddle.today.answer === null ? (
            <Text variant="body-strong" {...answerHandoff}>
              {riddle.today.line}
            </Text>
          ) : (
            <Stack gap={2}>
              <Text {...answerHandoff}>{riddle.today.line}</Text>
              <Text variant="body-strong">{`"${riddle.today.answer}"`}</Text>
            </Stack>
          )
        ) : null}
      </Block>
    );

    body = asleep ? (
      <>
        <Streak {...streak} />
        <Stack gap={3}>
          <Entry pet={pet} today={entry} previousOwner={view.entry.kind === 'text' && view.entry.previousOwner} />
          {watchLines}
          {exchanged}
          <Stack gap={3}>
            <Text id={HANDOFF_ID} tabIndex={-1}>
              {fellAsleepLine(name)}
            </Text>
            {d.riddle !== null ? <Text>{keptRiddleLine(name)}</Text> : null}
            <Button block icon="feed" haspopup="dialog" onClick={onFeed}>
              {`Feed ${name}`}
            </Button>
          </Stack>
        </Stack>
        {riddleBlock}
        {end !== null ? (
          <Note key="end" tone="plain" icon={end.kind === 'done' ? 'check' : undefined}>
            {end.text}
          </Note>
        ) : null}
      </>
    ) : (
      <>
        <Streak {...streak} />
        <Stack gap={3}>
          <Entry pet={pet} today={entry} previousOwner={view.entry.kind === 'text' && view.entry.previousOwner} />
          {watchLines}
          {exchanged}
          {exchanged === null && askable && view.entry.kind === 'text' ? (
            <Composer
              label={view.entry.question ?? undefined}
              value={d.question}
              onChange={d.setQuestion}
              onSend={answer}
              disabled={tired || paused}
              note={note !== null ? <Note>{note}</Note> : null}
              end={
                <Button
                  size="compact"
                  iconEnd="send"
                  type="submit"
                  variant={signedOut ? 'secondary' : undefined}
                  disabled={tired || paused}
                  off={s.busy}
                  onClick={answer}
                >
                  {`Answer ${name}`}
                </Button>
              }
            />
          ) : null}
        </Stack>
        {riddleBlock}
        {end !== null ? (
          <Note key="end" tone="plain" icon={end.kind === 'done' ? 'check' : undefined}>
            {end.text}
          </Note>
        ) : null}
      </>
    );
  }

  const live = useSaid({ states: states.filter(Boolean), parts });

  return (
    <Shell accent={accent} header={<Inert on={covered ? 'phone' : undefined}>{header}</Inert>}>
      <Inert on={covered ? 'phone' : undefined}>
        <Page width="default">
          <Heading level={1} hidden>
            {`${name}'s diary`}
          </Heading>
          {banner}
          <div onFocusCapture={onFocus} onBlurCapture={onBlur}>
            <Stack gap={5}>
              {top}
              {body}
            </Stack>
          </div>
          <Live alert={signedOut}>{live}</Live>
        </Page>
      </Inert>
      {layer}
    </Shell>
  );
}
