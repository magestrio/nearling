import { resetTime } from '../lib/time';
import type { DiaryPart, DiaryYesterday, StreakNote } from '../seams/worker-types';

// The words of add-daily-ritual that the Diary screen draws, verbatim from the Scenarios and the frames' `copy`. A `{time}` is
// 00:00 UTC as the player's clock shows it: the Worker sends the two midnights of the day as ISO times, `closedAt` and `until`.

/** «days», or «day» at 1: «Streak: 1 day», «ran 1 day» (`Streak rule`). */
export const dayUnit = (n: number) => (n === 1 ? 'day' : 'days');

/** `{time}` of the line, from an ISO time the Worker sent. */
const clock = (iso: string) => resetTime(iso);

export const NOTE_FORECAST = "Saved once today's ritual is done.";
export const NOTE_SAVING = 'Saving your streak…';
export const NOTE_LOST = "We couldn't save that day on our side.";
const NOTES: Record<StreakNote, string> = { forecast: NOTE_FORECAST, saving: NOTE_SAVING, lost: NOTE_LOST };

/** The notes under the streak, in the order the Worker gives them. */
export const notesLine = (notes: StreakNote[]): string | undefined => (notes.length === 0 ? undefined : notes.map((n) => NOTES[n]).join(' '));

export const frozenLine = (n: number, k: number) => `A streak freeze kept your ${n}-day streak safe. Freezes left: ${k}.`;
export const freshLine = (n: number) => `A fresh streak starts today! Your last one ran ${n} ${dayUnit(n)}.`;
export const earnedLine = (n: number) => `${n} days in a row! You earned a streak freeze — it covers a day you miss.`;

/** «Today's streak still needs {parts}.» (`Daily ritual flow` › «part still to do»); null when no part is left. */
export function partsLine(parts: DiaryPart[]): string | null {
  const question = parts.includes('question');
  const riddle = parts.includes('riddle');
  if (question && riddle) return "Today's streak still needs the question and the riddle.";
  if (question) return "Today's streak still needs the question.";
  if (riddle) return "Today's streak still needs the riddle.";
  return null;
}

export const ALL_DONE = 'All done for today!';

export const loadingLine = (name: string) => `Opening ${name}'s diary…`;
export const errorLine = (name: string) => `We couldn't open ${name}'s diary right now. Try again in a moment.`;
export const signedOutLine = (name: string) => `You've been signed out. Sign in to get back to ${name}'s diary.`;

// The entry's place when there is no entry text (`Diary screen` › «empty», «память стёрта сегодня»; `Daily ritual flow`).
export const firstEntryLine = (name: string, until: string) => `${name} writes its first diary entry at ${clock(until)}. Come back after that to read it!`;
export const clearedEntryLine = (name: string, until: string) =>
  `You cleared ${name}'s memory, so its latest diary entry is gone. ${name} writes a fresh one at ${clock(until)}.`;
export const writingLine = (name: string) => `${name} is writing its diary…`;
export const asleepEntryLine = (name: string) => `${name} was asleep at diary time, so there's no diary today.`;
export const failedEntryLine = (name: string) =>
  `${name} couldn't write its diary this time — the problem was on our side. There's no diary or question today.`;

// The pet fell asleep on the open Diary (`Diary screen` › «asleep», «уснул с набранным ответом»).
export const fellAsleepLine = (name: string) => `${name} fell asleep. Today still counts for your streak.`;
export const keptRiddleLine = (name: string) => `Your riddle answer is saved for when ${name} wakes up.`;

// The riddle (`Riddle rule`).
export const HINT_LINE = 'Up to 40 characters.';
export const HELD_LINE = "Today's riddle is held up on our side. If it's ready today, it'll show up right here.";
export const ANSWERED_TODAY = 'Answered today';
export const answerInLine = (until: string) => `Answer in! Find out if you got it after ${clock(until)}.`;

/** An answer that came after its riddle closed (`Riddle rule` › «ответ опоздал»): with today's riddle open under the line, or not. */
export const lateLine = (closedAt: string, todaysOpen: boolean) =>
  todaysOpen ? `That riddle closed at ${clock(closedAt)}. Here's today's!` : `That riddle closed at ${clock(closedAt)}.`;

/** Yesterday's riddle above today's: the verdict, or that it is on its way; null for a riddle that never opened (no block). */
export function yesterdayLine(y: DiaryYesterday, closedAt: string): string | null {
  if (y === null) return null;
  const time = clock(closedAt);
  switch (y.kind) {
    case 'waiting':
      return `The answer to the riddle that closed at ${time} is on its way.`;
    case 'solved':
      return `You solved the riddle that closed at ${time}! It was "${y.answer}".`;
    case 'wrong':
      return `Not this time — the answer to the riddle that closed at ${time} was "${y.answer}".`;
    case 'none':
      return `The riddle that closed at ${time}: the answer was "${y.answer}".`;
  }
}
