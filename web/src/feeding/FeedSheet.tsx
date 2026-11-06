import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActionRow, Block, Button, Cluster, Disclosure, Fullness, Note, Only, Sheet, Text, TextField } from '../ds';
import { resetTime } from '../lib/time';
import { useAuth } from '../seams/auth';
import type { FeedSheetData, SheetPortion } from '../seams/worker-types';
import { hatchPath } from '../route';
import { AddNearBody } from './AddNearSheet';
import { Failure } from './Failure';
import { balance, dateAndTime, sentenceName, usd } from './format';
import { showFeedToast, type FeedRequest } from './feedRequest';
import type { Phase, Tapped } from './feedMachine';
import { shareFeedLink, whole } from './share';
import { useFeedSheet } from './useFeedSheet';

// Feed sheet (`Feed sheet screen`, built from design/bundle/screens/feed.js): the portions as one block of rows with the balance as
// its last line, the free snack where `Snack rule` gives it or the one line that stands in its place, «Ask friends to feed {name}»
// for the owner, a friend's notice above the guest's. Everything it shows comes from the server's answer: the portions' `missing`,
// the wallet's state and the snack's line are the server's, the words are the Scenarios' and the frames'. The sheet opens at once;
// a failed read lands in `error` inside it. A meal or snack on its way and its outcomes are drawn from the phases of
// `feedMachine.ts`; the meal itself is the tab's (`feedFlight.ts`). The Add NEAR step is `AddNearSheet.tsx`'s body in this sheet.
const OPEN_ERROR = "We couldn't open feeding right now. Try again in a moment.";
const STILL_CHECKING = 'Still checking — this can take a moment.';
const LINK_COPIED = 'Link copied — send it to a friend.';
const COPY_BY_HAND = 'Copy this link and send it to a friend:';

/** What the rows and the snack look like while a meal is on its way or after one did not go through. */
interface Flight {
  mode: 'sending' | 'failed';
  what: Tapped | null;
  /** the words of the pending row: «Feeding {label}…», or «Still checking…» */
  line: string;
}

interface Taps {
  portion: (near: SheetPortion['near']) => void;
  snack: () => void;
  addNear: () => void;
  share: () => void;
}

const isPortion = (what: Tapped | null, near: SheetPortion['near']): boolean => what?.kind === 'portion' && what.portion === near;

/** The portions as one block of rows. A portion the wallet can't cover is off; the line «Add {missing} NEAR…» and «Add NEAR» stand
 *  under the first of them — the smallest that is short (`Feed sheet screen` › «мало NEAR», «без NEAR»). */
function Portions({
  portions,
  balanceYocto,
  flight,
  taps,
}: {
  portions: SheetPortion[];
  balanceYocto: string | null;
  flight: Flight | null;
  taps: Taps;
}) {
  const firstShort = portions.findIndex((p) => p.missing !== null);
  const sending = flight?.mode === 'sending';
  const rows: ReactNode[] = [];
  portions.forEach((p, i) => {
    const mine = isPortion(flight?.what ?? null, p.near);
    rows.push(
      <ActionRow
        key={p.near}
        price={usd(p.cents)}
        aside={`${p.near} NEAR`}
        disabled={p.missing !== null || (sending && !mine)}
        pending={sending && mine}
        pendingLabel={flight?.line}
        failed={flight?.mode === 'failed' && mine}
        describedBy={flight?.mode === 'failed' && mine ? 'feed-failed' : undefined}
        onClick={() => taps.portion(p.near)}
      >
        Feed
      </ActionRow>,
    );
    if (i === firstShort) {
      rows.push(
        <Cluster key="short" gap={3} justify="space-between">
          <Text variant="small">{`Add ${p.missing} NEAR to give this meal.`}</Text>
          <Button variant="secondary" size="compact" off={sending} onClick={taps.addNear}>
            Add NEAR
          </Button>
        </Cluster>,
      );
    }
  });
  if (balanceYocto !== null) {
    rows.push(
      <Text key="balance" variant="small" tone="secondary" tabular>
        {`You have ${balance(balanceYocto)} NEAR`}
      </Text>,
    );
  }
  return (
    <Block role="food" flush>
      {rows}
    </Block>
  );
}

/** The one line that stands in the snack's place (`Snack rule`, `Feeding connection rule`). */
function snackLine(sheet: FeedSheetData, label: string): string | null {
  const s = sheet.snack;
  switch (s.state) {
    case 'not_ready':
      return `${sentenceName(label)}'s next free snack is ready ${dateAndTime(s.at)}. Until then, a meal or a friend can wake ${label} up.`;
    case 'given':
      return `You've already given ${label} a snack today. Thank you!`;
    case 'shared_all':
      return `You've shared all your free snacks for today — thank you! More at ${resetTime(s.until)}.`;
    case 'pet_full':
      return `${sentenceName(label)} has had all the snacks for today. More at ${resetTime(s.until)}.`;
    case 'paused':
      return 'Free snacks are paused on our side while we top up. Check back soon!';
    case 'ready':
    case 'none':
      return null;
  }
}

function Snack({ sheet, label, lead, flight, taps }: { sheet: FeedSheetData; label: string; lead: boolean; flight: Flight | null; taps: Taps }) {
  if (sheet.snack.state === 'ready') {
    const mine = flight?.what?.kind === 'snack';
    const sending = flight?.mode === 'sending';
    return (
      <Button
        variant={lead ? undefined : 'secondary'}
        block
        icon="feed"
        pending={sending && mine}
        pendingLabel={flight?.line}
        off={sending && !mine}
        describedBy={flight?.mode === 'failed' && mine ? 'feed-failed' : undefined}
        onClick={taps.snack}
      >
        {sheet.viewer === 'owner' ? 'Give a free snack' : `Give ${label} a free snack`}
      </Button>
    );
  }
  const line = snackLine(sheet, label);
  return line === null ? null : (
    <Note tone="plain" icon="feed">
      {line}
    </Note>
  );
}

/** What the guest's notice says before the first tap (`Feeder name rule` › «уведомление»): a tap is the consent. */
function FriendNotice({ label }: { label: string }) {
  return (
    <Block role="trust" icon="globe" quiet>
      <Text variant="small">{`${label} will learn your first name from Google, and so will its owner and the AI that writes ${label}'s replies. What you give is saved with ${label} for good — anyone can see who gave it.`}</Text>
    </Block>
  );
}

function Body({
  sheet,
  tokenId,
  label,
  flight,
  link,
  taps,
  payOpen,
  onPayToggle,
}: {
  sheet: FeedSheetData;
  tokenId: string;
  label: string;
  flight: Flight | null;
  link: 'manual' | null;
  taps: Taps;
  payOpen: boolean;
  onPayToggle: (open: boolean) => void;
}) {
  const guest = sheet.viewer === 'guest';
  // a wallet with only the project's gas: the snack leads, NEAR behind one «Pay with NEAR» (`Feed sheet screen` › «без NEAR»)
  const none = sheet.wallet.state === 'none';
  return (
    <>
      {guest ? <FriendNotice label={label} /> : null}
      {none ? (
        <>
          <Snack sheet={sheet} label={label} lead flight={flight} taps={taps} />
          <Disclosure label="Pay with NEAR" open={payOpen} onToggle={onPayToggle}>
            <Portions portions={sheet.portions} balanceYocto={null} flight={flight} taps={taps} />
          </Disclosure>
        </>
      ) : (
        <>
          <Portions portions={sheet.portions} balanceYocto={sheet.wallet.state === 'some' ? sheet.wallet.balance : null} flight={flight} taps={taps} />
          <Snack sheet={sheet} label={label} lead={false} flight={flight} taps={taps} />
        </>
      )}
      {guest ? null : link === 'manual' ? (
        <TextField label={COPY_BY_HAND} readOnly multiline value={whole(tokenId, sheet.name)} />
      ) : (
        <Button variant="secondary" block icon="share" onClick={taps.share}>
          {`Ask friends to feed ${label}`}
        </Button>
      )}
    </>
  );
}

/** The sheet of a phase that shows one on screen: the idle sheet, and the one a meal is on its way from or failed on. */
function shownSheet(phase: Phase): FeedSheetData | null {
  if (phase.kind === 'open') return phase.sheet.chain ? phase.sheet : null;
  // a sheet reopened on a meal before its answer has no sheet yet: only «Still checking…»
  if (phase.kind === 'sending' || phase.kind === 'failed' || phase.kind === 'yum' || phase.kind === 'thanks') return phase.sheet;
  return null;
}

/** The pet's fullness, in the head of the sheet: the phone's bottom sheet covers the plate. */
function FullnessHead({ fullness, elsewhere }: { fullness: FeedSheetData['fullness']; elsewhere: boolean }) {
  const { state, level } = fullness;
  const cells = <Fullness state={state} level={state === 'hungry' ? level : undefined} />;
  // the own pet over a friend's page is not on the plate at all: its fullness stands in the head on the desktop too
  return elsewhere ? cells : <Only on="phone">{cells}</Only>;
}

/** The words of the outcome that stands: for the sheet's live region, and for the line the sheet draws. */
function outcomeWords(phase: Phase, label: string, shared: boolean): string {
  if (phase.kind === 'sending') return phase.checking ? STILL_CHECKING : `Feeding ${label}…`;
  if (phase.kind === 'failed') return phase.source === 'snack' ? `That snack didn't reach ${label}. Try again.` : `That meal didn't reach ${label}, so its NEAR stays in your wallet. Try again.`;
  if (phase.kind === 'yum') return `Yum! ${sentenceName(label)} is fuller now.`;
  if (phase.kind === 'thanks') {
    if (shared) return phase.source === 'snack'
      ? `You gave ${phase.sheet.name} a free snack. The project paid for it; its food is reserved for this errand.`
      : `You fed ${phase.sheet.name}! Your NEAR is reserved for this errand.`;
    const name = phase.sheet.name;
    return `You fed ${name}! ${name} will remember you${phase.friend ? `, ${phase.friend}` : ''}.`;
  }
  return '';
}

/** The sheet's body is found by its dialog: a control the focus moves to after an outcome (DS › Sheet › After an outcome). */
function sheetRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.ds-sheet');
}

function focusIn(find: (root: HTMLElement) => HTMLElement | null | undefined): void {
  const root = sheetRoot();
  const target = root ? find(root) : null;
  target?.focus();
}

const buttonNamed = (name: string) => (root: HTMLElement) => Array.from(root.querySelectorAll('button, a')).find((b) => b.textContent === name) as HTMLElement | undefined;

export function FeedSheet({ request, onClose, column, pageFullness }: { request: FeedRequest; onClose: () => void; column?: boolean; pageFullness?: FeedSheetData['fullness'] }) {
  const auth = useAuth();
  const { phase, tap, tryAgain, addNear, back, done } = useFeedSheet(request, onClose);
  const { label, elsewhere, tokenId } = request;
  const [link, setLink] = useState<'copied' | 'manual' | null>(null);
  const [step, setStep] = useState('');
  // «Pay with NEAR» open or not: the step unmounts the body, so Back finds the sheet as it was left
  const [payOpen, setPayOpen] = useState(false);
  const sheet = shownSheet(phase);
  const failedRead = phase.kind === 'reading' && phase.failed;
  const noNetwork = phase.kind === 'open' && !phase.sheet.chain;
  const blind = phase.kind === 'sending' && phase.sheet === null;
  const outcome = outcomeWords(phase, label, request.sharedCode !== undefined);
  // a sheet with no answer of its own (the read failed, the chain did not answer, a meal on its way before the first read) shows the
  // page's plate in its head, as the frame does
  const headFullness = sheet ? sheet.fullness : (failedRead || noNetwork || blind) && !elsewhere ? pageFullness : undefined;
  const stepOpen = phase.kind === 'addNear';
  const arrivedFrom = useRef(false);

  // Where the focus goes after an outcome (DS › Sheet › After an outcome): a sent portion keeps it on its row, a failure puts it on
  // «Try again», «Yum!» and the thanks on «Done» (or «Get your own pet», which stands there), copying that failed on the link.
  const kind = phase.kind;
  useEffect(() => {
    if (kind === 'sending') focusIn((root) => root.querySelector<HTMLElement>('[aria-busy="true"]'));
    else if (kind === 'failed') focusIn(buttonNamed('Try again'));
    else if (kind === 'yum') focusIn(buttonNamed('Done'));
    else if (kind === 'thanks') focusIn((root) => buttonNamed('Done')(root) ?? buttonNamed('Get your own pet')(root));
    else if (kind === 'addNear') focusIn((root) => root.querySelector<HTMLElement>('button[aria-label="Back"]'));
  }, [kind]);
  useEffect(() => {
    if (link !== 'manual') return;
    focusIn((root) => {
      const field = root.querySelector<HTMLTextAreaElement>('textarea');
      field?.select();
      return field;
    });
  }, [link]);

  // A step back from Add NEAR lands on the sheet it came from: «Add NEAR» there again, or its first control.
  useEffect(() => {
    if (kind === 'open' && arrivedFrom.current) {
      arrivedFrom.current = false;
      focusIn((root) => buttonNamed('Add NEAR')(root) ?? root.querySelector<HTMLElement>('button:not([disabled])'));
    }
  }, [kind]);

  const taps: Taps = {
    portion: (near) => tap({ kind: 'portion', portion: near }),
    snack: () => tap({ kind: 'snack' }),
    addNear,
    share: () => {
      if (!auth.needSession()) {
        onClose();
        return;
      }
      void shareFeedLink(tokenId, sheet?.name ?? request.name).then((result) => {
        if (result === 'copied') {
          setLink('copied');
          showFeedToast(LINK_COPIED);
        } else if (result === 'manual') setLink('manual');
        else setLink(null);
      });
    },
  };

  const flight: Flight | null =
    phase.kind === 'sending' ? { mode: 'sending', what: phase.what, line: outcome } : phase.kind === 'failed' ? { mode: 'failed', what: phase.what, line: outcome } : null;
  const reopened = phase.kind === 'sending' && phase.what === null;
  // the live region says the outcome that stands before the link's line: a copy made earlier must not hide «Feeding {name}…» or the thanks
  const status = stepOpen ? step : outcome !== '' ? outcome : link === 'copied' ? LINK_COPIED : link === 'manual' ? COPY_BY_HAND : '';

  const leaveStep = (arrived: boolean) => {
    arrivedFrom.current = true;
    void back(arrived);
  };

  return (
    <Sheet
      title={stepOpen ? 'Add NEAR' : `Feed ${label}`}
      // on the step «Close» and Esc do what «Back» does: a step closed with nothing sent returns to the sheet it was opened from
      // (`Add NEAR sheet screen` › «Закрытый без перевода, лист возвращает туда, откуда открыт»)
      onClose={stepOpen ? () => leaveStep(false) : onClose}
      onBack={stepOpen ? () => leaveStep(false) : undefined}
      column={column}
      status={status}
      head={headFullness && !stepOpen ? <FullnessHead fullness={headFullness} elsewhere={elsewhere} /> : undefined}
    >
      {stepOpen ? <AddNearBody from="feed" onStatus={setStep} onArrived={() => leaveStep(true)} onClose={onClose} /> : null}
      {failedRead && !stepOpen ? <Failure onRetry={tryAgain}>{OPEN_ERROR}</Failure> : null}
      {noNetwork && !stepOpen ? <Failure onRetry={tryAgain}>{`We can't feed ${label} right now. Nothing was spent — try again in a moment.`}</Failure> : null}
      {phase.kind === 'failed' ? (
        <Failure id="feed-failed" onRetry={tryAgain}>
          {outcome}
        </Failure>
      ) : null}
      {reopened ? (
        <Note tone="status" silent>
          {outcome}
        </Note>
      ) : null}
      {phase.kind === 'yum' || phase.kind === 'thanks' ? (
        <>
          <Block role="food" icon="feed">
            <Text variant="lead">{outcome}</Text>
          </Block>
          {phase.kind === 'thanks' && !phase.hatched && !request.sharedCode ? (
            <Button block href={hatchPath(tokenId)}>
              Get your own pet
            </Button>
          ) : (
            <Button block onClick={() => { done(); request.onDone?.(); }}>
              Done
            </Button>
          )}
        </>
      ) : null}
      {sheet && (phase.kind === 'open' || phase.kind === 'sending' || phase.kind === 'failed') ? (
        <Body
          sheet={sheet}
          tokenId={tokenId}
          label={label}
          flight={flight}
          link={link === 'manual' ? 'manual' : null}
          taps={taps}
          payOpen={payOpen}
          onPayToggle={setPayOpen}
        />
      ) : null}
    </Sheet>
  );
}
