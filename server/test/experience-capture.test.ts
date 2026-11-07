import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { gasFor, MAX_LOG_BYTES_PER_DEBIT, receiptBytes } from '../src/debit';
import { captureWorkNote, stageNote } from '../src/experience/capture';
import { sha256Hex } from '../src/nearai';
import { forgetStatements } from '../src/pet/forget';
import { run } from '../src/spend';
import { api, harness } from './helpers/api';
import { callsOf, errand, owner, PET, richPet, thoughtsOf } from './helpers/errands';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const JOB = 'Read this short note about the Leonids.';
const TRAILER = '\nWORK_NOTE: The Leonids peak in November.\nWORK_FIELD: the Leonids meteor shower';
const later = () => Date.now() + 11 * 60_000;
const notes = () => env.DB.prepare('SELECT * FROM experience_notes ORDER BY created_at DESC, source_thought_id DESC').all<any>();

describe('Experience capture flow', () => {
  // spec: add-pet-experience › Experience capture flow › eligible report
  it('stages one note from the signed Read this completion and activates it only after accepted debit', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ content: `The Leonids peak in November.${TRAILER}`, tokensIn: 800, tokensOut: 80 });
    await errand(tk, 'read', JOB);
    expect(h.net().ai.calls).toHaveLength(1);
    const [thought] = await thoughtsOf();
    expect(thought.reply_text).toBe('The Leonids peak in November.');
    expect(thought.completed_errand).toBe(1);
    const [call] = await callsOf(thought.id);
    expect(new TextDecoder().decode(new Uint8Array(call.res_bytes))).toContain('WORK_NOTE: The Leonids peak in November.');
    expect(await sha256Hex(new Uint8Array(call.res_bytes))).toBe(call.res_sha256);
    expect((await notes()).results[0]).toMatchObject({ source_thought_id: thought.id, status: 'staged', approved_generation: null });
    await env.DB.batch(stageNote(env.DB, { thoughtId: thought.id, tokenId: PET, note: { text: 'A repeated write', field: 'a repeated job' }, at: Date.now(), epoch: 0, owner: h.net().contract.pets.get(PET)!.owner_id, generation: 0 }));
    expect((await notes()).results).toHaveLength(1);
    expect((await notes()).results[0].note_text).toBe('The Leonids peak in November.');
    await tick(env, later());
    expect((await notes()).results[0]).toMatchObject({ source_thought_id: thought.id, status: 'active' });
    expect(h.net().contract.debits[0]!.thoughts[0]!.completed_errand).toBe(true);
    expect(h.net().contract.experienceCounts.get(PET)?.completed_errands).toBe(1);
  });

  // spec: add-pet-experience › Experience capture flow › output budget leaves no note
  it('keeps the report but omits a partial or length-stopped note without another call', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ content: `A complete report.${TRAILER}`, finish: 'length' });
    await errand(tk, 'read', JOB);
    const [thought] = await thoughtsOf();
    expect(thought.reply_text).toBe('A complete report.');
    expect((await notes()).results).toEqual([]);
    expect(h.net().ai.calls).toHaveLength(1);
  });

  // spec: add-pet-experience › Experience capture flow › eligible report
  it('stages a note from a signed Find out report after stripping its private trailer', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push(
      { stream: { searches: 1 }, tokensIn: 13_000, tokensOut: 60 },
      { content: `The Leonids peak in November [1].${TRAILER}`, tokensIn: 900, tokensOut: 120 },
    );
    await errand(tk, 'find', 'When do the Leonids peak?');
    const [thought] = await thoughtsOf();
    expect(thought.reply_text).toBe('The Leonids peak in November.');
    expect((await notes()).results).toHaveLength(1);
    await tick(env, later());
    expect((await notes()).results[0].status).toBe('active');
  });

  // spec: add-pet-experience › Experience capture flow › eligible report
  it('stages a note from an Is it true? report without changing its verdict or source', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push(
      { stream: { searches: 1 }, tokensIn: 13_000, tokensOut: 60 },
      { content: `VERDICT: TRUE\nThe Leonids peak in November [1].${TRAILER}`, tokensIn: 900, tokensOut: 120 },
    );
    await errand(tk, 'check', 'The Leonids peak in November.');
    const [thought] = await thoughtsOf();
    expect(thought.reply_text).toBe('The Leonids peak in November.');
    expect(thought.verdict).toBe('true');
    expect(JSON.parse(thought.sources)).toHaveLength(1);
    expect((await notes()).results).toHaveLength(1);
  });

  // spec: add-pet-experience › Experience capture flow › no paid report
  it('does not mark a failed errand as completed paid work', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ status: 500 });
    await errand(tk, 'read', JOB);
    expect((await notes()).results).toEqual([]);
    await tick(env, later());
    expect(h.net().contract.debits.every((d) => d.thoughts.every((t) => !t.completed_errand))).toBe(true);
  });

  // spec: add-pet-experience › Experience capture flow › seventh note
  it('keeps the six newest paid notes and drops the oldest after settlement', async () => {
    richPet(h);
    const tk = await owner();
    for (let i = 0; i < 6; i += 1) {
      h.net().ai.push({ content: `Report ${i}.\nWORK_NOTE: Lesson ${i}.\nWORK_FIELD: job ${i}` });
      await errand(tk, 'read', JOB);
      vi.setSystemTime(new Date(Date.now() + 1_000));
    }
    await tick(env, later());
    const oldest = (await notes()).results.find((n) => n.note_text === 'Lesson 0.');
    expect(oldest).toBeDefined();
    await env.DB.prepare('UPDATE experience_notes SET approved_generation = 0 WHERE source_thought_id = ?').bind(oldest.source_thought_id).run();
    await env.DB.prepare('INSERT INTO experience_field (token_id, source_thought_id, wording, publisher, published_generation) VALUES (?, ?, ?, ?, 0)')
      .bind(PET, oldest.source_thought_id, 'job 0', h.net().contract.pets.get(PET)!.owner_id).run();
    vi.setSystemTime(new Date(Date.now() + 12 * 60_000));
    h.net().ai.push({ content: 'Report 6.\nWORK_NOTE: Lesson 6.\nWORK_FIELD: job 6' });
    await errand(tk, 'read', JOB);
    expect((await notes()).results).toHaveLength(7);
    await tick(env, later());
    const retained = (await notes()).results;
    expect(retained).toHaveLength(6);
    expect(retained.map((n) => n.note_text)).toEqual(['Lesson 6.', 'Lesson 5.', 'Lesson 4.', 'Lesson 3.', 'Lesson 2.', 'Lesson 1.']);
    expect(retained.every((n) => n.status === 'active')).toBe(true);
    expect(await env.DB.prepare('SELECT * FROM experience_field WHERE token_id = ?').bind(PET).first()).toBeNull();
  });

  // spec: add-pet-experience › Experience capture flow › eligible report × gift before debit
  it('drops a staged note if ownership changes before debit, while the paid count travels with the pet', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ content: `Report.${TRAILER}` });
    await errand(tk, 'read', JOB);
    const pet = h.net().contract.pets.get(PET)!;
    pet.owner_id = NEAR_ACCOUNT(2);
    pet.transfer_generation += 1;
    await tick(env, later());
    expect((await notes()).results).toEqual([]);
    expect(h.net().contract.experienceCounts.get(PET)?.completed_errands).toBe(1);
  });

  // spec: add-pet-experience › Experience capture flow › eligible report × memory clear before debit
  it('drops a staged note when memory is cleared before the paid debit settles', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ content: `Report.${TRAILER}` });
    await errand(tk, 'read', JOB);
    await env.DB.batch(forgetStatements(env.DB, PET, Date.now()));
    expect((await notes()).results).toEqual([]);
    await tick(env, later());
    expect((await notes()).results).toEqual([]);
  });

  // spec: add-pet-experience › Experience record contract › storage pool cannot cover first count
  it('does not activate a note when the first count has no storage pool', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ content: `Report.${TRAILER}` });
    await errand(tk, 'read', JOB);
    h.net().contract.pool = 0n;
    await tick(env, later());
    expect((await notes()).results).toEqual([]);
    expect(h.net().contract.debits).toEqual([]);
    expect(h.net().contract.experienceCounts.get(PET)).toBeUndefined();
    const thought = (await thoughtsOf())[0]!;
    const receipt = await api(`/api/verification/pets/${PET}/thoughts/${thought.id}`, { token: tk });
    expect(receipt.body).toMatchObject({ billing: 'refused', code: 'pool_empty' });
  });

  // spec: add-pet-experience › Experience record contract › paid work accepted
  it('marks only a completed errand in a mixed batch and does not replay its note', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ content: `Report.${TRAILER}` });
    await errand(tk, 'read', JOB);
    const ordinary = await run(env, PET, { kind: 'reply', mode: 'chat', text: 'Hello' });
    expect('thoughtId' in ordinary).toBe(true);
    await tick(env, later());
    expect(h.net().contract.debits[0]!.thoughts.map((t) => t.completed_errand ?? false)).toEqual([true, false]);
    expect(h.net().contract.sends.find((s) => s.method === 'debit_session')?.gas).toBe(gasFor(2, 0, 0, 1));
    await tick(env, later() + 60_000);
    expect(h.net().contract.experienceCounts.get(PET)?.completed_errands).toBe(1);
    expect((await notes()).results).toHaveLength(1);
  });
});

describe('Experience debit sizing', () => {
  // spec: add-pet-experience › Experience record contract › paid work accepted × gas and event ceiling
  it('uses the measured count delta and leaves a bounded mixed event batch', () => {
    expect(gasFor(7, 0, 7, 7)).toBe('18000000000000');
    expect(6 * receiptBytes(4)).toBeLessThan(MAX_LOG_BYTES_PER_DEBIT);
    expect(7 * receiptBytes(4)).toBeGreaterThan(MAX_LOG_BYTES_PER_DEBIT);
  });
});

describe('Signed note trailer', () => {
  // spec: add-pet-experience › Experience capture flow › eligible report × bounded note
  it('accepts at most 160 Unicode characters and leaves malformed trailers out of active memory', () => {
    const long = '🐈'.repeat(161);
    expect(captureWorkNote(`Report.\nWORK_NOTE: ${long}\nWORK_FIELD: stars`, 'stop').note).toBeNull();
    expect(captureWorkNote(`Report.\nWORK_NOTE: ${'🐈'.repeat(160)}\nWORK_FIELD: stars`, 'stop').note?.text).toBe('🐈'.repeat(160));
    expect(captureWorkNote('Report.\nWORK_NOTE: partial', 'stop').note).toBeNull();
    expect(captureWorkNote('Report.\nWORK_NOTE: partial', 'length').report).toBe('Report.');
  });
});
