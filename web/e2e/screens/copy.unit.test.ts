import { describe, expect, it } from 'vitest';
import { copyPattern, viewportsOf } from './copy';

describe('copyPattern', () => {
  it('matches a plain line', () => {
    expect(copyPattern('Pause motion').test('Pause motion')).toBe(true);
    expect(copyPattern('Pause motion').test('Play motion')).toBe(false);
  });

  it('lets a {name} placeholder stand for any text and escapes the rest', () => {
    const pattern = copyPattern('Think hard · {price}');
    expect(pattern.test('Think hard · 0.01 NEAR')).toBe(true);
    expect(pattern.test('Think harder · 0.01 NEAR')).toBe(false);
    expect(copyPattern('Say hi to {name}…').test('Say hi to Pip…')).toBe(true);
    expect(copyPattern('1+1 (two)').test('1+1 (two)')).toBe(true);
  });
});

describe('viewportsOf', () => {
  it('keeps both viewports unless the frame limits them', () => {
    expect(viewportsOf({ id: 'a', req: 'c › R', state: 's' })).toEqual(['desktop', 'phone']);
    expect(viewportsOf({ id: 'a', req: 'c › R', state: 's', viewports: ['phone'] })).toEqual(['phone']);
  });
});
