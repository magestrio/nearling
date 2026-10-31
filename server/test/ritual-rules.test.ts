// The pure rules of the daily ritual: the question of the entry, the parts, the end of the ritual, and the
// streak arithmetic and its forecast (`pet/ritual.ts`, `pet/streak.ts`). No D1, no network.
import { describe, expect, it } from 'vitest';
import cases from '../../contract/tests/fixtures/streak-cases.json';
import { doableParts, isComplete, partsOf, splitEntry, type Facts } from '../src/pet/ritual';
import { applyMark, forecastOf, type ForecastInput } from '../src/pet/streak';

/** An awake pet on a day with everything available and nothing done. */
const facts = (patch: Partial<Facts> = {}): Facts => ({
  entry: 'text',
  hasQuestion: true,
  asleep: false,
  tired: false,
  paused: false,
  opened: true,
  read: false,
  questionAnswered: false,
  questionOnItsWay: false,
  riddleSealed: true,
  riddleAnswered: false,
  ...patch,
});

describe('the question of the entry', () => {
  // spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × last line of the entry
  it('is the last non-empty line when it ends in a question mark, a closing quote allowed', () => {
    expect(splitEntry('I dreamed of clocks.\nI chased a ball.\n\nDid you sleep well?\n')).toEqual({
      lines: ['I dreamed of clocks.', 'I chased a ball.'],
      question: 'Did you sleep well?',
    });
    expect(splitEntry('Today I learned a word.\nWhat does "cozy" mean to you?"')).toMatchObject({ question: 'What does "cozy" mean to you?"' });
    expect(splitEntry('A line.\nWhat is your favourite sound?”')).toMatchObject({ question: 'What is your favourite sound?”' });
  });

  // spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × last line of the entry
  it('is the last sentence of a one-paragraph reply', () => {
    expect(splitEntry('I had a quiet night. I dreamed of rain! Do you like rain?')).toEqual({
      lines: ['I had a quiet night. I dreamed of rain!'],
      question: 'Do you like rain?',
    });
    expect(splitEntry('Do you like rain?')).toEqual({ lines: [], question: 'Do you like rain?' });
  });

  // spec: add-daily-ritual › Daily ritual flow › отвечает на вопрос дня × no question in the entry
  it('is none when the entry does not end in a question mark, and a reply cut at a limit lands there too', () => {
    expect(splitEntry('I had a quiet night.\nI dreamed of rain.')).toEqual({ lines: ['I had a quiet night.', 'I dreamed of rain.'], question: null });
    // a question in the middle is not the day's question
    expect(splitEntry('Why is the sky blue? I do not know.')).toEqual({ lines: ['Why is the sky blue? I do not know.'], question: null });
    // cut in the middle of a sentence
    expect(splitEntry('I dreamed of rain and then I')).toEqual({ lines: ['I dreamed of rain and then I'], question: null });
    expect(splitEntry('')).toEqual({ lines: [], question: null });
    expect(splitEntry('  \n \n')).toEqual({ lines: [], question: null });
  });
});

describe('the parts and the end of the ritual', () => {
  // spec: add-daily-ritual › Daily ritual flow › ритуал завершён × the rule of the parts
  it('leaves the entry, the question and the riddle on a day with everything available', () => {
    expect(partsOf(facts())).toEqual(['diary', 'question', 'riddle']);
    expect(isComplete(facts())).toBe(false);
    expect(isComplete(facts({ read: true, questionAnswered: true, riddleAnswered: true }))).toBe(true);
    expect(partsOf(facts({ read: true, questionAnswered: true, riddleAnswered: true }))).toEqual([]);
  });

  // spec: add-daily-ritual › Daily ritual flow › ритуал завершён × the rule of the parts
  it('takes the question from a pet that is asleep, tired or paused, and the riddle from a sleeping one', () => {
    expect(partsOf(facts({ asleep: true }))).toEqual(['diary']);
    expect(partsOf(facts({ tired: true }))).toEqual(['diary', 'riddle']);
    expect(partsOf(facts({ paused: true }))).toEqual(['diary', 'riddle']);
    // a part is available only if it exists: no entry, no question; a riddle not sealed is not waited for
    expect(partsOf(facts({ entry: 'failed', hasQuestion: false }))).toEqual(['riddle']);
    expect(partsOf(facts({ riddleSealed: false, read: true }))).toEqual(['question']);
    expect(partsOf(facts({ entry: 'cleared', hasQuestion: false, riddleSealed: false }))).toEqual([]);
  });

  // spec: add-daily-ritual › Ritual day rule › питомец устал × completes at once
  it('ends at once for a tired pet whose entry and riddle are done', () => {
    expect(isComplete(facts({ tired: true, read: true, riddleAnswered: true }))).toBe(true);
    expect(isComplete(facts({ tired: true, read: true }))).toBe(false);
  });

  // spec: add-daily-ritual › Daily ritual flow › ритуал завершён × the rule of the parts
  it('is not ended while the entry is being written, a riddle answered meanwhile included', () => {
    const writing = facts({ entry: 'writing', hasQuestion: false, riddleAnswered: true });
    expect(isComplete(writing)).toBe(false);
    // the window passed with no entry: the riddle ends it
    expect(isComplete({ ...writing, entry: 'failed' })).toBe(true);
  });

  // spec: add-daily-ritual › Daily ritual flow › ритуал завершён × the rule of the parts
  it('ends when the riddle alone is the part available today, and not on a day with nothing available', () => {
    expect(isComplete(facts({ entry: 'asleep', hasQuestion: false, riddleAnswered: true }))).toBe(true);
    // nothing available and nothing done: the opening alone completes nothing for an awake pet
    expect(isComplete(facts({ entry: 'failed', hasQuestion: false, riddleSealed: false, opened: true }))).toBe(false);
  });

  // spec: add-daily-ritual › Daily ritual flow › уснул в нетронутый день
  it('does not end for a pet asleep with no part done and the Diary not opened, and ends once it was opened', () => {
    expect(isComplete(facts({ asleep: true, entry: 'asleep', hasQuestion: false, opened: false }))).toBe(false);
    expect(isComplete(facts({ asleep: true, entry: 'asleep', hasQuestion: false, opened: true }))).toBe(true);
  });

  // spec: add-daily-ritual › Daily ritual flow › уснул в нетронутый день
  it('ends for a pet asleep when a part is done and only what a sleeping pet cannot do is left', () => {
    expect(isComplete(facts({ asleep: true, read: true, opened: false }))).toBe(true);
    // the entry that appeared on the open screen still has to be shown
    expect(isComplete(facts({ asleep: true, opened: true }))).toBe(false);
    expect(partsOf(facts({ asleep: true, opened: true }))).toEqual(['diary']);
  });

  // spec: add-daily-ritual › Daily ritual flow › part still to do × an answer on its way
  it('names the question and the riddle as what is left, and drops a question whose answer is on its way', () => {
    expect(doableParts(facts())).toEqual(['question', 'riddle']);
    expect(doableParts(facts({ read: true }))).toEqual(['question', 'riddle']);
    expect(doableParts(facts({ read: true, riddleAnswered: true }))).toEqual(['question']);
    // the answer is on its way: not a part done (partsOf), and not one to ask for
    const onItsWay = facts({ read: true, questionOnItsWay: true });
    expect(partsOf(onItsWay)).toEqual(['question', 'riddle']);
    expect(doableParts(onItsWay)).toEqual(['riddle']);
    expect(doableParts({ ...onItsWay, riddleAnswered: true })).toEqual([]);
    // empty once complete
    expect(doableParts(facts({ read: true, questionAnswered: true, riddleAnswered: true }))).toEqual([]);
  });
});

describe('the streak arithmetic', () => {
  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × the same rule as the contract
  it.each(cases.cases)('gives what the contract gives: $name', (c) => {
    expect(applyMark({ streak: c.streak, freezes: c.freezes, last: c.last }, c.day, c.skipped)).toEqual({
      streak: c.streak_after,
      freezes: c.freezes_after,
      spent: c.spent,
    });
  });
});

describe('the forecast', () => {
  const base = (patch: Partial<ForecastInput> = {}): ForecastInput => ({
    streak: 5,
    freezes: 1,
    last: 100,
    today: 102,
    covered: new Set(),
    // yesterday is closed unless a test says otherwise
    closedDay: (patch.today ?? 102) - 1,
    gifted: false,
    ...patch,
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × the forecast
  it('keeps the streak and spends the freezes when they cover the days missed', () => {
    expect(forecastOf(base())).toEqual({ days: 5, freezes: 0, line: 'frozen', n: 5, k: 0, missed: 1 });
    expect(forecastOf(base({ freezes: 3 }))).toEqual({ days: 5, freezes: 2, line: 'frozen', n: 5, k: 2, missed: 1 });
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × the forecast
  it('counts excused days and completed days waiting for their mark as not missed', () => {
    expect(forecastOf(base({ today: 104, freezes: 1, covered: new Set([101]) }))).toEqual({ days: 0, freezes: 0, line: 'fresh', n: 5, k: 0, missed: 2 });
    expect(forecastOf(base({ today: 104, covered: new Set([101, 102]) }))).toEqual({ days: 5, freezes: 0, line: 'frozen', n: 5, k: 0, missed: 1 });
    expect(forecastOf(base({ today: 104, covered: new Set([101, 102, 103]) }))).toBeNull();
  });

  // spec: add-daily-ritual › Streak rule › серия началась заново × the forecast
  it('starts a fresh streak when more days were missed than there are freezes, and says how long the last one ran', () => {
    expect(forecastOf(base({ today: 104 }))).toEqual({ days: 0, freezes: 0, line: 'fresh', n: 5, k: 0, missed: 3 });
    expect(forecastOf(base({ freezes: 0 }))).toEqual({ days: 0, freezes: 0, line: 'fresh', n: 5, k: 0, missed: 1 });
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × the forecast
  it('is none when nothing was missed, and before the first mark', () => {
    expect(forecastOf(base({ today: 101 }))).toBeNull();
    expect(forecastOf(base({ today: 100 }))).toBeNull();
    // days from birth to the first mark are not misses
    expect(forecastOf(base({ last: null, today: 130 }))).toBeNull();
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × yesterday not closed yet
  it('is none until yesterday is closed, so a freeze does not flash and vanish at 00:00', () => {
    expect(forecastOf(base({ closedDay: 100 }))).toBeNull();
    expect(forecastOf(base({ closedDay: 101 }))).not.toBeNull();
    expect(forecastOf(base({ closedDay: 105 }))).not.toBeNull();
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × a gifted pet, no line
  it('keeps the number and its note for a gifted pet and loses the line', () => {
    expect(forecastOf(base({ gifted: true }))).toEqual({ days: 5, freezes: 0, line: null, n: 5, k: 0, missed: 1 });
  });

  // spec: add-daily-ritual › Streak rule › серия началась заново × a gifted pet, no line
  it('keeps the fresh number for a gifted pet and loses the line', () => {
    expect(forecastOf(base({ gifted: true, today: 104 }))).toEqual({ days: 0, freezes: 0, line: null, n: 5, k: 0, missed: 3 });
  });
});
