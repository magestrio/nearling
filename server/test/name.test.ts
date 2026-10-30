import { describe, expect, it } from 'vitest';
import { cleanName, hasVisible } from '../src/name/clean';
import { hasInsult } from '../src/name/insult';

// The tests' own list, never the user's secret.
const LIST = 'idiot\nfuck\nshit\n';
const refused = (name: string, list = LIST) => hasInsult(cleanName(name), list);

describe('the Unicode the name rules stand on, in the Workers runtime', () => {
  // spec: add-pet › Public pet data › имя с составным эмодзи
  it('has Intl.Segmenter graphemes and the \\p{…} properties the rules use', () => {
    const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment('👩‍🚀🏳️‍🌈é')].map((s) => s.segment);
    expect(graphemes).toEqual(['👩‍🚀', '🏳️‍🌈', 'é']);
    expect(/\p{Extended_Pictographic}/u.test('🚀')).toBe(true);
    expect(/\p{Regional_Indicator}/u.test('🇺')).toBe(true);
    expect(/\p{Bidi_Control}/u.test('‮')).toBe(true);
    expect(/\p{Default_Ignorable_Code_Point}/u.test('​')).toBe(true);
    expect(/\p{Default_Ignorable_Code_Point}/u.test('­')).toBe(true);
    expect(/^\p{Ll}$/u.test('a') && /^\p{Lu}$/u.test('A') && /^\p{Lt}$/u.test('ǅ')).toBe(true);
    expect(/^\p{L}$/u.test('é') && /^\p{M}$/u.test('́') && /^\p{Lo}$/u.test('日')).toBe(true);
    expect(/\p{White_Space}/u.test('　')).toBe(true);
  });
});

describe('cleanName', () => {
  // spec: add-pet › Public pet data › имя с составным эмодзи
  it('keeps the joiner and the variation selectors inside an emoji', () => {
    expect(cleanName('👩‍🚀 Nova')).toBe('👩‍🚀 Nova');
    expect(cleanName('🏳️‍🌈')).toBe('🏳️‍🌈');
    // the flag of Scotland: a black flag and tag letters
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    expect(cleanName(scotland)).toBe(scotland);
    expect(cleanName('1️⃣')).toBe('1️⃣');
  });

  // spec: add-pet › Public pet data › имя с составным эмодзи
  it('cuts the invisible characters between letters, and the edges', () => {
    expect(cleanName('Pi​xel')).toBe('Pixel');
    expect(cleanName('Pi‮xel')).toBe('Pixel');
    expect(cleanName('Pi️xel')).toBe('Pixel');
    expect(cleanName('Pi­xel')).toBe('Pixel');
    expect(cleanName('Pi‍xel')).toBe('Pixel'); // a joiner outside an emoji
    expect(cleanName(' ​ Pixel')).toBe('Pixel');
    expect(cleanName('  Pixel \t\n')).toBe('Pixel');
    expect(cleanName('Pi\u0007xel')).toBe('Pixel'); // a control
  });

  // spec: add-pet › Public pet data › имя с составным эмодзи
  it('leaves an accent and an inner space alone', () => {
    expect(cleanName('Créme Brûlée')).toBe('Créme Brûlée');
  });

  // spec: add-pet › Birth flow › имя не принято
  it('says a name of spaces and invisibles has nothing visible', () => {
    expect(hasVisible(cleanName('   '))).toBe(false);
    expect(hasVisible(cleanName('​‍﻿'))).toBe(false);
    expect(hasVisible(cleanName(' ​ '))).toBe(false);
    expect(hasVisible(cleanName('a'))).toBe(true);
    expect(hasVisible(cleanName('🚀'))).toBe(true);
  });
});

describe('the words of a name', () => {
  // spec: add-pet › Public pet data › слова имени
  it('refuses a whole list word cut out by a character that is not a letter, or by a lowercase before a capital', () => {
    for (const name of ['Big_Idiot', 'Fuck!', 'Fuck🔥', 'BigIdiot', 'big idiot', 'Idiot2', 'x-Idiot', 'IDIOT']) {
      expect(refused(name), name).toBe(true);
    }
  });

  // spec: add-pet › Public pet data › слова имени
  it('accepts a list word inside another word, and a letter with a diacritic does not split', () => {
    for (const name of ['Idiotic', 'Pixel', 'Fucking', 'Shitake', 'Créme', 'Créme', 'Crème']) {
      expect(refused(name, 'idiot\nfuck\nshit\ncre\nme\n'), name).toBe(false);
    }
    // the accent really joins: "e" + acute is not cut off as its own word
    expect(refused('Idéa', 'ide\nidea\n')).toBe(false);
  });

  // spec: add-pet › Public pet data › слова имени
  it('finds a word whose letters carry marks, whole', () => {
    expect(refused('Créme', 'créme\n')).toBe(true);
  });

  // spec: add-pet › Public pet data › слова имени
  it('is the same function for a feeder\'s name: one call, no branch of its own', () => {
    expect(hasInsult('Fuck', LIST)).toBe(hasInsult(cleanName('Fuck'), LIST));
    expect(hasInsult('Maya', LIST)).toBe(false);
  });

  // spec: add-pet › Public pet data › слова имени
  it('ignores empty lines and spaces around a list word, and a list that is empty', () => {
    expect(hasInsult('Idiot', '\n  idiot  \n\n')).toBe(true);
    expect(hasInsult('Idiot', '')).toBe(false);
    expect(hasInsult('Idiot', '\r\nidiot\r\n')).toBe(true);
  });

  // spec: add-pet › Public pet data › слова имени
  it('treats a list line with a non-letter as matching no word', () => {
    expect(hasInsult('big idiot', 'big idiot\n')).toBe(false);
    expect(hasInsult('2g1c', '2g1c\n')).toBe(false);
  });
});

describe('capitals before a lowercase letter', () => {
  // spec: add-pet › Public pet data › заглавные перед строчной
  it('checks both divisions: after the capitals and before the last of them', () => {
    expect(refused('SHITface')).toBe(true); // SHIT|face
    expect(refused('FUCKShit')).toBe(true); // FUCK|Shit
    expect(refused('BIGIdiot')).toBe(true); // BIG|Idiot
    // each of the three is refused on the word of its own side only
    expect(refused('SHITface', 'shit\n')).toBe(true);
    expect(refused('SHITface', 'face\n')).toBe(true);
    expect(refused('FUCKShit', 'fuck\n')).toBe(true);
    expect(refused('FUCKShit', 'shit\n')).toBe(true);
    expect(refused('BIGIdiot', 'idiot\n')).toBe(true);
    expect(refused('BIGIdiot', 'big\n')).toBe(true);
  });

  // spec: add-pet › Public pet data › заглавные перед строчной
  it('finds both words when two places stand in one chunk', () => {
    expect(refused('xBIGIdiotSHITface', 'idiot\n')).toBe(true);
    expect(refused('xBIGIdiotSHITface', 'shit\n')).toBe(true);
    // each place takes either option, independently of the other
    for (const word of ['aa', 'aaa', 'bb', 'abb', 'bbc', 'cc', 'ccc']) expect(refused('AAAbbBBCcc', `${word}\n`), word).toBe(true);
    expect(refused('AAAbbBBCcc', 'bbbb\n')).toBe(false);
  });

  // spec: add-pet › Public pet data › заглавные перед строчной
  it('refuses «PIXELs» with «pixel» in the list: the option after the capitals', () => {
    expect(refused('PIXELs', 'pixel\n')).toBe(true);
    expect(refused('PIXELs', 'pixels\n')).toBe(false); // the whole run is not one word
  });

  // spec: add-pet › Public pet data › заглавные перед строчной
  it('does not split a name by case when the letters have no case', () => {
    expect(refused('日本語', '日本\n')).toBe(false);
    expect(refused('日本語', '日本語\n')).toBe(true);
    expect(refused('日本語Idiot', 'idiot\n')).toBe(false); // 語 is not lowercase: no boundary before "I"
  });

  // spec: add-pet › Public pet data › заглавные перед строчной
  it('does not take a single capital before a lowercase letter for two options', () => {
    expect(refused('Idiot', 'idiot\n')).toBe(true);
    expect(refused('Idiot', 'idio\n')).toBe(false);
    expect(refused('Xidiot', 'idiot\n')).toBe(false);
  });
});
