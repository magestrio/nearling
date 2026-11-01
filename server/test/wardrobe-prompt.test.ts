// The manner of the worn outfit (`add-wardrobe` › group 4.1): one line in the system message of the
// next thought, whichever kind of thought it is; the character, the model and the ceiling do not move.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { OUTFITS } from '../src/pet/outfits';
import { run } from '../src/spend';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const ONE_NEAR = (10n ** 24n).toString();

const addPet = (patch: Record<string, unknown> = {}) => h.net().contract.addPet('5', OWNER, { given_food: ONE_NEAR, ...patch });
const wear = (slug: string | null) => env.DB.prepare('INSERT OR REPLACE INTO wardrobe (token_id, worn, seen) VALUES (?, ?, 0)').bind('5', slug).run();
type Job = Parameters<typeof run>[2];
const think = async (job: Job = { kind: 'reply', mode: 'chat', text: 'Tell me something' }) => {
  const out = await run(env, '5', job);
  expect('thoughtId' in out, JSON.stringify(out)).toBe(true);
  return h.net().ai.calls.at(-1)!;
};
const system = (call: Awaited<ReturnType<typeof think>>) => call.body.messages[0]!.content.split('\n');
/** The system message without the face of the day: the first thought makes the day «happy» (`Mood rule`). */
const noMood = (lines: string[]) => lines.filter((l) => !l.startsWith('Your mood today:'));
const manner = (slug: string) => OUTFITS.find((o) => o.slug === slug)!.manner;
const LENGTH = 'Answer in 1-3 sentences unless the player asks for code or a story.';
const ALOUD = 'Answer at once, without thinking aloud.';

describe('Outfit rule', () => {
  // spec: add-wardrobe › Outfit rule › надел × the layer of a reply, a greeting, a wake and a diary
  it('adds the manner to every kind of thought, from the next one', async () => {
    addPet();
    expect(system(await think())).not.toContain(manner('bow-tie'));
    await wear('bow-tie');
    const diary = async () => {
      // the diary is taken in the first 30 minutes of the UTC day (`add-daily-ritual`)
      vi.setSystemTime(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 10 * 60_000);
      return think({ kind: 'diary', day: Math.floor(Date.now() / 86_400_000) - 1 });
    };
    for (const call of [
      await think(),
      await think({ kind: 'reply', mode: 'deep', text: 'Think hard about this' }),
      await think({ kind: 'greeting' }),
      await think({ kind: 'wake', cause: 'owner' }),
      await diary(),
    ]) {
      expect(system(call).filter((l) => l === manner('bow-tie'))).toHaveLength(1);
    }
  });

  // spec: add-wardrobe › Outfit rule › надел × the place of the layer
  it('puts the line after the traits and before the mood, the energy and the length', async () => {
    addPet({ stage: 'Teen', traits: ['clever'] });
    await wear('headphones');
    const lines = system(await think());
    const at = (text: string) => lines.indexOf(text);
    expect(at(manner('headphones'))).toBe(4);
    expect(lines[3]).toBe('You love puzzles and spot the clever angle.');
    expect(lines[5]).toMatch(/^Your mood today:/);
    expect(lines[6]).toMatch(/^Your energy today:/);
    expect(lines[7]).toBe(LENGTH);
  });

  // spec: add-wardrobe › Outfit rule › надел × the character, the model and the ceiling do not move
  it('leaves the character, the model, the thinking switch and the ceiling as they were', async () => {
    addPet();
    const plain = await think();
    await wear('smart-glasses');
    const dressed = await think();
    expect(dressed.body.model).toBe(plain.body.model);
    expect(dressed.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(dressed.body.max_tokens).toBe(plain.body.max_tokens);
    const character = (call: typeof plain) => system(call).find((l) => l.startsWith('You are Pixel') || l.startsWith('Your character'));
    expect(system(dressed).filter((l) => l.startsWith('Your character'))).toEqual(system(plain).filter((l) => l.startsWith('Your character')));
    expect(character(dressed)).toBe(character(plain));
    // the line is the only thing added to the system message
    expect(noMood(system(dressed)).filter((l) => !system(plain).includes(l))).toEqual([manner('smart-glasses')]);
    expect(noMood(system(plain)).filter((l) => !system(dressed).includes(l))).toEqual([]);
  });

  // spec: add-wardrobe › Outfit rule › снял × no layer
  it('adds no line after the item is taken off, and for a pet that never wore one', async () => {
    addPet();
    const plain = system(await think());
    await wear('party-hat');
    expect(system(await think())).toContain(manner('party-hat'));
    await wear(null);
    expect(noMood(system(await think()))).toEqual(noMood(plain));
    // an item the server does not know (a catalogue that lost one) is no layer either
    await wear('moon-boots');
    expect(noMood(system(await think()))).toEqual(noMood(plain));
  });
});

describe('Outfit catalogue rule', () => {
  // spec: add-wardrobe › Outfit catalogue rule › умные очки
  it('asks the glasses for more precise and thorough answers of the same length, in the same character', async () => {
    addPet();
    await wear('smart-glasses');
    const lines = system(await think());
    expect(manner('smart-glasses')).toMatch(/precise and thorough/);
    expect(manner('smart-glasses')).toMatch(/the same length as ever/);
    expect(manner('smart-glasses')).toMatch(/own character/);
    expect(lines).toContain(LENGTH);
    expect(lines).toContain(ALOUD);
  });

  // spec: add-wardrobe › Outfit catalogue rule › умные очки × each of the seven has a line
  it('has a line of its own for each of the seven items, and none is the same as another', async () => {
    expect(OUTFITS.map((o) => o.slug)).toEqual(['daisy-crown', 'cozy-scarf', 'thinking-cap', 'smart-glasses', 'bow-tie', 'headphones', 'party-hat']);
    expect(new Set(OUTFITS.map((o) => o.manner)).size).toBe(7);
    for (const o of OUTFITS) {
      addPet();
      await wear(o.slug);
      const lines = system(await think());
      expect(lines, o.slug).toContain(o.manner);
      expect(lines.filter((l) => OUTFITS.some((x) => x.manner === l)), o.slug).toEqual([o.manner]);
    }
  });

  // spec: add-wardrobe › Outfit catalogue rule › умные очки × the Thinking cap and the line about thinking aloud
  it('reads «Answer at once.» under the Thinking cap, so the two orders do not meet', async () => {
    addPet();
    await wear('thinking-cap');
    const lines = system(await think());
    expect(lines).toContain(manner('thinking-cap'));
    expect(lines).toContain('Answer at once.');
    expect(lines).not.toContain(ALOUD);
    expect(lines.join('\n')).not.toContain('without thinking aloud');
    // «Think hard» under the cap keeps its own line
    const deep = system(await think({ kind: 'reply', mode: 'deep', text: 'Think hard' }));
    expect(deep).toContain('Take your time and think carefully before you answer.');
  });

  // spec: add-wardrobe › Outfit catalogue rule › умные очки × not Think hard
  it('is not «Think hard»: the model is not asked to think, the ceiling is the chat one, nothing more is charged', async () => {
    addPet();
    await wear('thinking-cap');
    const call = await think();
    expect(call.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(call.body.max_tokens).toBeLessThanOrEqual(2_000);
    const row = await env.DB.prepare('SELECT kind FROM thoughts WHERE token_id = ?').bind('5').first<{ kind: string }>();
    expect(row?.kind).toBe('reply');
  });
});
