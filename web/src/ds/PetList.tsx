// DS 0.42 · design/ds/components.js › PetList and PetRow.
import type { ReactNode } from 'react';
import { makePet } from '../pet/proto/generator.js';
import { PetFigure } from '../pet/PetFigure';
import type { Fullness as PetFullness, Stage } from '../seams/worker-types';
import { Fullness } from './Fullness';

export function PetList({ label, children }: { label: string; children: ReactNode }) {
  return <ul className="ds-pet-list" aria-label={label}>{children}</ul>;
}

export function PetRow({ tokenId, name, stage, fullness, current, onSelect }: {
  tokenId: string; name: string; stage: Stage; fullness: PetFullness; current: boolean; onSelect: () => void;
}) {
  return <li className="ds-pet-row" data-accent={makePet(tokenId).hue}>
    <a className="ds-pet-row__link" href={`/pet/${tokenId}`} aria-current={current ? 'page' : undefined}
      onClick={(event) => { event.preventDefault(); onSelect(); }}>
      <PetFigure tokenId={tokenId} name={name} stage={stage} state={fullness.state} size="sm" decorative still lost />
      <span className="ds-pet-row__text">
        <span className="ds-pet-row__name type-body-strong">{name}</span>
        <Fullness state={fullness.state} level={fullness.level} />
      </span>
    </a>
  </li>;
}
