// What the clear of a pet's memory does to the ritual (`Ritual data` › «удаление памяти»): the words go,
// the marks of the day stay, and the day is settled again.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { api, harness, settle } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const DAY = Math.floor(Date.UTC(2036, 10, 4) / 86_400_000);
const DAY_MS = 86_400_000;
const at = (hh: number, mm: number, ss = 0, day = DAY) => {
  const t = day * DAY_MS + ((hh * 60 + mm) * 60 + ss) * 1000;
  vi.setSystemTime(t);
  return t;
};
const owner = () => token('did:privy:owner', OWNER);
const clear = async () => api('/api/pets/5/memory/clear', { token: await owner(), body: {} });
const diary = async () => (await api('/api/pets/5/diary', { token: await owner() })).body;
const dayRow = (day = DAY) => env.DB.prepare('SELECT * FROM ritual_days WHERE token_id = ? AND day = ?').bind('5', day).first<any>();

async function setup() {
  at(9, 0);
  h.net().contract.addPet('5', OWNER);
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)').bind('5', OWNER, 1, '').run();
  await env.DB.prepare(
    "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES ('entry1', '5', ?, 'diary', NULL, 'I dreamed of clocks.\nDid you sleep well?', 'm', '0', 0, 'pet', 'billed')",
  )
    .bind(DAY * DAY_MS + 5 * 60_000)
    .run();
  // The cron has closed yesterday: a write waits for that (`pet/mark.ts`).
  await env.DB.exec(`INSERT OR IGNORE INTO ritual_clock (id, closed_day) VALUES (1, ${DAY - 1})`);
  await env.DB.exec(`INSERT INTO riddles (day, text, answers, salt, hash, sealed_at) VALUES (${DAY}, 'Riddle?', '["a clock"]', 's', 'h', 1)`);
  await env.DB.exec(`INSERT INTO riddles (day, text, answers, hash, sealed_at, revealed_at) VALUES (${DAY - 1}, 'Old?', '["a piano"]', 'h', 1, 2)`);
}

describe('a clear of the memory', () => {
  // spec: add-daily-ritual › Ritual data › удаление памяти
  it('erases the entry, the answer to the question and the riddle answers, and keeps the marks of the day', async () => {
    await setup();
    const tk = await owner();
    const sent = await api('/api/pets/5/diary/answer', { token: tk, body: { text: 'Yes', day: DAY } });
    await settle(tk, '5', sent.body.job);
    await api('/api/pets/5/riddle', { token: tk, body: { text: 'a clock', day: DAY } });
    await env.DB.prepare('INSERT INTO riddle_answers (token_id, day, text, correct, answered_at) VALUES (?, ?, ?, 1, 1)').bind('5', DAY - 1, 'a piano').run();
    await env.DB.exec(`UPDATE ritual_days SET opened_at = 1, read_at = 1 WHERE day = ${DAY}`);
    const marks = await dayRow();
    expect(marks).toMatchObject({ question_at: expect.any(Number), riddle_at: expect.any(Number) });

    expect((await clear()).status).toBe(200);

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM thoughts WHERE reply_text IS NOT NULL OR player_text IS NOT NULL").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM riddle_answers').first()).toEqual({ n: 0 });
    // the marks of the day stay
    expect(await dayRow()).toMatchObject({ opened_at: 1, read_at: 1, question_at: marks.question_at, riddle_at: marks.riddle_at });
    const out = await diary();
    expect(out.entry).toEqual({ kind: 'cleared' });
    expect(out.exchange).toBeNull();
    // the riddle answered before is "Answered today" with no words; a second answer is not taken
    expect(out.riddle).toEqual({ kind: 'answered', day: DAY, text: 'Riddle?', answer: null });
    expect(await api('/api/pets/5/riddle', { token: tk, body: { text: 'a harp', day: DAY } })).toEqual({ status: 200, body: { status: 'already' } });
    // yesterday's riddle: the owner's answer is gone, so it reads as never answered
    expect(out.yesterday).toEqual({ kind: 'none', answer: 'a piano' });
  });

  // spec: add-daily-ritual › Ritual data › удаление памяти × the settle after a clear
  it('settles the day: an entry erased with its question leaves nothing to read or answer', async () => {
    await setup();
    const tk = await owner();
    await api('/api/pets/5/riddle', { token: tk, body: { text: 'a clock', day: DAY } });
    await env.DB.exec(`UPDATE ritual_days SET opened_at = 1 WHERE day = ${DAY}`);
    expect((await dayRow()).completed_at).toBeNull();
    await clear();
    // the settle runs after the response
    const now = Date.now();
    await vi.waitFor(async () => expect((await dayRow()).completed_at).toBe(now));
    await vi.waitFor(() => expect(h.net().contract.marks).toMatchObject([{ token_id: '5', day: DAY }]));
  });

  // spec: add-daily-ritual › Ritual data › удаление памяти × hello after an erased answer
  it('keeps the input hint at "Talk to…" after an erased answer to the question', async () => {
    await setup();
    const tk = await owner();
    expect((await api('/api/pets/5/state', { token: tk })).body.hello).toBe(true);
    const sent = await api('/api/pets/5/diary/answer', { token: tk, body: { text: 'Yes', day: DAY } });
    await settle(tk, '5', sent.body.job);
    expect((await api('/api/pets/5/state', { token: tk })).body.hello).toBe(false);
    await clear();
    expect((await api('/api/pets/5/state', { token: tk })).body.hello).toBe(false);
  });
});
