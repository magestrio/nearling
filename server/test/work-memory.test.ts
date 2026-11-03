// What the work puts into a pet's request and how long it makes a turn wait (`add-pet-work` › `Hire request data`,
// `Pet hire flow`; `add-pet` › `Memory rule`): the words of other pets share the memory budget with the owner's chat,
// a feeder is still thanked after a hire or an advice, and a throttled chain never holds a turn without a hire.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { bytesOf, buildMessages } from '../src/prompt';
import { findCandidates } from '../src/work/candidates';
import { harness, say, seedHistory } from './helpers/api';
import { addHirer, addPets, addWorker, advise, hirerNow, PAYER, payerToken, until, workerRecord } from './helpers/work';

const h = harness();
const MEMORY_BYTES = 2_300 * 4;
const ask = (n = 1, question = 'How do I grow radishes?') => ({ content: `ASK ${n}: ${question}` });
const sent = () => h.net().ai.calls.at(-1)!.body.messages as { role: string; content: string }[];
const note = (name: string, at: number) => env.DB.prepare("INSERT INTO memory_notes (token_id, kind, name, at) VALUES (?, 'fed_by', ?, ?)").bind(PAYER, name, at).run();
const THANKS = /"Maya" fed you since you last spoke\. Thank them by name/;

/** Advice the pet paid for, long ones, newest last (the budget cares for their bytes). */
async function seedAdvice(count: number, bytes: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await env.DB.prepare(
      "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status, worker_name, recall) VALUES (?, ?, ?, 'advice', ?, ?, 'm', '0', 0, 'pet', 'billed', 'Biscuit', 1)",
    )
      .bind(crypto.randomUUID(), PAYER, 5_000 + i, `advice question ${i}`, `advice ${i} ${'x'.repeat(bytes)}`)
      .run();
  }
}

describe('Hire request data', () => {
  // spec: add-pet-work › Hire request data › свой ответ после работника
  it('keeps the owner\'s chat in the request when five long advice answers are told: they give way, the budget holds', async () => {
    addPets(h);
    await seedHistory(PAYER, ['first reply', 'second reply', 'third reply']);
    await seedAdvice(5, 3_000);
    const tk = await payerToken();
    await say(tk, PAYER, 'Hello again');
    const messages = sent();
    // the pet still remembers its chat with the owner
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['question 0', 'question 1', 'question 2', 'Hello again']);
    // the newest advice stays, the oldest gave way, and the whole request is inside the budget
    const system = messages[0]!.content;
    expect(system).toContain('advice 4 ');
    expect(system).not.toContain('advice 0 ');
    expect(messages.reduce((sum, m) => sum + bytesOf(m.content), 0)).toBeLessThanOrEqual(MEMORY_BYTES);
  });

  // spec: add-pet-work › Hire request data › свой ответ после работника
  it('always keeps the words of the worker this turn\'s own reply is written from, however long, and drops the older advice', async () => {
    addPets(h);
    await seedAdvice(2, 500);
    const pet = await workerRecord(PAYER);
    const hired = { worker: 'Biscuit', question: 'How do I grow radishes?', answer: 'z'.repeat(MEMORY_BYTES), turnId: 't1' };
    const messages = await buildMessages(env.DB, PAYER, pet, { kind: 'reply', mode: 'chat', text: 'Hi' }, { mood: null, energyPercent: 100 }, { hired });
    const system = messages[0]!.content;
    expect(system).toContain(hired.answer);
    expect(system).not.toContain('advice 1 ');
  });
});

describe('Memory rule', () => {
  const OWNER_REPLY = 'Spring, says Worker6.';

  // spec: add-pet › Memory rule › помнит кормивших
  it('still thanks a feeder in the own reply of a hire turn: the question to the worker is not something the pet said to its owner', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    const tk = await payerToken();
    await note('Maya', Date.now());
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { content: OWNER_REPLY });
    await say(tk, PAYER, 'What should I plant?');
    const calls = h.net().ai.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]!.body.messages[0]!.content).toMatch(THANKS);
    expect(calls[2]!.body.messages[0]!.content).toMatch(THANKS);
    // said once: the next reply is not asked to thank again
    vi.setSystemTime(Date.now() + 1_000);
    await say(tk, PAYER, 'And now?');
    expect(sent()[0]!.content).not.toMatch(/fed you since/);
  });

  // spec: add-pet › Memory rule › помнит кормивших
  it('still thanks a feeder after the pet paid for an advice on a friend\'s page', async () => {
    addPets(h);
    const tk = await payerToken();
    await note('Maya', Date.now());
    vi.setSystemTime(Date.now() + 1_000);
    expect((await advise(tk)).thought.kind).toBe('advice');
    vi.setSystemTime(Date.now() + 1_000);
    await say(tk, PAYER, 'How are you?');
    expect(sent()[0]!.content).toMatch(THANKS);
  });
});

describe('Pet hire flow', () => {
  // spec: add-pet-work › Pet hire flow › спрашивает
  it('does not make a turn without a hire wait for a slow chain: past the deadline there are no candidates and the turn is the ordinary one', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    const hirer = await hirerNow();
    // the node answers the first pet read of the worker after the deadline of the turn
    let finished = false;
    h.net().contract.meanwhile.pet_view = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      finished = true;
    };
    expect(await findCandidates(env, hirer, 'auto', Date.now())).toEqual([]);
    expect(finished).toBe(false);
    expect(h.logs().join('\n')).toContain('candidates_late');
    // the reads left behind end before the test does
    await until(() => finished);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
