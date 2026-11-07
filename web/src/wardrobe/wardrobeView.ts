import { formatCents } from '../lib/price';
import type { OutfitSlug, WardrobeView } from '../seams/worker-types';
import { known, nameOf, OUTFITS, pictureOf, type Outfit } from './catalogue';

/** A confirmed automatic wish purchase is distinct from an owner tap's «is wearing» line. */
export function wishEarnedLine(name: string, view: WardrobeView | null): string | null {
  const outcome = view?.outcome;
  if (outcome?.status !== 'bought' || outcome.source !== 'pet_wish') return null;
  return `${name} earned ${nameOf(outcome.item) ?? outcome.item}!`;
}
import { asleepLine, emptyLine, errorLine, FAILED_LINE, loadingLine, pausedLine, shortLine } from './lines';

// What Wardrobe screen draws, as data (design.md › Клиент › `wardrobeView`): the tiles in the placement's order — own, earned not
// yet, to buy, each in the catalogue's order — every tile's action and state, the lines, and which line each off «Buy» is described
// by. Pure: `WardrobePage` only draws it, and the tests below the page read it state by state.

/** The ids of the lines a tile or a button is described by (`aria-describedby`). */
export const LINE = { asleep: 'asleep-line', paused: 'paused-line', short: 'buy-line', failed: 'buy-failed', empty: 'empty-line' } as const;

export interface WardrobeInput {
  name: string;
  /** `loading`: no read yet; `error`: the first read failed with nothing to show; `ready`: a read is there (a later failed poll
   *  is the connection line over it, not this) */
  status: 'loading' | 'error' | 'ready';
  /** the pet is seen asleep (the page's `/state`, which also runs the wake) */
  asleep: boolean;
  /** what the Pet screen already knows of the pet: the tiles of a wardrobe still opening, and the outfit under an error */
  pet: { outfits: OutfitSlug[]; worn: OutfitSlug | null; outfitPrice: { cents: number } };
  view: WardrobeView | null;
  /** the item whose purchase did not go through, until the tab's next action (the tab's memory) */
  failed: OutfitSlug | null;
  /** the item whose «Buy» was tapped in this tab, before a read holds it in `buying` */
  tapped: OutfitSlug | null;
}

export interface TileDraw {
  slug: OutfitSlug;
  name: string;
  picture: string;
  kind: 'own' | 'earn' | 'buy';
  worn: boolean;
  /** «Wear» · «Take off» · «Buy» · «Try again»; none on a tile that shows its condition */
  action?: string;
  /** «0.76¢», after «Buy» only */
  price?: string;
  /** the condition of an earned item that is not earned yet */
  condition?: string;
  /** what the tap does */
  does?: 'wear' | 'takeoff' | 'buy';
  off?: boolean;
  disabled?: boolean;
  pending?: boolean;
  /** the id of the line that says why the button is off, or what went wrong */
  why?: string;
}

export interface LineDraw {
  id: string;
  text: string;
}

export interface WardrobeDraw {
  /** the line about the page at the top of the column, and its action */
  top: { tone: 'status' | 'error' | 'plain'; text: string; action: 'try-again' | 'back' | null; id?: string } | null;
  /** the lines at the top of the list: nothing to wear yet, shopping paused */
  listLines: LineDraw[];
  /** the food line just above the Buy items, which then stand in a grid of their own */
  buyLine: LineDraw | null;
  /** the line across the grid under the tile whose purchase did not go through */
  failedNote: LineDraw | null;
  /** none while the wardrobe could not be read */
  tiles: { mine: TileDraw[]; notYet: TileDraw[]; toBuy: TileDraw[] } | null;
  /** the item the pet wears on this screen */
  worn: OutfitSlug | null;
  /** the item whose purchase is on its way */
  buying: OutfitSlug | null;
}

export function wardrobeView(input: WardrobeInput): WardrobeDraw {
  const { name, status, asleep: seenAsleep, pet, view } = input;
  const worn = view ? view.worn : pet.worn;
  if (status === 'error') {
    return { top: { tone: 'error', text: errorLine(name), action: 'try-again' }, listLines: [], buyLine: null, failedNote: null, tiles: null, worn, buying: null };
  }
  const loading = status === 'loading' || view === null;
  const owned = new Set(known(loading ? pet.outfits : view.owned));
  const price = formatCents((view?.price ?? pet.outfitPrice).cents);

  // Why Buy is off. Asleep: the page's line, no food line. Awake: the pause (the list's line) and the food (the line above the Buy
  // items) both stand when both are true, and the pause is what Buy's `why` names. A purchase on its way turns the others off
  // with no line of their own, and the food line waits for it to land: its price is the reason, and the price is spent by then.
  const buying = loading ? null : (view.buying?.item ?? input.tapped);
  const asleep = !loading && seenAsleep;
  const paused = !loading && !asleep && view.shopPaused;
  const short = !loading && !asleep && buying === null && view.short;
  const buyOff = asleep || paused || short || buying !== null;
  const why = asleep ? LINE.asleep : paused ? LINE.paused : short ? LINE.short : undefined;
  // the failed line stands while Buy is on; when Buy turns off, its own line says why (`Outfit purchase flow` › «не прошло»)
  const failed = !buyOff && input.failed !== null && !owned.has(input.failed) && OUTFITS.some((o) => o.slug === input.failed && o.kind === 'bought') ? input.failed : null;

  const tile = (o: Outfit): TileDraw => {
    const base = { slug: o.slug, name: o.name, picture: pictureOf(o.slug), worn: o.slug === worn };
    if (owned.has(o.slug)) {
      const on = o.slug === worn;
      return { ...base, kind: 'own', action: on ? 'Take off' : 'Wear', does: on ? 'takeoff' : 'wear', disabled: loading };
    }
    if (o.kind !== 'bought') return { ...base, kind: 'earn', condition: o.condition };
    const retry = o.slug === failed;
    return {
      ...base,
      kind: 'buy',
      action: retry ? 'Try again' : 'Buy',
      // «Try again» has no price: it was on the Buy before the first tap, and the label stays on one line
      price: retry ? undefined : price,
      does: 'buy',
      disabled: loading,
      off: buyOff && o.slug !== buying,
      pending: o.slug === buying,
      why: retry ? LINE.failed : buyOff ? why : undefined,
    };
  };
  const mine = OUTFITS.filter((o) => owned.has(o.slug)).map(tile);
  const notYet = OUTFITS.filter((o) => o.kind !== 'bought' && !owned.has(o.slug)).map(tile);
  const toBuy = OUTFITS.filter((o) => o.kind === 'bought' && !owned.has(o.slug)).map(tile);

  if (loading) {
    return { top: { tone: 'status', text: loadingLine(name), action: null }, listLines: [], buyLine: null, failedNote: null, tiles: { mine, notYet, toBuy }, worn, buying: null };
  }
  const listLines: LineDraw[] = [];
  if (owned.size === 0) listLines.push({ id: LINE.empty, text: emptyLine(name) });
  if (paused) listLines.push({ id: LINE.paused, text: pausedLine(name) });
  return {
    top: asleep ? { tone: 'plain', text: asleepLine(name), action: 'back', id: LINE.asleep } : null,
    listLines,
    buyLine: short && toBuy.length > 0 ? { id: LINE.short, text: shortLine(name) } : null,
    failedNote: failed !== null ? { id: LINE.failed, text: FAILED_LINE } : null,
    tiles: { mine, notYet, toBuy },
    worn,
    buying,
  };
}
