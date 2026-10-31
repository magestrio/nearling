import { describe, expect, it } from 'vitest';
import { balance, dateAndTime, sentenceName, usd } from './format';

describe('the placeholders of Feed sheet', () => {
  // spec: add-feeding › Feed sheet screen › success (владелец)
  it('writes {usd} as the whole cents the server sent', () => {
    expect([5, 23, 92].map(usd)).toEqual(['5¢', '23¢', '92¢']);
  });

  // spec: add-feeding › Feed sheet screen › success (владелец)
  it('rounds {balance} down to two decimals', () => {
    expect(balance('310000000000000000000000')).toBe('0.31');
    expect(balance('319999999999999999999999')).toBe('0.31');
    expect(balance('80000000000000000000000')).toBe('0.08');
    expect(balance('1000000000000000000000000')).toBe('1.00');
    expect(balance('12345678900000000000000000')).toBe('12.34');
    expect(balance('10000000000000000000000')).toBe('0.01');
  });

  // spec: add-feeding › Feed sheet screen › success (владелец)
  it('writes {balance} under 0.01 to three decimals, and «0.000» under 0.001', () => {
    expect(balance('6000000000000000000000')).toBe('0.006');
    expect(balance('9999999999999999999999')).toBe('0.009');
    expect(balance('1000000000000000000000')).toBe('0.001');
    expect(balance('999999999999999999999')).toBe('0.000');
    expect(balance('1')).toBe('0.000');
    expect(balance('0')).toBe('0.00');
  });

  // spec: add-feeding › Snack rule › перекус владельцу ещё не готов
  it('writes {date} as the local date and time, «Nov 12 at 9:40 PM»', () => {
    expect(dateAndTime('2026-11-12T21:40:00Z', 'UTC')).toBe('Nov 12 at 9:40 PM');
    expect(dateAndTime('2026-11-12T21:40:00Z', 'Asia/Kolkata')).toBe('Nov 13 at 3:10 AM');
    expect(dateAndTime('2026-11-12T00:05:00Z', 'UTC')).toBe('Nov 12 at 12:05 AM');
    expect(dateAndTime('2026-11-12T12:00:00Z', 'UTC')).toBe('Nov 12 at 12:00 PM');
  });

  // spec: add-feeding › Own pet feeding flow › открыл кормление
  it('capitalises «your {my_pet}» at the start of a sentence only', () => {
    expect(sentenceName('your Pixel')).toBe('Your Pixel');
    expect(sentenceName('Pixel')).toBe('Pixel');
    expect(sentenceName('')).toBe('');
  });
});
