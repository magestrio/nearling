import type { FeedSheetAnswer, FeedSheetData, FeedSource, Fullness, PortionNear } from '../seams/worker-types';

// The phases of one open Feed sheet, as a pure reducer (design.md › «Состояния × действия»). The sheet is the tab's memory: closing
// it throws the phase away, and the meal on its way belongs to the tab's flight (`feedFlight.ts`), not to this. Everything
// that touches the network, the clock or the page is the hook's (`useFeedSheet.ts`); this only says what follows what.

/** What the player tapped: a portion of NEAR or the free snack. */
export type Tapped = { kind: 'portion'; portion: PortionNear } | { kind: 'snack' };

export const sourceOf = (what: Tapped): FeedSource => (what.kind === 'snack' ? 'snack' : 'near');

export type Phase =
  /** `GET …/feed` is on its way (the sheet is already open), or it failed: «We couldn't open feeding right now» */
  | { kind: 'reading'; failed: boolean }
  /** the sheet as the server answered; `{ chain: false }` is «We can't feed {name} right now» */
  | { kind: 'open'; sheet: FeedSheetAnswer }
  /** a meal or snack on its way; `what` is null when the flight is another one's (the sheet was reopened on it). `checking`:
   *  «Still checking…», whether since 10 s from the tap or at once on a reopened sheet. `sheet` is null on a sheet reopened on a
   *  flight before any answer, or whose answer carried no data (the network that does not read is the usual reason the outcome is
   *  unknown): only the line stands, nothing to tap. `late`: the flight ended while the sheet was still blind; the outcome is drawn
   *  from the first answer that has data (the viewer decides «Yum!» or the thanks) */
  | { kind: 'sending'; sheet: FeedSheetData | null; what: Tapped | null; source: FeedSource; checking: boolean; wasAsleep: boolean; late?: Outcome }
  /** the transaction or snack did not go through: «Try again» repeats `what`; without it (a flight of another's) the sheet is read again */
  | { kind: 'failed'; sheet: FeedSheetData; what: Tapped | null; source: FeedSource }
  /** the owner's awake pet was fed: «Yum! {name} is fuller now.» and «Done» */
  | { kind: 'yum'; sheet: FeedSheetData }
  /** a friend's meal or snack was confirmed: the thanks, with «Done» or «Get your own pet» */
  | { kind: 'thanks'; sheet: FeedSheetData; friend: string | null; hatched: boolean; source: FeedSource }
  /** the step inside the sheet that shows the wallet's address; `from` is the sheet it returns to */
  | { kind: 'addNear'; from: FeedSheetData }
  /** nothing more to show: the sheet closes by itself (the owner's pet woke) or by «Done» */
  | { kind: 'done' };

/** A meal or snack of this tab that is on its way (`feedFlight.ts`): an answer that finds it draws «Still checking…» at once, whatever
 *  the server's row says (the row may not be written yet, or be gone). */
export interface Standing {
  source: FeedSource;
  wasAsleep: boolean;
}

export type Action =
  | { type: 'readFailed' }
  | { type: 'answer'; sheet: FeedSheetAnswer; standing?: Standing | null }
  /** the flight ended with the network or the pool saying the sheet is not what was tapped (`409 short`, `409 snack_gone`, `503`):
   *  the line goes and the sheet is drawn from this answer */
  | { type: 'redraw'; sheet: FeedSheetAnswer }
  /** the outcome is not known to this tab and the sheet reads again (a flight of another pet's, a snack that lost its row) */
  | { type: 'reread' }
  /** the fullness after a confirmed meal, read once more: the thanks and «Yum!» show the pet as it is */
  | { type: 'fullness'; fullness: Fullness }
  | { type: 'tap'; what: Tapped }
  | { type: 'checking' }
  | { type: 'outcome'; status: 'ok' | 'failed' | 'unknown'; friend?: string; hatched?: boolean }
  /** «Try again»: of a read that failed or of a network that did not read, and of a meal or snack that did not go through */
  | { type: 'retry' }
  | { type: 'addNear' }
  /** «Back» from the Add NEAR step; with the sheet read again (NEAR arrived), the new amount is in it */
  | { type: 'back'; sheet?: FeedSheetData }
  | { type: 'done' };

type Outcome = Extract<Action, { type: 'outcome' }>;

export const initial: Phase = { kind: 'reading', failed: false };

/** The phase a sheet opens in: with a flight of this tab on its way it is «Still checking…» at once, before the first read answers
 *  (`Feeding outcome rule` › «reopened on its way»), with nothing to tap until the sheet is read. */
export const opening = (standing: Standing | null): Phase =>
  standing === null ? initial : { kind: 'sending', sheet: null, what: null, source: standing.source, checking: true, wasAsleep: standing.wasAsleep };

const asleep = (sheet: FeedSheetData): boolean => sheet.fullness.state === 'asleep';

/** The sheet of a phase that has one with a meal behind it. */
const withData = (sheet: FeedSheetAnswer): sheet is FeedSheetData => sheet.chain;

/** Whether a tap is taken: only on a sheet that is read and idle (open with data, or after a failure); a repeat tap while a
 *  meal is on its way, the other rows included, is nothing. */
export function canTap(phase: Phase): boolean {
  return (phase.kind === 'open' && phase.sheet.chain) || phase.kind === 'failed';
}

export function reduce(phase: Phase, action: Action): Phase {
  switch (action.type) {
    case 'readFailed':
      // a read that fails after the sheet drew leaves it as it is: the next poll reads again
      return phase.kind === 'reading' ? { kind: 'reading', failed: true } : phase;
    case 'answer': {
      const sheet = action.sheet;
      const standing = action.standing ?? null;
      if (phase.kind === 'reading' || phase.kind === 'open') {
        // reopened on its way (`Feeding outcome rule` › «reopened on its way»): «Still checking…» at once; so is a flight of another
        // tab or another pet that the answer reports as pending
        if (withData(sheet) && (sheet.pending !== null || standing !== null)) {
          const source = standing?.source ?? sheet.pending!.source;
          return { kind: 'sending', sheet, what: null, source, checking: true, wasAsleep: standing?.wasAsleep ?? asleep(sheet) };
        }
        // the network does not read while a meal of this tab is on its way: not «Nothing was spent», which would be untrue; the meal
        // is still being sent and can be confirmed
        if (!withData(sheet) && standing !== null) return opening(standing);
        return { kind: 'open', sheet };
      }
      if (phase.kind === 'sending' && withData(sheet)) {
        // the flight ended while this sheet could not be drawn: its outcome is drawn from this answer
        if (phase.sheet === null && phase.late) return reduce({ ...phase, sheet, late: undefined }, phase.late);
        if (phase.what === null && sheet.pending === null && standing === null) {
          // a flight that is not this tab's ended: the poll that watches it sees the row gone
          return { kind: 'open', sheet };
        }
      }
      // a poll or a refusal that carries a newer sheet redraws it under the line that stands; one without data changes nothing
      if ((phase.kind === 'sending' || phase.kind === 'failed') && withData(sheet)) return { ...phase, sheet };
      return phase;
    }
    case 'redraw':
      return phase.kind === 'sending' || phase.kind === 'failed' ? { kind: 'open', sheet: action.sheet } : phase;
    case 'reread':
      return phase.kind === 'sending' ? { kind: 'reading', failed: false } : phase;
    case 'fullness':
      return phase.kind === 'yum' || phase.kind === 'thanks' ? { ...phase, sheet: { ...phase.sheet, fullness: action.fullness } } : phase;
    case 'tap': {
      if (!canTap(phase)) return phase;
      const sheet = phase.kind === 'open' ? (phase.sheet as FeedSheetData) : (phase as { sheet: FeedSheetData }).sheet;
      return { kind: 'sending', sheet, what: action.what, source: sourceOf(action.what), checking: false, wasAsleep: asleep(sheet) };
    }
    case 'checking':
      return phase.kind === 'sending' && !phase.checking ? { ...phase, checking: true } : phase;
    case 'outcome': {
      if (phase.kind !== 'sending') return phase;
      if (action.status === 'unknown') return phase.checking ? phase : { ...phase, checking: true };
      if (phase.sheet === null) return { ...phase, late: action };
      if (action.status === 'failed') return { kind: 'failed', sheet: phase.sheet, what: phase.what, source: phase.source };
      // confirmed. A friend gets the thanks. The owner's snack, and a meal that woke the pet, close the sheet at once and the
      // page takes over (`Sleep and wake flow`); a meal for the awake pet says «Yum!»
      if (phase.sheet.viewer === 'guest') {
        return { kind: 'thanks', sheet: phase.sheet, friend: action.friend ?? null, hatched: action.hatched ?? phase.sheet.hatched, source: phase.source };
      }
      return phase.source === 'snack' || phase.wasAsleep ? { kind: 'done' } : { kind: 'yum', sheet: phase.sheet };
    }
    case 'retry':
      if (phase.kind === 'reading' && phase.failed) return { kind: 'reading', failed: false };
      if (phase.kind === 'open' && !phase.sheet.chain) return { kind: 'reading', failed: false };
      if (phase.kind !== 'failed') return phase;
      // the same portion or snack from the start; a failure of another's flight has nothing to repeat: the sheet is read again
      return phase.what === null
        ? { kind: 'reading', failed: false }
        : { kind: 'sending', sheet: phase.sheet, what: phase.what, source: phase.source, checking: false, wasAsleep: asleep(phase.sheet) };
    case 'addNear':
      // a meal or snack that did not go through leaves the other controls live, «Add NEAR» of a short portion among them
      if ((phase.kind === 'open' || phase.kind === 'failed') && phase.sheet.chain) return { kind: 'addNear', from: phase.sheet };
      return phase;
    case 'back':
      return phase.kind === 'addNear' ? { kind: 'open', sheet: action.sheet ?? phase.from } : phase;
    case 'done':
      return phase.kind === 'yum' || phase.kind === 'thanks' ? { kind: 'done' } : phase;
  }
}
