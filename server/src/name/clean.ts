// Cleaning of a pet's (or a feeder's) name. A pure function with no imports and no word list.
//
// `web/src/lib/nameClean.ts` is a byte-for-byte copy of this file (the browser cleans the name
// for the Hatch screen's notice the same way); `diff -q` checks it. Keep the file free of
// anything either side does not have.
//
// Public pet data: the server trims the edges, cuts control, text-direction and other invisible
// characters - except the joiner, the variation selectors and the tags inside an emoji - and
// refuses a name with nothing visible.

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** A grapheme is an emoji when it carries a pictograph, a regional indicator or the keycap mark. */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u;

/** What is cut from every grapheme. `Default_Ignorable_Code_Point` holds U+200B-U+200F,
 * U+2060-U+206F, U+FEFF, U+00AD, the variation selectors, the tags, U+3164 and the rest of the
 * standard invisibles - Unicode's own definition, not a list of ours. */
const INVISIBLE = /[\p{Cc}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu;

/** Inside an emoji grapheme these stay: U+200D (joiner), U+FE0E/U+FE0F (variation selectors),
 * U+E0020-U+E007F (tags, for the flags of regions). */
const KEPT_IN_EMOJI = /[\p{Cc}\p{Bidi_Control}]|(?![‍︎️\u{E0020}-\u{E007F}])\p{Default_Ignorable_Code_Point}/gu;

const EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;

export function cleanName(raw: string): string {
  let out = '';
  for (const { segment } of graphemes.segment(raw)) {
    out += EMOJI.test(segment) ? segment.replace(KEPT_IN_EMOJI, '') : segment.replace(INVISIBLE, '');
  }
  // After the cutting, so that " <U+200B> Pixel" does not leave a space at the start.
  return out.replace(EDGES, '');
}

/** True when there is a character that is not white space, a control, a format character or a
 * default-ignorable one. One definition for a name and for a player's line. */
export function hasVisible(s: string): boolean {
  return /[^\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(s);
}
