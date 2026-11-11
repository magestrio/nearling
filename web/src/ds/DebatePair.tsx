import { PetFigure } from '../pet/PetFigure';
import { Text } from './Text';

// DS 0.51 · design/ds/components.js › DebatePair.
export interface DebatePet {
  tokenId: string;
  name: string;
  state?: 'full' | 'hungry' | 'asleep';
  stage?: 'baby' | 'teen' | 'adult';
}

export function DebatePair({ first, second, ordered, label, selectablePet, options = [], selectLabel = 'known pet', disabled, onSelectPet }: {
  first: DebatePet;
  second: DebatePet;
  ordered?: boolean;
  label?: string;
  selectablePet?: string;
  options?: DebatePet[];
  selectLabel?: string;
  disabled?: boolean;
  onSelectPet?: (tokenId: string) => void;
}) {
  return <div className="ds-debate-pair" role="group" aria-label={ordered ? `${first.name} opener` : label}>
    {[first, second].map((pet, index) => <div className="ds-debate-pair__pet" key={pet.tokenId}>
      {ordered ? <span className="ds-debate-pair__order type-body-strong" aria-hidden="true">{index + 1}</span> : null}
      <PetFigure tokenId={pet.tokenId} name={pet.name} state={pet.state} stage={pet.stage} size="sm" still decorative />
      {selectablePet === pet.tokenId ? <select className="ds-debate-pair__select type-body-strong" value={pet.tokenId}
        aria-label={selectLabel} disabled={disabled} onChange={(event) => onSelectPet?.(event.target.value)}>
        {options.map((option) => <option key={option.tokenId} value={option.tokenId}>{option.name}</option>)}
      </select> : <Text variant="body-strong">{pet.name}</Text>}
    </div>)}
  </div>;
}
