import { describe, expect, it } from 'vitest';
import { cleanName, hasVisible } from './nameClean';

describe('the browser cleans the name as the server does', () => {
  // spec: add-pet › Public pet data › имя с составным эмодзи × чистка в браузере
  it('keeps the joiner and the variation selectors inside an emoji', () => {
    expect(cleanName('👩‍🚀 Nova')).toBe('👩‍🚀 Nova');
    expect(cleanName('👩‍🚀 Nova')).toContain('‍');
    expect(cleanName('🏳️‍🌈')).toBe('🏳️‍🌈');
    expect(cleanName('🏳️‍🌈')).toContain('️');
    expect(cleanName('🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}')).toContain('\u{E0067}');
  });

  // spec: add-pet › Public pet data › имя с составным эмодзи × чистка в браузере
  it('cuts the invisible characters between letters and the blanks at the edges', () => {
    expect(cleanName('Pi​xel')).toBe('Pixel');
    expect(cleanName('P‮ixel­')).toBe('Pixel');
    expect(cleanName(' ​ Pixel ')).toBe('Pixel');
  });

  // spec: add-pet › Hatch screen › уведомление о публичности × в поле одни пробелы или невидимые
  it('leaves nothing visible of spaces and invisibles alone', () => {
    expect(hasVisible(cleanName('   '))).toBe(false);
    expect(hasVisible(cleanName('​‍⁠'))).toBe(false);
    expect(cleanName('   ')).toBe('');
    expect(hasVisible('Pixel')).toBe(true);
  });
});
