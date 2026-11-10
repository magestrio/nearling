import type { ReactNode } from 'react';
import { Fullness, type FullnessState } from './Fullness';
import { Energy } from './PetParts';

/** DS 0.48 nameplate and meters. `myPets` and `routes` are the caller's live controls. */
export function Hud({ name, stage, seal, onCard, cardOpen, myPets, meters = true, condition, level, owner, energy, routes }: {
  name?: string; stage?: string; seal?: ReactNode; onCard?: () => void; cardOpen?: boolean;
  myPets?: ReactNode; meters?: boolean; condition?: FullnessState; level?: number;
  owner?: boolean; energy?: number; routes?: ReactNode;
}) {
  return <header className="ds-hud"><div className="ds-hud__inner">
    <div className="ds-hud__identity">
      {name ? <button className="ds-hud__nameplate" type="button" aria-label={`${name}'s card`}
        aria-haspopup="dialog" aria-expanded={cardOpen || undefined} onClick={onCard}>
        <span className="ds-hud__name type-title-3">{name}</span>
        {stage ? <span className="ds-hud__stage type-small">{stage}</span> : null}
        {seal}
      </button> : null}
      {myPets}
    </div>
    {meters ? <div className="ds-hud__meters"><Fullness state={condition ?? 'full'} level={level} />{owner ? <Energy value={energy ?? 7} label="Energy" /> : null}</div> : null}
    <div className="ds-hud__routes">{routes}</div>
  </div></header>;
}
