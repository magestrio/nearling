import { describe, expect, it } from 'vitest';
import { fitName } from './name';

const bytes = (s: string) => new TextEncoder().encode(s).length;
const astronaut = '👩‍🚀'; // woman + joiner + rocket: 11 bytes, one grapheme

describe('the name field', () => {
  // spec: add-pet › Hatch screen › empty × 33-й байт имени
  it('does not take the 33rd byte', () => {
    const full = 'a'.repeat(32);
    expect(fitName(full, `${full}b`)).toBe(full);
    expect(fitName('a'.repeat(31), `${'a'.repeat(31)}b`)).toBe(`${'a'.repeat(31)}b`);
  });

  // spec: add-pet › Hatch screen › empty × 33-й байт имени
  it('never cuts an emoji or an accent in the middle', () => {
    const base = 'a'.repeat(30); // two bytes left: neither a 4-byte emoji nor a 3-byte accent fits
    expect(fitName(base, `${base}🚀`)).toBe(base);
    expect(fitName(base, `${base}é`)).toBe(base);
    // a letter that gets its accent when the accented form no longer fits keeps the plain letter
    const edge = `${'a'.repeat(30)}e`; // 31 bytes
    expect(bytes(`${'a'.repeat(30)}e\u0301`)).toBe(33);
    expect(fitName(edge, `${'a'.repeat(30)}e\u0301`)).toBe(edge);
  });

  // spec: add-pet › Hatch screen › empty × вставка длиннее 32 байт
  it('takes two of three pasted astronauts (33 bytes), not two and a half', () => {
    const pasted = astronaut.repeat(3);
    expect(bytes(pasted)).toBe(33);
    const got = fitName('', pasted);
    expect(got).toBe(astronaut.repeat(2));
    expect(bytes(got)).toBe(22);
  });

  // spec: add-pet › Hatch screen › empty × вставка длиннее 32 байт
  it('keeps an accent given as a base letter and a combining mark when the paste fits', () => {
    const accented = 'Crème'; // e + U+0300
    expect(fitName('', accented)).toBe(accented);
    expect(fitName('', 'x'.repeat(40))).toBe('x'.repeat(32));
  });

  // spec: add-pet › Hatch screen › empty × вставка длиннее 32 байт
  it('keeps the text around a paste that goes in the middle', () => {
    expect(fitName('abcd', `ab${'z'.repeat(40)}cd`)).toBe(`ab${'z'.repeat(28)}cd`);
  });

  // spec: add-pet › Hatch screen › empty × 33-й байт имени
  it('lets the player delete and edit freely when the field is full', () => {
    const full = 'a'.repeat(32);
    expect(fitName(full, full.slice(0, 10))).toBe(full.slice(0, 10));
    expect(fitName(full, `${'a'.repeat(15)}b${'a'.repeat(16)}`)).toBe(`${'a'.repeat(15)}b${'a'.repeat(16)}`);
  });
});
