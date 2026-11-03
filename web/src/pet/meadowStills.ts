import type { MeadowPet } from './MeadowScene';

/** How the design stills of the sample pets (`design/pet/<seed>-<stage>-<state>[-<outfit>]-three-quarter.png`) sit in their box,
 *  measured on their opaque pixels: the box's aspect (width / height), the share of its height the pet fills (head to feet),
 *  and where the feet end, from the top. The Meadow frames draw the stills in a box of the DS height, so the 3D scene fits
 *  each pet to the same body: the box is bigger than the pet, the ground light is what fills the rest. */
export interface StillFit {
  aspect: number;
  height: number;
  feet: number;
}

const STILLS: Record<string, StillFit> = {
  '0-adult-full': { aspect: 1.802, height: 0.803, feet: 0.805 },
  '9-adult-full-party-hat': { aspect: 0.839, height: 0.916, feet: 0.917 },
  '7-teen-asleep': { aspect: 1.128, height: 0.883, feet: 0.885 },
  '2-baby-full': { aspect: 1.289, height: 0.87, feet: 0.872 },
  '5-adult-hungry': { aspect: 1.883, height: 0.826, feet: 0.828 },
  '12-adult-full': { aspect: 1.867, height: 0.806, feet: 0.808 },
  '6-adult-full': { aspect: 0.811, height: 0.914, feet: 0.916 },
  '1-adult-asleep': { aspect: 0.995, height: 0.902, feet: 0.903 },
  '258-adult-full': { aspect: 1, height: 0.655, feet: 0.846 },
  '1-teen-full': { aspect: 1.189, height: 0.854, feet: 0.855 },
};

/** The typical still, for a sample the table doesn't know. */
const TYPICAL: StillFit = { aspect: 1.2, height: 0.85, feet: 0.86 };

export function stillOf(pet: Pick<MeadowPet, 'seed' | 'stage' | 'state' | 'outfit'>): StillFit {
  const outfit = pet.outfit && pet.outfit !== 'none' ? `-${pet.outfit}` : '';
  return STILLS[`${pet.seed}-${pet.stage}-${pet.state}${outfit}`] ?? TYPICAL;
}
