import { describe, expect, it } from 'vitest';
import { sampleDiary } from '../seams/diary.sample';
import type { DiaryView } from '../seams/worker-types';
import { endNote, entryDraw, nextSaid, partLines, riddleDraw, streakDraw } from './diaryView';

const diary = (patch: Partial<DiaryView> = {}): DiaryView => ({ ...sampleDiary(), ...patch });

describe('what the Diary draws', () => {
  // spec: add-daily-ritual › Streak rule › серия записана позже
  it('keeps the recorded number and strip while the day saves: today is outlined, not counted', () => {
    const saving = streakDraw(diary({ streak: { days: 2, freezes: 1, done: true, line: null, n: 2, k: 1, missed: 0, note: ['saving'] } }));
    expect(saving).toMatchObject({ days: 2, done: false, note: 'Saving your streak…', unit: 'days' });
    const lost = streakDraw(diary({ streak: { days: 2, freezes: 1, done: true, line: null, n: 2, k: 1, missed: 0, note: ['lost'] } }));
    expect(lost.done).toBe(false);
    // the mark landed: the new number counts today
    const marked = streakDraw(diary({ streak: { days: 3, freezes: 1, done: true, line: null, n: 3, k: 1, missed: 0, note: [] } }));
    expect(marked).toMatchObject({ days: 3, done: true, note: undefined });
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию
  it('says the freeze line, the forecast note and the dashed day of a forecast, in the spec\'s words', () => {
    const draw = streakDraw(diary({ streak: { days: 2, freezes: 0, done: false, line: 'frozen', n: 2, k: 0, missed: 1, note: ['forecast'] } }));
    expect(draw.line).toBe('A streak freeze kept your 2-day streak safe. Freezes left: 0.');
    expect(draw.note).toBe("Saved once today's ritual is done.");
    expect(draw.cells).toEqual(['none', 'none', 'none', 'lit', 'lit', 'frozen', 'today']);
  });

  // spec: add-daily-ritual › Streak rule › серия началась заново
  it('says a fresh start with no reproach: the last streak\'s length, today alone in the strip', () => {
    const draw = streakDraw(diary({ streak: { days: 0, freezes: 0, done: false, line: 'fresh', n: 2, k: 0, missed: 3, note: ['forecast'] } }));
    expect(draw.line).toBe('A fresh streak starts today! Your last one ran 2 days.');
    expect(draw.cells).toBeUndefined();
    expect(draw.days).toBe(0);
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × a gifted pet, no line
  it('draws the forecast number and its note for a gifted pet, with no line about the miss', () => {
    const draw = streakDraw(diary({ streak: { days: 2, freezes: 0, done: false, line: null, n: 2, k: 0, missed: 1, note: ['forecast'] } }));
    expect(draw.line).toBeUndefined();
    expect(draw.note).toBe("Saved once today's ritual is done.");
  });

  // spec: add-daily-ritual › Diary screen › empty
  it('puts the game\'s own line in place of an entry that is not there, with the time of the next one', () => {
    const at = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date('2026-11-01T00:00:00.000Z'));
    expect(entryDraw({ kind: 'first' }, 'Pixel', '2026-11-01T00:00:00.000Z')).toEqual({
      kind: 'line',
      text: `Pixel writes its first diary entry at ${at}. Come back after that to read it!`,
    });
    expect(entryDraw({ kind: 'cleared' }, 'Pixel', '2026-11-01T00:00:00.000Z')).toEqual({
      kind: 'line',
      text: `You cleared Pixel's memory, so its latest diary entry is gone. Pixel writes a fresh one at ${at}.`,
    });
  });

  // spec: add-daily-ritual › Daily ritual flow › день без дневника
  it('says the three reasons there is no entry in the spec\'s words', () => {
    expect(entryDraw({ kind: 'asleep' }, 'Pixel', '')).toEqual({ kind: 'line', text: "Pixel was asleep at diary time, so there's no diary today." });
    expect(entryDraw({ kind: 'writing' }, 'Pixel', '')).toEqual({ kind: 'line', text: 'Pixel is writing its diary…' });
    expect(entryDraw({ kind: 'failed' }, 'Pixel', '')).toEqual({
      kind: 'line',
      text: "Pixel couldn't write its diary this time — the problem was on our side. There's no diary or question today.",
    });
  });

  // spec: add-daily-ritual › Diary screen › success
  it('keeps the entry\'s lines and its question apart, and the work line when there is one', () => {
    const entry = entryDraw({ kind: 'text', id: 'd', lines: ['a', 'b'], question: 'Why?', work: null }, 'Pixel', '');
    expect(entry).toEqual({ kind: 'text', lines: ['a', 'b'], question: 'Why?', work: null });
  });

  // spec: add-daily-ritual › Riddle rule › загадка ещё не запечатана
  it('holds the riddle\'s place with a line when it is not sealed, and has no block for a riddle that never opened', () => {
    const held = riddleDraw(diary({ riddle: { kind: 'held' }, yesterday: null }));
    expect(held).toEqual({ yesterday: null, today: { kind: 'held' } });
  });

  // spec: add-daily-ritual › Riddle rule › ответ принят
  it('puts the answer in place of the field, and «Answered today» when the memory took the words', () => {
    const answered = riddleDraw(diary({ riddle: { kind: 'answered', day: 1, text: 'R', answer: 'a clock' } }));
    expect(answered.today).toMatchObject({ kind: 'answered', answer: 'a clock' });
    expect((answered.today as { line: string }).line).toMatch(/^Answer in! Find out if you got it after \d\d:\d\d\.$/);
    const cleared = riddleDraw(diary({ riddle: { kind: 'answered', day: 1, text: 'R', answer: null } }));
    expect(cleared.today).toMatchObject({ kind: 'answered', answer: null, line: 'Answered today' });
  });

  // spec: add-daily-ritual › Daily ritual flow › part still to do
  it('ends the column with what the streak still needs, or «All done for today!», or nothing', () => {
    expect(endNote(diary({ parts: ['question', 'riddle'], complete: false }))).toEqual({ kind: 'needs', text: "Today's streak still needs the question and the riddle." });
    expect(endNote(diary({ parts: [], complete: true }))).toEqual({ kind: 'done', text: 'All done for today!' });
    expect(endNote(diary({ parts: [], complete: false }))).toBeNull();
  });
});

describe('what the page\'s live region says', () => {
  const parts = (patch: Partial<DiaryView>, reply: string | null = null) => {
    const d = diary(patch);
    return partLines(streakDraw(d), entryDraw(d.entry, 'Pixel', d.until), riddleDraw(d), reply, endNote(d)?.text ?? null);
  };

  // spec: add-daily-ritual › Diary screen › success × what changes is said
  it('reads every part in the column\'s order, the reply with its speaker', () => {
    const lines = parts({ exchange: null, complete: true }, 'Pixel: A standing ovation.');
    expect(lines[0]).toBe('Streak: 2 days · Freezes: 1');
    expect(lines.indexOf('Pixel: A standing ovation.')).toBeGreaterThan(lines.indexOf("What has hands but can't clap?"));
    expect(lines.at(-1)).toBe('All done for today!');
  });

  // spec: add-daily-ritual › Diary screen › success × what changes is said
  it('says nothing of the diary that has just opened, only of the page\'s state', () => {
    const opened = parts({});
    expect(nextSaid(['Opening…'], { states: ['Opening…'], parts: null }, { states: [], parts: opened })).toEqual([]);
    expect(nextSaid([], { states: ['Opening…'], parts: null }, { states: ['Paused.'], parts: opened })).toEqual(['Paused.']);
  });

  // spec: add-daily-ritual › Diary screen › success × what changes is said
  it('says the lines that came and not the ones that stood, parts before states', () => {
    const was = { states: [], parts: parts({ entry: { kind: 'writing' }, yesterday: { kind: 'waiting' } }) };
    const now = { states: ['Pixel fell asleep.'], parts: parts({ entry: { kind: 'writing' }, yesterday: { kind: 'solved', answer: 'a piano' } }) };
    const said = nextSaid([], was, now);
    expect(said).toHaveLength(2);
    expect(said[0]).toMatch(/^You solved the riddle/);
    expect(said[1]).toBe('Pixel fell asleep.');
  });

  // spec: add-daily-ritual › Diary screen › success × what changes is said
  it('keeps a line while it is true, and empties it when it goes, so it is said again when it comes back', () => {
    const lines = parts({});
    const banner = { states: ['Offline.'], parts: lines };
    const clear = { states: [], parts: lines };
    expect(nextSaid([], clear, banner)).toEqual(['Offline.']);
    expect(nextSaid(['Offline.'], banner, banner)).toEqual(['Offline.']);
    expect(nextSaid(['Offline.'], banner, clear)).toEqual([]);
    expect(nextSaid([], clear, banner)).toEqual(['Offline.']);
  });
});
