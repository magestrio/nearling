import { PetFigure } from '../pet/PetFigure';
import { Note } from './Note';
import { Text } from './Text';
import { TextLink } from './TextLink';
import { cx } from './util';
import type { DebatePet } from './DebatePair';

// DS 0.51 · design/ds/components.js › DebateLine.
export function DebateLine({ pet, line, number, cost, costNear, receipt, unavailableNote, current, href, onCheck }: {
  pet: DebatePet; line: string; number: number; cost?: string | null; costNear?: string | null;
  unavailableNote?: string;
  receipt: 'settled' | 'pending' | 'unavailable'; current?: boolean; href?: string; onCheck?: () => void;
}) {
  return <li className={cx('ds-debate-line', current && 'ds-debate-line--current')}>
    <div className="ds-debate-line__head"><div className="ds-debate-line__speaker">
      <PetFigure tokenId={pet.tokenId} name={pet.name} state={pet.state} stage={pet.stage} size="sm" still decorative />
      <Text variant="body-strong">{pet.name}</Text></div>
      {cost || costNear ? <div className="ds-debate-line__cost">
        {cost ? <Text variant="body-strong" tabular>{cost}</Text> : null}
        {costNear ? <Text variant="small" tabular tone="secondary">{costNear}</Text> : null}
      </div> : null}</div>
    <Text measure>{line}</Text>
    <div className="ds-debate-line__foot">{receipt === 'settled'
      ? <TextLink href={href ?? '#receipt'} onFollow={onCheck} tone="trust" icon="verify">Check this line<span className="ds-hidden">{`, ${number}, ${pet.name}`}</span></TextLink>
      : <><Note tone={receipt === 'unavailable' ? 'error' : 'status'}>{receipt === 'unavailable' ? 'Receipt unavailable' : 'Receipt pending'}</Note>
        {receipt === 'unavailable' && unavailableNote ? <Note>{unavailableNote}</Note> : null}</>}</div>
  </li>;
}
