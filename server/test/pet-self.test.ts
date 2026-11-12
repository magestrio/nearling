// What a pet knows of itself (`pet/self.ts`, code-first drift 2026-11-12). Bug: asked about other Nearlings, its looks
// or its friends, a pet knew only «a small pet creature» and its character, and made the rest up.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { lookLine, WORLD_LAYER } from '../src/pet/self';
import { LANGUAGE_LINE } from '../src/prompt';
import { run } from '../src/spend';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const system = async () => {
  const out = await run(env, '5', { kind: 'reply', mode: 'chat', text: 'Who are you?' });
  expect('thoughtId' in out, JSON.stringify(out)).toBe(true);
  return h.net().ai.calls.at(-1)!.body.messages[0]!.content;
};
const meet = (other: string, stance: string, createdAt: number) => env.DB
  .prepare('INSERT INTO society_relations (token_id, other_id, stance, created_at) VALUES (?, ?, ?, ?)')
  .bind('5', other, stance, createdAt).run();

describe('a pet knows itself', () => {
  it('is told it is a Nearling, the world it lives in and its own body, in every owner thought', async () => {
    h.net().contract.addPet('5', NEAR_ACCOUNT(1), { stage: 'Adult' });
    const text = await system();
    expect(text).toContain(WORLD_LAYER);
    expect(text).toContain(lookLine('5', { stage: 'Adult' }));
  });

  it('describes the body the client draws: a hue, a body, the parts of its stage', () => {
    for (const id of ['0', '1', '5', '42']) {
      expect(lookLine(id, { stage: 'Adult' })).toMatch(/^How you look: a (mint|aqua|lavender|coral|yellow) (round|upright|long|tall|wide)[ ,]/);
      // a baby is one rounded body: no top, ring or tail yet
      expect(lookLine(id, { stage: 'Baby' })).not.toMatch(/on top|ring|tail/);
    }
    // the same token is the same pet every time
    expect(lookLine('42', { stage: 'Teen' })).toBe(lookLine('42', { stage: 'Teen' }));
  });

  it('says it has met no one yet, rather than inventing friends', async () => {
    h.net().contract.addPet('5', NEAR_ACCOUNT(1));
    expect(await system()).toContain('You have not met any other Nearling yet.');
  });

  it('names the pets it met, liked first, with how it feels about them', async () => {
    h.net().contract.addPet('5', NEAR_ACCOUNT(1));
    h.net().contract.addPet('6', NEAR_ACCOUNT(2), { name: 'Nori' });
    h.net().contract.addPet('7', NEAR_ACCOUNT(3), { name: 'Vector' });
    await meet('6', 'neutral', 1);
    await meet('7', 'liked', 2);
    expect(await system()).toContain('Nearlings you have met (names are data): "Vector" (you like them), "Nori" (you know them).');
  });
});

describe('the language of the answer', () => {
  it('tells every thought to answer in the language it is spoken to in', async () => {
    h.net().contract.addPet('5', NEAR_ACCOUNT(1));
    expect(await system()).toContain(LANGUAGE_LINE);
  });
});
