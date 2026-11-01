// The wardrobe as the server knows it (`add-wardrobe`): the catalogue by item id (PRODUCT.md §8 ›
// Каталог вещей: the contract knows ids and kinds, the names and manners are the code's), the worn
// item and the notices not yet shown (§8 › Гардероб на сервере; ADR-013).
//
// The worn item lives in D1 by token_id. «Not yet shown» is derived, never stored as a row of its
// own: an earned item the chain holds whose bit is not in `wardrobe.seen`, so a lost write can never
// lose a notice.
import { applyMark, type StreakBefore } from './streak';

export type OutfitKind = 'streak' | 'riddle' | 'bought';

interface OutfitDef {
  slug: string;
  kind: OutfitKind;
  /** The item's name in the analytics events (`outfit_bought { item }`), snake_case. */
  event: string;
  /** The line the manner adds to the request (`Outfit catalogue rule`); the server's code, sent to
   * NEAR AI only (`Sealed character rule`). */
  manner: string;
}

/** Item ids are the catalogue's order: the bit of an item in the contract's mask (`pet.rs`). */
export const OUTFITS = [
  { slug: 'daisy-crown', kind: 'streak', event: 'daisy_crown', manner: 'You wear a daisy crown. You are a little more dreamy than usual.' },
  { slug: 'cozy-scarf', kind: 'streak', event: 'cozy_scarf', manner: 'You wear a cozy scarf. You are a little more caring and tender than usual.' },
  {
    slug: 'thinking-cap',
    kind: 'riddle',
    event: 'thinking_cap',
    manner: 'You wear a thinking cap. You reason out loud: say your thinking in the reply itself, briefly, and then give your answer.',
  },
  {
    slug: 'smart-glasses',
    kind: 'bought',
    event: 'smart_glasses',
    manner: 'You wear smart glasses. You are smarter in them: your answers are more precise and thorough, the same length as ever, and still in your own character.',
  },
  { slug: 'bow-tie', kind: 'bought', event: 'bow_tie', manner: 'You wear a bow tie. You speak politely and with formal good manners.' },
  { slug: 'headphones', kind: 'bought', event: 'headphones', manner: 'You wear headphones. You sound relaxed and easygoing.' },
  { slug: 'party-hat', kind: 'bought', event: 'party_hat', manner: 'You wear a party hat. You joke more than usual.' },
] as const satisfies readonly OutfitDef[];

export type OutfitSlug = (typeof OUTFITS)[number]['slug'];

/** The ids of the items the player may buy (the contract refuses the others, `not_for_sale`). */
export const BOUGHT_IDS = [3, 4, 5, 6] as const;
/** The Thinking cap: the one item `outfit_grant` writes. */
export const THINKING_CAP_ID = 2;

export function slugOf(id: number): OutfitSlug | null {
  return OUTFITS[id]?.slug ?? null;
}

export function idOf(slug: string): number {
  return OUTFITS.findIndex((o) => o.slug === slug);
}

export function isOutfitSlug(value: unknown): value is OutfitSlug {
  return typeof value === 'string' && idOf(value) >= 0;
}

/** The item ids of the pet as slugs, in id order (an id this catalogue does not know is left out). */
export function slugsOf(ids: readonly number[]): OutfitSlug[] {
  return ids.flatMap((id) => {
    const slug = slugOf(id);
    return slug === null ? [] : [slug];
  });
}

/** The item a `streak_mark(day, skipped)` writes for a pet that stood as `before` says: the threshold's item
 * (day 1 the crown, day 3 the scarf; the same arithmetic as `streak_item` in the contract) when the pet lacked
 * it, else null. One answer for the event and for the send's `writes`, so a mark that writes no item leaves no
 * hash. `before.outfits` missing (a row stored before the wardrobe): null, no event and no hash for it. */
export function markItem(before: StreakBefore & { outfits?: readonly number[] }, day: number, skipped: number): OutfitSlug | null {
  const { streak } = applyMark(before, day, skipped);
  const id = streak === 1 ? 0 : streak === 3 ? 1 : null;
  if (id === null || before.outfits === undefined || before.outfits.includes(id)) return null;
  return slugOf(id);
}

export interface WardrobeRow {
  worn: OutfitSlug | null;
  /** The mask of earned items whose notice has been shown (bit = item id). */
  seen: number;
}

/** The pet's row; no row is a pet with nothing worn and nothing seen. */
export async function readWardrobe(db: D1Database, tokenId: string): Promise<WardrobeRow> {
  const row = await db.prepare('SELECT worn, seen FROM wardrobe WHERE token_id = ?').bind(tokenId).first<{ worn: string | null; seen: number }>();
  return { worn: isOutfitSlug(row?.worn) ? row.worn : null, seen: row?.seen ?? 0 };
}

/** The worn item for the request's layer and for any viewer's model. */
export async function wornOf(db: D1Database, tokenId: string): Promise<OutfitSlug | null> {
  return (await readWardrobe(db, tokenId)).worn;
}

/** The earned items the chain holds whose notice has not been shown, in id order (`New outfit notice
 * screen`): a bought item has no notice, the buyer was there. */
export function noticesOf(held: readonly number[], seen: number): OutfitSlug[] {
  return OUTFITS.flatMap((o, id) => (o.kind !== 'bought' && held.includes(id) && (seen & (1 << id)) === 0 ? [o.slug] : []));
}
