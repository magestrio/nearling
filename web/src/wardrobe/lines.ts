import type { OutfitSlug } from '../seams/worker-types';
import { outfitOf } from './catalogue';

// The words of add-wardrobe that Wardrobe screen draws, verbatim from the Scenarios and the frames' `copy`.

export const loadingLine = (name: string) => `Opening ${name}'s wardrobe…`;
export const errorLine = (name: string) => `We couldn't open ${name}'s wardrobe right now. Try again in a moment.`;
export const signedOutLine = (name: string) => `You've been signed out. Sign in to get back to ${name}'s wardrobe.`;
export const emptyLine = (name: string) => `Nothing to wear yet! ${name} earns outfits for daily rituals and riddles — and a well-fed ${name} can buy one below.`;
export const asleepLine = (name: string) => `${name} fell asleep. A meal will wake ${name} up — you can still change outfits.`;
export const shortLine = (name: string) => `${name} needs a little more food before buying this.`;
export const pausedLine = (name: string) => `Shopping is paused on our side while we top up. ${name}'s outfits still work.`;
/** `Outfit purchase flow` › «не прошло» */
export const FAILED_LINE = "That didn't go through. Nothing was spent — try again.";
/** `Outfit purchase flow` › «куплено» */
export const wearingLine = (name: string, item: string) => `${name} is wearing the ${item}!`;
/** What the page's live region says while a purchase is on its way. */
export const BUYING_LINE = 'Buying…';

// New outfit notice screen
export const NOTICE_TITLE = 'New outfit!';
export const noticeStreakLine = (name: string, item: string, days: number) => `${name} earned the ${item} for a ${days}-day streak.`;
export const noticeRiddleLine = (name: string, item: string) => `${name} earned the ${item} for the first solved riddle.`;
export const noticeErrorLine = (name: string, item: string) => `Couldn't put it on just now. The ${item} is waiting in ${name}'s wardrobe.`;

/** The text under the title of an earned item: the streak's threshold, or the first solved riddle. */
export function noticeLine(name: string, slug: OutfitSlug): string {
  const item = outfitOf(slug);
  return item.kind === 'streak' ? noticeStreakLine(name, item.name, item.days!) : noticeRiddleLine(name, item.name);
}
