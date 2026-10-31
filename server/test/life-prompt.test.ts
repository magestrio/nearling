import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../src/spend';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const DAY_MS = 86_400_000;
const ONE_NEAR = (10n ** 24n).toString();
const STARTER = BigInt(env.STARTER_FOOD);

const addPet = (patch: Record<string, unknown> = {}) => h.net().contract.addPet('5', OWNER, { given_food: ONE_NEAR, ...patch });
const say = async (mode: 'chat' | 'deep' = 'chat', text = 'Tell me something') => {
  const out = await run(env, '5', { kind: 'reply', mode, text });
  expect('thoughtId' in out).toBe(true);
  return h.net().ai.calls.at(-1)!.body.messages;
};
/** The system layer of the thought just sent, line by line. */
const system = (messages: { role: string; content: string }[]) => messages[0]!.content.split('\n');

const STAGE = {
  baby: 'Your stage of growth: baby. You speak simply, with wonder, like someone new to the world.',
  teen: "Your stage of growth: teen. You speak with a teen's energy and strong opinions.",
  adult: 'Your stage of growth: grown-up. You speak with calm confidence.',
};
const CLEVER = 'You love puzzles and spot the clever angle.';
const SOCIABLE = 'You love company and ask after friends.';

describe('Growth flow', () => {
  // spec: add-pet-life › Growth flow › стал взрослым × the next thought
  it('speaks as an adult with both traits once the chain holds the stage, in the order of the layers', async () => {
    addPet({ stage: 'Adult', traits: ['clever', 'sociable'] });
    const lines = system(await say());
    const at = (text: string) => lines.indexOf(text);
    expect(at(STAGE.adult)).toBeGreaterThan(at(lines.find((l) => l.startsWith('Your character'))!));
    // character, stage, traits, mood, energy, then the length
    expect([at(STAGE.adult), at(CLEVER), at(SOCIABLE), at('Your mood today: calm. Sound settled and easy.'), at('Your energy today: 100%.')]).toEqual([2, 3, 4, 5, 6]);
    expect(lines[7]).toBe('Answer in 1-3 sentences unless the player asks for code or a story.');
  });

  // spec: add-pet-life › Growth flow › стал взрослым × the next thought
  it('changes no layer for a transition that is counted and not written: the chain\'s stage and traits are the layers', async () => {
    addPet();
    await env.DB.prepare("INSERT INTO pending_growth (token_id, stage, trait, created_at) VALUES ('5', 'teen', 'sociable', ?)").bind(Date.now()).run();
    const lines = system(await say());
    expect(lines).toContain(STAGE.baby);
    expect(lines).not.toContain(STAGE.teen);
    expect(lines).not.toContain(SOCIABLE);
  });

  // spec: add-pet-life › Growth flow › стал подростком
  it('speaks as a teen with the new trait', async () => {
    addPet({ stage: 'Teen', traits: ['sociable'] });
    const lines = system(await say());
    expect(lines).toContain(STAGE.teen);
    expect(lines).toContain(SOCIABLE);
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа
  it('leaves the line of a transition out of the history and out of the "since you last spoke" mark', async () => {
    addPet();
    const before = Date.now();
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES ('x', '5', ?, 'reply', 'Hi', 'Hello there', 'm', '0', 0, 'pet', 'billed')").bind(before).run();
    await env.DB.prepare("INSERT INTO memory_notes (token_id, kind, name, at) VALUES ('5', 'fed_by', 'Maya', ?)").bind(before + 1).run();
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES ('g', '5', ?, 'growth', 'Pixel is a teen now — and turned out cozy!', '', '0', 0, 'project', 'project')").bind(before + 2).run();
    const messages = await say();
    expect(messages.map((m) => m.content).join('\n')).not.toContain('is a teen now');
    // the line is not something the pet said: Maya's meal is still news to it
    expect(messages[0]!.content).toContain('"Maya" fed you since you last spoke. Thank them by name in your reply.');
  });
});

describe('Trait rule', () => {
  // spec: add-pet-life › Trait rule › черта уже есть × the next thought
  it('says "Very strongly:" before a trait the chain holds twice, and only that trait', async () => {
    addPet({ stage: 'Adult', traits: ['clever', 'clever'] });
    const lines = system(await say());
    expect(lines).toContain(`Very strongly: ${CLEVER}`);
    expect(lines).not.toContain(CLEVER);

    h.net().contract.pets.get('5')!.traits = ['clever', 'sociable'];
    const two = system(await say());
    expect(two).toContain(CLEVER);
    expect(two).toContain(SOCIABLE);
    expect(two.some((l) => l.startsWith('Very strongly'))).toBe(false);
  });
});

describe('Mood rule', () => {
  // spec: add-pet-life › Mood rule › радостный × the next thought
  it('answers calm on a day with no event and warm after the pet answered, calm again the next day', async () => {
    addPet();
    expect(system(await say())).toContain('Your mood today: calm. Sound settled and easy.');
    expect(system(await say())).toContain('Your mood today: happy. Sound warm and lively.');
    vi.setSystemTime(Date.now() + DAY_MS);
    expect(system(await say())).toContain('Your mood today: calm. Sound settled and easy.');
  });

  // spec: add-pet-life › Mood rule › сонный × the next thought
  it('answers sleepy when hungry, over the events of the day, and never in blame', async () => {
    addPet({ project_food: (STARTER / 2n).toString(), given_food: '0' });
    await env.DB.prepare('INSERT INTO pet_life (token_id, mood_day) VALUES (?, ?)').bind('5', Math.floor(Date.now() / DAY_MS)).run();
    const lines = system(await say());
    expect(lines).toContain('Your mood today: sleepy. Sound soft and drowsy, never sad, and never blame anyone.');
    expect(lines.some((l) => l.includes('happy'))).toBe(false);
  });

  // spec: add-pet-life › Mood rule › после отсутствия
  it('answers calm to a fed pet that comes back after days of silence: the absence lowers nothing', async () => {
    addPet();
    await say();
    vi.setSystemTime(Date.now() + 9 * DAY_MS);
    const lines = system(await say());
    expect(lines).toContain('Your mood today: calm. Sound settled and easy.');
    expect(lines.join(' ')).not.toMatch(/sad|lonely|missed/i);
  });
});

describe('Energy rule', () => {
  // spec: add-pet-life › Energy rule › энергия на нуле × the last step
  it('tells the model the percent of energy left, a step of ten each deep thought', async () => {
    addPet();
    expect(system(await say())).toContain('Your energy today: 100%.');
    expect(system(await say('deep'))).toContain('Your energy today: 100%.');
    expect(system(await say())).toContain('Your energy today: 90%.');
  });
});
