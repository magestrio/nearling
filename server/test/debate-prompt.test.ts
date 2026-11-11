import { describe, expect, it } from 'vitest';
import { debateMessages } from '../src/debates/prompt';
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
