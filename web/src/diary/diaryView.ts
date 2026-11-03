import type { StreakCell } from '../ds';
import type { DiaryEntry, DiaryView } from '../seams/worker-types';
import {
  ALL_DONE,
  ANSWERED_TODAY,
  answerInLine,
  asleepEntryLine,
  clearedEntryLine,
  dayUnit,
  earnedLine,
  failedEntryLine,
  firstEntryLine,
  freshLine,
  frozenLine,
  HELD_LINE,
  notesLine,
  partsLine,
  workLine,
  writingLine,
  yesterdayLine,
} from './lines';
import { streakCells } from './streakCells';

// What each part of the Diary draws, from the Worker's answer: pure, so the screen only lays it out and a test reads it without
// one (design.md › Клиент › `diaryView.ts`).

export interface StreakDraw {
  days: number;
  freezes: number;
  done: boolean;
  unit: string;
  cells?: StreakCell[];
  line?: string;
  note?: string;
}

export function streakDraw(d: DiaryView): StreakDraw {
  const s = d.streak;
  // While the day saves, or could not be saved, the number and the strip stay the recorded ones (`Streak rule` › «серия записана
  // позже»): today is counted in the strip only once the mark has landed
  const counted = s.done && !s.note.includes('saving') && !s.note.includes('lost');
  return {
    days: s.days,
    freezes: s.freezes,
    done: counted,
    unit: dayUnit(s.days),
    // frozen days stand beside today only in the forecast; a streak that restarts shows today alone, by the DS's own rule
    cells: s.days > 0 ? streakCells(s.days, s.missed, counted) : undefined,
    line: s.line === 'frozen' ? frozenLine(s.n, s.k) : s.line === 'fresh' ? freshLine(s.n) : s.line === 'earned' ? earnedLine(s.n) : undefined,
    note: notesLine(s.note),
  };
}

/** The entry: its text in the pet's voice with the question as the last line, or the game's line in its place (no author). */
export type EntryDraw =
  | { kind: 'text'; lines: string[]; question: string | null; work: string | null }
  | { kind: 'line'; text: string };

export function entryDraw(entry: DiaryEntry, name: string, until: string, closedAt = ''): EntryDraw {
  switch (entry.kind) {
    case 'text':
      return { kind: 'text', lines: entry.lines, question: entry.question, work: entry.work === null ? null : workLine(name, closedAt, entry.work) };
    case 'first':
      return { kind: 'line', text: firstEntryLine(name, until) };
    case 'cleared':
      return { kind: 'line', text: clearedEntryLine(name, until) };
    case 'writing':
      return { kind: 'line', text: writingLine(name) };
    case 'asleep':
      return { kind: 'line', text: asleepEntryLine(name) };
    case 'failed':
      return { kind: 'line', text: failedEntryLine(name) };
  }
}

/** The riddle block: yesterday's line above (none: no such line), then today's riddle, or the line that holds its place. */
export interface RiddleDraw {
  yesterday: string | null;
  today:
    | { kind: 'held' }
    | { kind: 'open'; day: number; text: string }
    | { kind: 'answered'; text: string; line: string; answer: string | null };
}

export function riddleDraw(d: DiaryView): RiddleDraw {
  const yesterday = yesterdayLine(d.yesterday, d.closedAt);
  const r = d.riddle;
  if (r.kind === 'held') return { yesterday, today: { kind: 'held' } };
  if (r.kind === 'open') return { yesterday, today: { kind: 'open', day: r.day, text: r.text } };
  // an answer taken stands in the field's place; one erased with the memory is only "Answered today"
  return { yesterday, today: { kind: 'answered', text: r.text, line: r.answer === null ? ANSWERED_TODAY : answerInLine(d.until), answer: r.answer } };
}

/** The end of the column: «All done for today!» once the ritual has ended, else what the streak still needs (the same place). */
export function endNote(d: DiaryView): { kind: 'done' | 'needs'; text: string } | null {
  if (d.complete) return { kind: 'done', text: ALL_DONE };
  const needs = partsLine(d.parts);
  return needs === null ? null : { kind: 'needs', text: needs };
}

/** The diary's parts as the page's live region can say them, in the column's order. `reply` — the pet's reply with its speaker,
 *  as the Message's own hidden speaker reads. */
export function partLines(streak: StreakDraw, entry: EntryDraw, riddle: RiddleDraw, reply: string | null, end: string | null): string[] {
  const lines = [
    `Streak: ${streak.days} ${streak.unit} · Freezes: ${streak.freezes}`,
    streak.line,
    streak.note,
    ...(entry.kind === 'line' ? [entry.text] : [...entry.lines, entry.question, entry.work]),
    riddle.yesterday,
    riddle.today.kind === 'held' ? HELD_LINE : riddle.today.text,
    riddle.today.kind === 'answered' ? riddle.today.line : null,
    reply,
    end,
  ];
  return lines.filter((line): line is string => typeof line === 'string' && line !== '');
}

/** What can be said now: the lines of the page's state (`states`), and the diary's parts once a diary is on screen. */
export interface Sayable {
  states: string[];
  parts: string[] | null;
}

/** What the page's one live region says after a change (`design/bundle/screens/diary.js`: «says what replaces a part»): the lines
 *  that came, never all of them, or an `aria-atomic` status would read the unchanged ones again. With no new line it keeps what
 *  is still true, so a line that goes is emptied and said again when it comes back. The parts of a diary that has just opened are
 *  there to be read, not said. */
export function nextSaid(said: string[], before: Sayable, now: Sayable): string[] {
  const known = [...before.states, ...(before.parts ?? now.parts ?? [])];
  const all = [...(now.parts ?? []), ...now.states];
  const came = all.filter((line) => !known.includes(line));
  return came.length > 0 ? came : said.filter((line) => all.includes(line));
}
