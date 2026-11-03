// The words of add-pet-errands that the Pet screen and Errand sheet draw, verbatim from the Scenarios and the frames' `copy`
// (design/bundle/screens/errand.js). `{price}` is `formatCents`; `{time}` is 00:00 UTC on the player's clock.
import { formatCents } from '../lib/price';
import { resetTime } from '../lib/time';
import { emptyPaidLine, lostLine, pausedLine, tiredLine } from '../screens/pet/lines';
import type { ErrandBlock, ErrandFailure, ErrandForm } from '../seams/worker-types';

export const FORM_WORD: Record<ErrandForm, string> = { read: 'Read this', find: 'Find out', check: 'Is it true?' };
export const FORM_ICON = { read: 'page', find: 'compass', check: 'scales' } as const;
export const FORMS: readonly ErrandForm[] = ['read', 'find', 'check'];
export const MISSIONS_LABEL = 'Errand';
export const SEND = 'Send';

/** The job's limits in code points (`Errand sheet screen`): a link or text to read, or a question or claim. */
export const LIMIT: Record<ErrandForm, number> = { read: 30_000, find: 500, check: 500 };

export const errandTitle = (name: string) => `Send ${name} on an errand`;
export const fieldLabel = (form: ErrandForm, name: string) =>
  form === 'read' ? 'Paste a link or some text' : form === 'find' ? `What should ${name} find out?` : `What claim should ${name} check?`;
export const searchOnlyLine = (name: string) => `Only these words go to web search — never ${name}'s memory.`;
export const shortLine = (name: string) => `That's as far as ${name}'s food goes right now.`;
export const errandErrorLine = (name: string) => `We couldn't get ${name} ready for an errand right now. Try again in a moment.`;

/** {labels} as the diary's hirers: «A, B and C». */
export function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}
export const throughLine = (name: string, labels: string[]) => `${name} may look things up through ${joinLabels(labels)}. Whoever runs them sees what ${name} looks up.`;

/** The line that stands in «Send»'s place: the first block that holds (`Errand flow` › «several blocks at once»). */
export function blockLine(block: ErrandBlock, name: string): string {
  switch (block.reason) {
    case 'paused':
      return pausedLine(name);
    case 'food':
    case 'asleep':
      return `This errand needs up to ${formatCents(block.need?.cents ?? 0)} of food — more than ${name} has. Feed ${name} and your errand will wait here.`;
    case 'energy':
      return `${name} is resting until ${resetTime(block.until)} — errands take energy. Chatting still works.`;
    case 'cap':
      return tiredLine(name, block.until);
  }
}

export const sentLine = (name: string) => `${name} is off on your errand — back soon, usually within a minute.`;
export const CHECK_THOUGHT = 'Check this thought';
export const SHARE_CARD = 'Share card';

/** The exact price under a report: «Read · 0.14¢», «3 searches · 1.42¢», «1 search · 0.66¢». */
export function reportMeta(form: ErrandForm, searches: number, cents: number): string {
  const price = formatCents(cents);
  return form === 'read' ? `Read · ${price}` : `${searches} ${searches === 1 ? 'search' : 'searches'} · ${price}`;
}
export const nothingFoundLine = (name: string) => `${name} looked but found nothing solid on this.`;
export const unclearLine = (name: string) => `Unclear — ${name} couldn't find enough to say either way.`;
export const missedLine = (label: string, name: string) => `${label} didn't answer, so ${name} went on without it.`;
/** `Adapter call rule` › data failed in an errand, code. */
export const codeMissedLine = (name: string) => `${name}'s code didn't answer, so ${name} went on without it.`;
export const clearedReportLine = (name: string, cents: number) =>
  `${name}'s memory was cleared while it was out, so this report wasn't kept. The errand still used ${formatCents(cents)} of food.`;

const cameBackEmpty = (name: string, cents: number) => `${name} came back empty-handed. Its searches still cost ${formatCents(cents)}. Your errand is kept — try again.`;

/** The line an errand that came back with no report says (`Errand flow`, `Read this flow`, `Find out flow`). `cents` is what the
 *  pet paid, undefined when nothing was spent. `blocked` has none: the page opens Errand sheet instead. */
export function failureLine(name: string, f: { form: ErrandForm; reason: ErrandFailure; cents?: number }): string {
  switch (f.reason) {
    case 'unreadable':
      return `${name} couldn't open that page. Paste its text and ${name} will read that instead. Nothing was spent.`;
    case 'too_long':
      return `That's too long for ${name} to read in one go. Try a single page or a shorter piece. Nothing was spent.`;
    case 'search_down':
      return f.cents === undefined
        ? `${name} couldn't reach web search just now. Nothing was spent — your errand is kept.`
        : `${name} couldn't reach web search just now. The try used a little of ${name}'s food — your errand is kept.`;
    case 'timeout':
      return f.cents === undefined ? `${name} didn't make it back with a report. Nothing was spent — your errand is kept, try again.` : cameBackEmpty(name, f.cents);
    case 'empty':
      // nothing paid: the pet's own «lost that thought»; a read the pet paid for is the shared line; searches that ran came back empty
      if (f.cents === undefined) return lostLine(name);
      return f.form === 'read' ? emptyPaidLine(name) : cameBackEmpty(name, f.cents);
    case 'blocked':
      return lostLine(name);
  }
}

/** The words of an `errand_empty` line of the conversation: a paid errand with no report. */
export const emptyErrandLine = (name: string, form: ErrandForm, cents: number) => failureLine(name, { form, reason: 'empty', cents });
