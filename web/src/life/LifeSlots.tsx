import { Energy, Growth, Text, Trait, type TraitName } from '../ds';
import type { SlotProps } from '../screens/pet/parts';
import { babyLine } from './lines';

const TRAITS: readonly TraitName[] = ['clever', 'thoughtful', 'sociable', 'hard-working', 'cozy'];
const isTrait = (word: string): word is TraitName => (TRAITS as readonly string[]).includes(word);

/** The meter of the day's energy, in the plate; the owner's only (`Pet life display rule`): without `life` the slot draws
 *  nothing, so a guest and a visitor never get it. */
export function EnergySlot({ life }: SlotProps) {
  if (!life) return null;
  return <Energy value={life.energy} label="Energy" />;
}

/** The stage as a word and the traits, or a baby's line in their place. The server gives each trait once. */
export function GrowthSlot({ name, life }: SlotProps) {
  if (!life) return null;
  if (life.stage === 'baby') {
    return (
      <>
        <Growth stage="baby" />
        <Text variant="small" tone="secondary">
          {babyLine(name)}
        </Text>
      </>
    );
  }
  return (
    <>
      <Growth stage={life.stage} />
      {[...new Set(life.traits)].filter(isTrait).map((trait) => (
        <Trait key={trait} name={trait} />
      ))}
    </>
  );
}
