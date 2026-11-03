// The leak filter of a skilled answer (`Skilled answer data` › «reply stopped», ADR-023): a worker's reply that
// repeats its private instruction word for word is stopped before anything is stored or shown. Pure: both texts
// are folded the same way (NFKC, lower case, every run of signs that are not letters or digits as one space)
// and compared as runs of words. A retelling passes; that is the filter's limit, not a defect.

/** An instruction this long or longer is stopped by any run of this many of its words. */
const RUN_WORDS = 8;
/** An instruction shorter than this is not checked: a word or two is no secret worth a stopped answer. */
const MIN_CHECKED_WORDS = 3;

function wordsOf(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '');
}

/** Whether `reply` holds 8 words in a row of `instruction`, or all of an instruction of 3 to 7 words. */
export function quotesInstruction(instruction: string, reply: string): boolean {
  const secret = wordsOf(instruction);
  if (secret.length < MIN_CHECKED_WORDS) return false;
  // Padded with a space on both sides, so that a run is matched on whole words only.
  const haystack = ` ${wordsOf(reply).join(' ')} `;
  const run = Math.min(RUN_WORDS, secret.length);
  for (let start = 0; start + run <= secret.length; start += 1) {
    if (haystack.includes(` ${secret.slice(start, start + run).join(' ')} `)) return true;
  }
  return false;
}
