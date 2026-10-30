// The name field of the Hatch screen takes up to 32 bytes of UTF-8 as the player typed them (`Pet mint contract`;
// the user's decision: count the typed text, not the cleaned one — the cleaned is never longer). The field refuses what
// would not fit and never cuts a letter with its accent or a compound emoji in the middle: it works in graphemes.
// `maxLength` would count UTF-16 units and cut mid-grapheme, so the field has none.
export const MAX_NAME_BYTES = 32;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const encoder = new TextEncoder();

const bytes = (s: string) => encoder.encode(s).length;
const graphemesOf = (s: string) => Array.from(segmenter.segment(s), (x) => x.segment);

/** `next` is what the field would hold after the player's edit, `prev` what it held. Returns the text to keep: `next`
 *  when it fits; otherwise `prev` with as much of the inserted text as fits, whole graphemes only. */
export function fitName(prev: string, next: string): string {
  if (bytes(next) <= MAX_NAME_BYTES) return next;
  const before = graphemesOf(prev);
  const after = graphemesOf(next);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  const prefix = after.slice(0, head);
  const suffix = after.slice(after.length - tail);
  const inserted = after.slice(head, after.length - tail);
  // anything but a pure insertion (a letter replaced by its accented form, a selection typed over) that does not fit
  // is refused whole: the old text stays
  if (prefix.join('') + suffix.join('') !== prev) return bytes(prev) <= MAX_NAME_BYTES ? prev : graphemesOf(prev).reduce((kept, g) => (bytes(kept + g) <= MAX_NAME_BYTES ? kept + g : kept), '');
  let used = bytes(prev);
  const take: string[] = [];
  for (const g of inserted) {
    if (used + bytes(g) > MAX_NAME_BYTES) break;
    take.push(g);
    used += bytes(g);
  }
  return prefix.join('') + take.join('') + suffix.join('');
}
