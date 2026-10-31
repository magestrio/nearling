import { Block } from './Block';
import { Text } from './Text';
import { cx } from './util';

export type StreakCell = 'lit' | 'frozen' | 'today' | 'none';
const STREAK_CELLS = 7;

/** «Streak: {n} days · Freezes: {k}» (`Streak rule`) on the day's yellow: the sentence in the spec's words and order, the number
 *  largest; the last seven days as cells, hidden from screen readers (the sentence carries it). `done` — today's ritual is
 *  done, so today is counted. `cells` — the seven kinds, oldest first, when a day differs from the rule: lit | frozen | today |
 *  none. `line` — the streak's own line above the note; `note` — the line under it. A day outside the current streak keeps its
 *  slot and is not drawn: the strip never shows a missed day. Not a control. */
export function Streak({
  days = 0,
  freezes = 0,
  done,
  cells,
  line,
  note,
  unit = 'days',
}: {
  days?: number;
  freezes?: number;
  done?: boolean;
  cells?: StreakCell[];
  line?: string;
  note?: string;
  /** «days», or «day» at 1 (`Streak rule`: «Streak: 1 day»): the DS's sentence has no singular, the spec's has */
  unit?: string;
}) {
  const counted = Math.min(days - (done ? 1 : 0), STREAK_CELLS - 1);
  const drawn: StreakCell[] = [];
  for (let i = 0; i < STREAK_CELLS; i += 1) {
    const today = i === STREAK_CELLS - 1;
    drawn.push(cells ? (cells[i] ?? 'none') : today ? (done ? 'lit' : 'today') : i >= STREAK_CELLS - 1 - counted ? 'lit' : 'none');
  }
  return (
    <Block role="food" icon="today">
      <p className="ds-streak__line type-title-3">
        Streak: <span className="ds-streak__n type-hero">{days}</span>
        {` ${unit} · Freezes: ${freezes}`}
      </p>
      <span className="ds-streak__cells" aria-hidden="true">
        {drawn.map((kind, i) => (
          <span key={i} className={cx('ds-streak__cell', `ds-streak__cell--${kind}`)} />
        ))}
      </span>
      {line ? <Text>{line}</Text> : null}
      {note ? (
        <Text variant="small" tone="secondary">
          {note}
        </Text>
      ) : null}
    </Block>
  );
}
