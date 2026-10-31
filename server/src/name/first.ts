// The feeder's name (`Feeder identity data`): the first word of the Google name, 1-20 letters of any
// alphabet with their combining marks, and not a word of the insult list. Anything else is no name,
// and the pet and its owner say «a friend» (`Feeder name rule` › «имя не подошло»).
import { cleanName } from './clean';
import { hasInsult } from './insult';

/** 1-20 letters, each with its marks (so a Devanagari or an accented name passes); nothing else. */
const LETTERS = /^(?:\p{L}\p{M}*){1,20}$/u;

export function feederName(raw: unknown, insultList: string): string | null {
  if (typeof raw !== 'string') return null;
  const first = cleanName(raw).split(/\p{White_Space}+/u)[0] ?? '';
  if (!LETTERS.test(first) || hasInsult(first, insultList)) return null;
  return first;
}
