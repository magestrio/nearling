import type { CSSProperties } from 'react';
import { cx } from './util';

export type FullnessState = 'full' | 'hungry' | 'asleep';

const WORD: Record<FullnessState, string> = { full: 'Full', hungry: 'Hungry', asleep: 'Asleep' };
export const FULLNESS_CELLS = 8;

/** How many cells are lit (add-pet › Pet condition rule, DS 0.24): «Full» is food above 11.5 of the scale's 12, so
 *  all 8 at any level; «Hungry» — the food's share of the 12, a cell is 1.5 scale thoughts, at least 1 and at most
 *  7, so a hungry pet never looks full; «Asleep» — none (one ember is drawn). */
export function litCells(state: FullnessState, level: number | undefined): number {
  if (state === 'asleep') return 0;
  if (state === 'full') return FULLNESS_CELLS;
  const share = level ?? 0.25;
  return Math.max(1, Math.min(FULLNESS_CELLS - 1, Math.floor(share * FULLNESS_CELLS)));
}

/** «Full / Hungry / Asleep» — the word and the cells of the pet's light, always both. The cells relight one after
 *  another (200 ms each, 40 ms apart; at once for reduced motion) by components.css, from the `--i` of each. */
export function Fullness({ state = 'full', level }: { state?: FullnessState; level?: number }) {
  const lit = litCells(state, level);
  const cells = [];
  for (let i = 0; i < FULLNESS_CELLS; i += 1) {
    const kind = state === 'asleep' ? (i === 0 ? 'ember' : 'empty') : i < lit ? 'lit' : 'empty';
    cells.push(<span key={i} className={`ds-fullness__cell ds-fullness__cell--${kind}`} style={{ '--i': i } as CSSProperties} />);
  }
  return (
    <div className={cx('ds-fullness', `ds-fullness--${state}`)}>
      <span className="ds-fullness__cells" aria-hidden="true">
        {cells}
      </span>
      <span className="ds-fullness__word type-label">{WORD[state]}</span>
    </div>
  );
}
