import { describe, expect, it } from 'vitest';
import { streakCells } from './streakCells';

describe('the cells of the Streak strip in the forecast', () => {
  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × the strip's cells
  it('draws the covered day dashed beside today, the streak lit before it, as the frame does', () => {
    expect(streakCells(2, 1)).toEqual(['none', 'none', 'none', 'lit', 'lit', 'frozen', 'today']);
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × the strip's cells
  it('draws one dashed cell for each covered day, and lights fewer days when they do not fit', () => {
    expect(streakCells(10, 2)).toEqual(['lit', 'lit', 'lit', 'lit', 'frozen', 'frozen', 'today']);
    expect(streakCells(1, 3)).toEqual(['none', 'none', 'lit', 'frozen', 'frozen', 'frozen', 'today']);
    expect(streakCells(9, 9)).toEqual(['frozen', 'frozen', 'frozen', 'frozen', 'frozen', 'frozen', 'today']);
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × the strip's cells
  it('counts today when the ritual is done', () => {
    expect(streakCells(2, 1, true)).toEqual(['none', 'none', 'none', 'lit', 'lit', 'frozen', 'lit']);
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × the strip's cells
  it('leaves the strip to the DS\'s own rule when no day was missed: nothing dashed is drawn once the mark lands', () => {
    expect(streakCells(2, 0)).toBeUndefined();
  });
});
