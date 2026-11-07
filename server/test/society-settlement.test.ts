import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { HIRE_FEE_MIN_YOCTO } from '../src/pricing';
import { settleSocietyPending } from '../src/society/settlement';
import { relation } from '../src/society/relations';
import { api, harness } from './helpers/api';
import { addPets, advise, PAYER, payerToken, WORKER } from './helpers/work';

const h = harness();
const rows = async (table: string) => (await env.DB.prepare(`SELECT * FROM ${table}`).all<any>()).results;

describe('society after chain settlement', () => {
  beforeEach(async () => {
    await env.EVENTS.prepare('DELETE FROM society_events').run();
    await env.EVENTS.prepare('DELETE FROM experience_events').run();
  });
  // spec: add-pet-society › Society formation flow › respectful work
  it('moves both sides and queues only settled encounter codes after the accepted hire', async () => {
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ content: 'Try spring. [[society:respectful]]' });
    await advise(tk);
    expect(await relation(env.DB, PAYER, WORKER)).toBeNull();
    await tick(env, Date.now() + 11 * 60_000);
    expect(h.net().ai.calls).toHaveLength(1);
    expect((await relation(env.DB, PAYER, WORKER))?.good_days).toBe(1);
    expect((await relation(env.DB, WORKER, PAYER))?.good_days).toBe(1);
    expect(await rows('society_encounters')).toHaveLength(2);
    expect(h.events().filter((e) => e.name === 'pet_relationship_changed')).toHaveLength(2);
    expect((await env.EVENTS.prepare("SELECT COUNT(*) AS n FROM society_events WHERE name = 'pet_relationship_changed'").first<{ n: number }>())?.n).toBe(2);
    await settleSocietyPending(env);
    expect(await rows('society_encounters')).toHaveLength(2);
    expect(h.events().filter((e) => e.name === 'pet_relationship_changed')).toHaveLength(2);
  });

  // spec: add-pet-society › Society formation flow › work not settled
  // spec: add-pet-society › Society formation flow › work not settled × debit/rejection/replay/Clear memory
  it('keeps no society memory after the worker cap rejects the fee and bills the answer by usage', async () => {
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ content: 'Try spring. [[society:rude]]' });
    await advise(tk);
    h.net().contract.pets.get(WORKER)!.jobs_today = 10;
    await tick(env, Date.now() + 11 * 60_000);
    expect(await relation(env.DB, WORKER, PAYER)).toBeNull();
    expect(await rows('society_encounters')).toEqual([]);
    expect(await rows('society_processed_hires')).toEqual([]);
    const state = await api(`/api/pets/${WORKER}/advice?payer=${PAYER}`, { token: tk });
    const cost = await env.DB.prepare("SELECT price_yocto FROM thoughts WHERE kind = 'advice'").first<{ price_yocto: string }>();
    expect(state.body.last).toMatchObject({ noHireFee: true, answerPrice: cost!.price_yocto });
    const conversation = await api(`/api/pets/${PAYER}/conversation`, { token: tk });
    expect(JSON.stringify(conversation.body)).toContain('answerPrice');
    expect(h.net().contract.debits.flatMap((debit) => debit.thoughts)).toEqual([
      expect.objectContaining({ price: cost!.price_yocto }),
    ]);
    expect(h.net().contract.debits.flatMap((debit) => debit.thoughts).some((thought) => thought.hire !== undefined)).toBe(false);
  });

  // spec: add-pet-society › Society hire price contract › post-answer hire rejection
  it('shows the exact answer cost when the price band rejects a completed answer', async () => {
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ content: 'Try spring. [[society:respectful]]' });
    await advise(tk);
    await env.DB.prepare("UPDATE hires SET fee_yocto = '1'").run();
    await tick(env, Date.now() + 11 * 60_000);
    const cost = await env.DB.prepare("SELECT price_yocto FROM thoughts WHERE kind = 'advice'").first<{ price_yocto: string }>();
    const state = await api(`/api/pets/${WORKER}/advice?payer=${PAYER}`, { token: tk });
    expect(state.body.last).toMatchObject({ noHireFee: true, answerPrice: cost!.price_yocto });
    const job = await env.DB.prepare("SELECT id FROM jobs WHERE kind = 'advice' ORDER BY created_at DESC LIMIT 1").first<{ id: string }>();
    const result = await api(`/api/pets/${PAYER}/state?job=${job!.id}`, { token: tk });
    expect(result.body.thought).toMatchObject({ noHireFee: true, answerPrice: cost!.price_yocto });
    expect(h.net().contract.debits.flatMap((debit) => debit.thoughts)).toEqual([
      expect.objectContaining({ price: cost!.price_yocto }),
    ]);
    expect(h.net().contract.debits.flatMap((debit) => debit.thoughts).some((thought) => thought.hire !== undefined)).toBe(false);
    expect(await rows('society_encounters')).toEqual([]);
    expect((await rows('hires'))[0].dropped_code).toBe('fee_band');
  });

  // spec: add-pet-society › Society formation flow › work not settled × debit/rejection/replay/Clear memory
  it('does not restore the cleared payer side when settlement is reconciled later', async () => {
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ content: 'Try spring. [[society:respectful]]' });
    await advise(tk);
    expect((await api(`/api/pets/${PAYER}/memory/clear`, { token: tk, method: 'POST' })).status).toBe(200);
    await tick(env, Date.now() + 11 * 60_000);
    expect(await relation(env.DB, PAYER, WORKER)).toBeNull();
    expect((await rows('society_encounters')).some((row) => row.token_id === PAYER)).toBe(false);
  });

  // spec: add-pet-society › Society formation flow › respectful work
  it('reconciles a recorded chain hire whose social write was delayed, once', async () => {
    addPets(h);
    const at = Date.now();
    const day = Math.floor(at / 86_400_000);
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, model, price_yocto, price_usd_micros, payer, status) VALUES ('late-answer', ?, ?, 'advice', 'model', '100', 1, 'pet', 'billed')")
      .bind(PAYER, at).run();
    await env.DB.prepare(`INSERT INTO hires (id, hirer_id, worker_id, worker_name, kind, fee_yocto,
      fee_usd_micros, answer_thought_id, status, created_at, society_reaction, record_day)
      VALUES ('late-hire', ?, ?, 'Biscuit', 'player', '1000', 10, 'late-answer', 'recorded', ?, 'respectful', ?)`)
      .bind(PAYER, WORKER, at, day).run();
    // The worker's Clear memory may have removed its D1 work record; the accepted hire row remains.
    expect(await rows('work_records')).toEqual([]);
    await settleSocietyPending(env);
    await settleSocietyPending(env);
    expect((await relation(env.DB, PAYER, WORKER))?.good_days).toBe(1);
    expect(await rows('society_encounters')).toHaveLength(2);
    expect(await rows('society_processed_hires')).toHaveLength(1);
  });

  // spec: add-pet-society › Society playtest data › hire paid
  it('marks the actual chain-accepted liked quote as discounted once', async () => {
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
    addPets(h);
    await env.DB.prepare("INSERT INTO society_relations (token_id, other_id, created_at, stance) VALUES (?, ?, ?, 'liked')")
      .bind(PAYER, WORKER, Date.now()).run();
    const tk = await payerToken();
    h.net().ai.push({ content: 'Try spring.' });
    await advise(tk);
    await tick(env, Date.now() + 11 * 60_000);
    const fee = h.net().contract.debits[0]!.thoughts[0]!.hire!.fee;
    expect(fee).toBe((HIRE_FEE_MIN_YOCTO * 9n / 10n).toString());
    expect(fee).toBe((await env.DB.prepare('SELECT fee_yocto FROM hires').first<{ fee_yocto: string }>())?.fee_yocto);
    expect(h.events().filter((e) => e.name === 'pet_hired')).toHaveLength(1);
    expect(h.events().find((e) => e.name === 'pet_hired')?.props.discounted).toBe(true);
    expect((await env.EVENTS.prepare("SELECT discounted FROM experience_events WHERE name = 'pet_hired'").first<{ discounted: number }>())?.discounted).toBe(1);
    await settleSocietyPending(env);
    expect((await env.EVENTS.prepare("SELECT COUNT(*) AS n FROM experience_events WHERE name = 'pet_hired'").first<{ n: number }>())?.n).toBe(1);
  });
});
