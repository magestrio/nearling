// The diary the fakes answer and the e2e fixtures lay their fields over. No import but the types: Playwright's Node reads it too.
import type { DiaryView } from './worker-types';

/** The UTC day of the sample diary: 2026-10-31, the frames' day (design/BRIEF.md §1). */
export const SAMPLE_DAY = 20_757;
const DAY_MS = 86_400_000;

/** The diary the real route would answer for an awake pet on an ordinary day: the entry and its question, an open riddle, a streak
 *  of 2 with its freeze, nothing done. A test lays its own fields over it. */
export function sampleDiary(day: number = SAMPLE_DAY): DiaryView {
  return {
    day,
    closedAt: new Date(day * DAY_MS).toISOString(),
    until: new Date((day + 1) * DAY_MS).toISOString(),
    entry: {
      kind: 'text',
      id: 'diary-1',
      lines: [
        'Yesterday you told me about the chart nobody understands. After you left I counted the fridge again — forty-three hums this time, two more than the night before.',
        'I think the fridge is getting nervous about your presentation too.',
      ],
      question: 'Did the chart surprise anyone?',
      work: null,
    },
    read: false,
    exchange: null,
    riddle: { kind: 'open', day, text: "What has hands but can't clap?" },
    yesterday: { kind: 'solved', answer: 'a piano' },
    streak: { days: 2, freezes: 1, done: false, line: null, n: 2, k: 1, missed: 0, note: [] },
    parts: ['question', 'riddle'],
    complete: false,
  };
}
