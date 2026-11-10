import type { ReactNode } from 'react';
import { Fullness, type FullnessState } from './Fullness';
import { Energy, Growth, Trait, type StageName, type TraitName } from './PetParts';
import { Sheet } from './Sheet';
import { Text } from './Text';

export function PetCard({ name, portrait, stage, traits, traitNote, energy, fullness, seal, sections, onClose, returnFocusTo }: {
  name: string; portrait?: ReactNode; stage?: StageName | null; traits?: TraitName[] | null; traitNote?: string;
  energy?: number | null; fullness?: FullnessState | null; seal?: ReactNode;
  sections?: { title?: string; content: ReactNode }[]; onClose: () => void; returnFocusTo?: () => HTMLElement | null;
}) {
  return <div className="ds-pet-card"><Sheet title={`${name}'s card`} onClose={onClose} returnFocusTo={returnFocusTo} closeText self>
    <div className="ds-pet-card__portrait">{portrait}</div>
    <div className="ds-pet-card__identity"><span className="type-title-2">{name}</span>{stage ? <Growth stage={stage} /> : null}</div>
    {traits?.length ? <div className="ds-pet-card__traits">{traits.map((trait) => <Trait key={trait} name={trait} />)}</div> : null}
    {traitNote ? <Text variant="small" tone="secondary">{traitNote}</Text> : null}
    {energy != null ? <Energy value={energy} label="Energy" /> : null}
    {fullness ? <Fullness state={fullness} /> : null}
    {seal ? <div className="ds-pet-card__seal">{seal}</div> : null}
    {sections?.map((section, index) => <section className="ds-pet-card__section" key={`${section.title ?? 'section'}-${index}`}>
      {section.title ? <h3 className="type-title-3">{section.title}</h3> : null}{section.content}
    </section>)}
  </Sheet></div>;
}
