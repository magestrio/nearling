// The list of riddles (`RIDDLE_LIST`, the user's secret, PRODUCT.md §8 › Список загадок): a JSON array
// `[{"text":"…","answers":["a piano","piano"]}]`. The first answer is the riddle's own — it is what the
// screen shows as {answer}, for everyone. The riddle of a day is `list[day % list.length]`.

export interface RiddleItem {
  text: string;
  answers: string[];
}

/** The list, or `null` when the secret is missing, does not parse, is empty or holds an item that is not
 * a text with at least one answer. A list like that opens no riddle (`Riddle rule` › «загадка ещё не
 * запечатана»); the caller logs `riddle_list_bad`. */
export function parseRiddleList(raw: string | undefined): RiddleItem[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const list: RiddleItem[] = [];
  for (const item of parsed as unknown[]) {
    const { text, answers } = (item ?? {}) as { text?: unknown; answers?: unknown };
    if (typeof text !== 'string' || text.trim() === '') return null;
    if (!Array.isArray(answers) || answers.length === 0 || !answers.every((a) => typeof a === 'string' && a.trim() !== '')) return null;
    list.push({ text, answers: answers as string[] });
  }
  return list;
}

/** The riddle of a UTC day. */
export const riddleOf = (list: readonly RiddleItem[], day: number): RiddleItem => list[day % list.length]!;
