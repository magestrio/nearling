import { describe, expect, it } from 'vitest';
import type { DiaryYesterday } from '../seams/worker-types';
import { dayUnit, earnedLine, freshLine, frozenLine, notesLine, partsLine, yesterdayLine } from './lines';

// {time} is the player's clock: the tests pin a zone through the environment of the run, so they read it back
const clock = (iso: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const CLOSED = '2026-10-31T00:00:00.000Z';

describe('the words of the Diary', () => {
  // spec: add-daily-ritual › Daily ritual flow › part still to do × the three wordings
  it('says what the streak still needs in the three wordings of the spec, and nothing when nothing is left', () => {
    expect(partsLine(['question'])).toBe("Today's streak still needs the question.");
    expect(partsLine(['riddle'])).toBe("Today's streak still needs the riddle.");
    expect(partsLine(['question', 'riddle'])).toBe("Today's streak still needs the question and the riddle.");
    expect(partsLine(['riddle', 'question'])).toBe("Today's streak still needs the question and the riddle.");
    expect(partsLine([])).toBeNull();
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × «Streak: 1 day»
  it('uses the singular at 1: «Streak: 1 day», and the plural at every other number', () => {
    expect(dayUnit(1)).toBe('day');
    expect(dayUnit(0)).toBe('days');
    expect(dayUnit(2)).toBe('days');
    expect(frozenLine(1, 0)).toBe('A streak freeze kept your 1-day streak safe. Freezes left: 0.');
    expect(frozenLine(2, 0)).toBe('A streak freeze kept your 2-day streak safe. Freezes left: 0.');
  });

  // spec: add-daily-ritual › Streak rule › серия началась заново × «ran 1 day»
  it('says «ran 1 day» of a streak of one, and «ran 2 days» of two', () => {
    expect(freshLine(1)).toBe('A fresh streak starts today! Your last one ran 1 day.');
    expect(freshLine(2)).toBe('A fresh streak starts today! Your last one ran 2 days.');
  });

  // spec: add-daily-ritual › Streak rule › заработал заморозку
  it('says the earned freeze in the spec\'s words', () => {
    expect(earnedLine(7)).toBe('7 days in a row! You earned a streak freeze — it covers a day you miss.');
  });

  // spec: add-daily-ritual › Streak rule › серия записана позже
  it('puts the notes in the order the Worker gave them, and has none when there are none', () => {
    expect(notesLine(['saving'])).toBe('Saving your streak…');
    expect(notesLine(['forecast'])).toBe("Saved once today's ritual is done.");
    expect(notesLine(['forecast', 'lost'])).toBe("Saved once today's ritual is done. We couldn't save that day on our side.");
    expect(notesLine([])).toBeUndefined();
  });

  // spec: add-daily-ritual › Riddle rule › угадал
  it('says the verdict of yesterday\'s riddle with the revealed answer and the time it closed', () => {
    const at = clock(CLOSED);
    const say = (y: DiaryYesterday) => yesterdayLine(y, CLOSED);
    expect(say({ kind: 'solved', answer: 'a piano' })).toBe(`You solved the riddle that closed at ${at}! It was "a piano".`);
    expect(say({ kind: 'wrong', answer: 'a piano' })).toBe(`Not this time — the answer to the riddle that closed at ${at} was "a piano".`);
    expect(say({ kind: 'none', answer: 'a piano' })).toBe(`The riddle that closed at ${at}: the answer was "a piano".`);
    expect(say({ kind: 'waiting' })).toBe(`The answer to the riddle that closed at ${at} is on its way.`);
    expect(say(null)).toBeNull();
  });
});
