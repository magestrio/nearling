import { Fullness as FullnessCells, Only } from '../ds';
import { makePet } from '../pet/proto/generator.js';
import type { Fullness } from '../seams/worker-types';

/** The pet's fullness, in the head of a sheet: the phone's bottom sheet covers the plate. */
export function FullnessHead({ fullness, elsewhere, tokenId }: { fullness: Fullness; elsewhere: boolean; tokenId: string }) {
  const { state, level } = fullness;
  const cells = <FullnessCells state={state} level={state === 'hungry' ? level : undefined} />;
  // the own pet over a friend's page is not on the plate at all: its fullness stands in the head on the desktop too
  return elsewhere ? <div data-accent={makePet(tokenId).hue}>{cells}</div> : <Only on="phone">{cells}</Only>;
}
