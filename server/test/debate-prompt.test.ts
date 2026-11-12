import { describe, expect, it } from 'vitest';
import { DEBATE_OPINION_LINE, debateLineText, debateMessages } from '../src/debates/prompt';
import type { PetRecord } from '../src/chain';

const pet = { name: 'Pixel', character: 'I notice small things.', stage: 'Teen', traits: ['thoughtful'],
  owner_id: 'private-owner-account', token_id: '81', memory: 'private memory', skill: 'private skill',
  experience_note: 'private experience', relationship: 'private relationship', player_name: 'private player' } as unknown as PetRecord;
const life = { mood: 'calm' as const, energyPercent: 70, outfit: null };

describe('public debate input', () => {
  // spec: add-debates › Debate AI request data › first line
  it('sends only public character and life layers with the topic on the first line', () => {
    const messages = debateMessages(pet, 'Where is home?', [], life);
    const text = JSON.stringify(messages);
    expect(text).toContain('I notice small things.');
    expect(text).toContain('Your stage of growth: teen.');
    expect(text).toContain('Where is home?');
    for (const privateValue of ['private-owner-account', 'private memory', 'private skill', 'private experience', 'private relationship', 'private player'])
      expect(text).not.toContain(privateValue);
    expect(messages).toHaveLength(2);
  });

  // spec: add-debates › Debate AI request data › later line
  it('keeps earlier public lines in order without reading private records', () => {
    const messages = debateMessages(pet, 'Where is home?', [
      { speaker: 'Nori', text: 'First public line.' }, { speaker: 'Pixel', text: 'Second public line.' },
    ], life);
    const text = messages[1]!.content;
    expect(text.indexOf('First public line.')).toBeLessThan(text.indexOf('Second public line.'));
    expect(text).toContain('Where is home?');
    expect(JSON.stringify(messages)).not.toContain('private memory');
  });
});

describe('taking a side', () => {
  // dev 2026-11-12: a pet refused a harmless topic because it was «not sure that's true»
  it('tells every line that a side is the pet\'s taste and uncertainty is no reason to refuse', () => {
    for (const earlier of [[], [{ speaker: 'Nori', text: 'Rain wins.' }]]) {
      expect(debateMessages(pet, 'Is rain better than sunshine?', earlier, life)[0]!.content).toContain(DEBATE_OPINION_LINE);
    }
  });
});

describe('a debate line as readers see it', () => {
  // the model marks a refusal with «REFUSE:» for us; a reader sees only the pet's words
  it('drops the refusal marker of a first or second line and keeps any other line as written', () => {
    expect(debateLineText("REFUSE: I'm too excited in my party hat to decide.", 1)).toBe("I'm too excited in my party hat to decide.");
    expect(debateLineText('  REFUSE:  Not today.', 2)).toBe('Not today.');
    expect(debateLineText('REFUSE: is a funny word.', 3)).toBe('REFUSE: is a funny word.');
    expect(debateLineText('Snacks win.', 1)).toBe('Snacks win.');
    expect(debateLineText(null, 1)).toBeNull();
  });
});
