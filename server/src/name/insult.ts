// The list check of a name (Public pet data > «слова имени», «заглавные перед строчной»).
// Server only: the list is a secret (`INSULT_LIST`, one word per line) and never reaches the browser.
//
// A name is cut into words and each whole word is compared with the list, case aside:
//  1. chunks are the longest runs of letters (\p{L}) with their combining marks (\p{M}); every
//     other character - a space, a digit, "_", "!", an emoji - splits;
//  2. inside a chunk a word boundary stands where a lowercase letter is followed by an uppercase
//     (or titlecase) one: "Big|Idiot";
//  3. where two or more capitals stand before a lowercase letter the place has two options:
//     after the capitals ("SHIT|face") or before the last of them ("FUCK|Shit", "BIG|Idiot");
//  4. the candidate words are the segments between neighbouring boundaries under every choice of
//     option at every such place (the choices are independent).
// Letters without case (\p{Lo}) have no case boundary; a mark does not split a letter.
// The list words are letters only, so a list line with a space, a digit or a dash matches nothing.
// The same function checks a feeder's name (`add-feeding`): one call, no branch of its own.

type Kind = 'lower' | 'upper' | 'other';

interface Place {
  /** The boundary before the last capital of the run. */
  before: number;
  /** The boundary after the capitals, before the lowercase letter. */
  after: number;
}

const LETTER_OR_MARK = /^[\p{L}\p{M}]+$/u;
const MARK = /^\p{M}$/u;
const LOWER = /^\p{Ll}$/u;
const UPPER = /^[\p{Lu}\p{Lt}]$/u;

/** Parses the list once per distinct value: the lowercase words and the longest one. */
let cachedRaw: string | null = null;
let cachedList: { words: Set<string>; longest: number } = { words: new Set(), longest: 0 };

export function parseList(raw: string): { words: Set<string>; longest: number } {
  if (raw === cachedRaw) return cachedList;
  const words = new Set<string>();
  let longest = 0;
  for (const line of raw.split(/\r?\n/)) {
    const word = line.trim().toLocaleLowerCase('en');
    if (word === '') continue;
    words.add(word);
    longest = Math.max(longest, [...word].length);
  }
  cachedRaw = raw;
  cachedList = { words, longest };
  return cachedList;
}

function kindOf(ch: string): Kind {
  if (LOWER.test(ch)) return 'lower';
  if (UPPER.test(ch)) return 'upper';
  return 'other';
}

/** True when a whole word of `rawList` is in `name`. */
export function hasInsult(name: string, rawList: string): boolean {
  const { words, longest } = parseList(rawList);
  if (words.size === 0) return false;
  // A candidate longer than the longest list word (plus room for lowercasing that lengthens a
  // letter) cannot match: this bounds the work for a long chunk.
  const maxCandidate = longest * 2 + 2;

  for (const chunk of splitChunks(name)) {
    if (candidates(chunk, maxCandidate).some((word) => words.has(word.toLocaleLowerCase('en')))) return true;
  }
  return false;
}

/** Runs of letters and marks, as arrays of code points. */
function splitChunks(name: string): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const ch of name) {
    if (LETTER_OR_MARK.test(ch)) {
      current.push(ch);
    } else if (current.length > 0) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Every segment between neighbouring boundaries under some choice of the optional places. */
function candidates(cps: string[], maxCandidate: number): string[] {
  // Marks are transparent for the case boundaries: a boundary stands before a base letter.
  const bases: number[] = [];
  const kinds: Kind[] = [];
  cps.forEach((ch, i) => {
    if (MARK.test(ch)) return;
    bases.push(i);
    kinds.push(kindOf(ch));
  });

  const definite = new Set<number>();
  const places: Place[] = [];
  for (let k = 1; k < bases.length; k += 1) {
    if (kinds[k - 1] === 'lower' && kinds[k] === 'upper') definite.add(bases[k]!);
    if (kinds[k] === 'lower' && kinds[k - 1] === 'upper' && k >= 2 && kinds[k - 2] === 'upper') {
      places.push({ before: bases[k - 1]!, after: bases[k]! });
    }
  }

  const n = cps.length;
  const starts = new Set<number>([0, ...definite]);
  const ends = new Set<number>([n, ...definite]);
  for (const p of places) {
    starts.add(p.before).add(p.after);
    ends.add(p.before).add(p.after);
  }

  const out: string[] = [];
  for (const a of starts) {
    for (const b of ends) {
      if (b <= a || b - a > maxCandidate) continue;
      if (!segmentIsPossible(a, b, definite, places)) continue;
      out.push(cps.slice(a, b).join(''));
    }
  }
  return out;
}

/** [a, b) is a segment between neighbouring boundaries when no boundary stands strictly inside it
 * under the choice that makes a and b boundaries: no definite one inside, and no place with both
 * of its options inside (it keeps one of them) or with both as the segment's two ends. */
function segmentIsPossible(a: number, b: number, definite: Set<number>, places: Place[]): boolean {
  for (const d of definite) if (d > a && d < b) return false;
  for (const p of places) {
    if (p.before > a && p.after < b) return false;
    if (a === p.before && b === p.after) return false;
  }
  return true;
}
