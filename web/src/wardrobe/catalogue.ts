import type { OutfitSlug } from '../seams/worker-types';

// The seven items of the wardrobe (`Outfit catalogue rule`; PRODUCT.md §8 › Каталог вещей), in the catalogue's order: three
// earned (two for a streak, one for a riddle) and four bought. The contract knows ids and kinds; the names, the conditions and
// the pictures are the client's. The manner of speech each item adds is the Worker's (`server/src/pet/outfits.ts`).
export type OutfitKind = 'streak' | 'riddle' | 'bought';

export interface Outfit {
  slug: OutfitSlug;
  /** «Daisy crown»: the tile's name, «wearing the {name}» in the alt, the notice's «{item}» */
  name: string;
  kind: OutfitKind;
  /** an earned item not earned yet: «Reach a 1-day streak» (`Wardrobe screen` › «success», OD-590) */
  condition?: string;
  /** a streak item's threshold: «for a {n}-day streak» in the notice (`New outfit notice screen`) */
  days?: number;
}

export const OUTFITS: readonly Outfit[] = [
  { slug: 'daisy-crown', name: 'Daisy crown', kind: 'streak', condition: 'Reach a 1-day streak', days: 1 },
  { slug: 'cozy-scarf', name: 'Cozy scarf', kind: 'streak', condition: 'Reach a 3-day streak', days: 3 },
  { slug: 'thinking-cap', name: 'Thinking cap', kind: 'riddle', condition: 'Solve your first riddle' },
  { slug: 'smart-glasses', name: 'Smart glasses', kind: 'bought' },
  { slug: 'bow-tie', name: 'Bow tie', kind: 'bought' },
  { slug: 'headphones', name: 'Headphones', kind: 'bought' },
  { slug: 'party-hat', name: 'Party hat', kind: 'bought' },
];

export const outfitOf = (slug: OutfitSlug): Outfit => OUTFITS.find((o) => o.slug === slug)!;

/** The name of a slug the Worker sent, or null for one this client does not know (a catalogue grown by a newer build). */
export function nameOf(slug: string | null | undefined): string | undefined {
  return OUTFITS.find((o) => o.slug === slug)?.name;
}

/** The slugs this client knows, in the catalogue's order: a list from the Worker is read through it. */
export const known = (slugs: readonly string[]): OutfitSlug[] => OUTFITS.filter((o) => slugs.includes(o.slug)).map((o) => o.slug);

/** `design/pet/item-<slug>.png`, served from `public/pet/`. */
export const pictureOf = (slug: OutfitSlug): string => `/pet/item-${slug}.png`;

/** What a `PetFigure` takes for a worn item: its slug and its name for the alt. Both absent for none. */
export function wearProps(worn: string | null | undefined): { outfit?: string; wearing?: string } {
  const name = nameOf(worn);
  return name === undefined || worn == null ? {} : { outfit: worn, wearing: name };
}
