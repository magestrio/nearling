// The owner's answer to the day's riddle (`POST /api/pets/:id/riddle`): the limits of the text, one answer a
// day, the match, an answer too late, a pet that sleeps, and what the answer feeds (the mood, «clever»).
import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const DAY = Math.floor(Date.UTC(2026, 10, 4) / 86_400_000);
const DAY_MS = 86_400_000;
const at = (hh: number, mm: number, ss = 0, day = DAY) => {
  const t = day * DAY_MS + ((hh * 60 + mm) * 60 + ss) * 1000;
  vi.setSystemTime(t);
  return t;
};
const owner = () => token('did:privy:owner', OWNER);
const answer = async (text: string, day = DAY, id = '5') => api(`/api/pets/${id}/riddle`, { token: await owner(), body: { text, day } });

async function setup(opts: { sealed?: boolean; sleptAt?: number | null } = {}) {
  const now = at(9, 0);
  h.net().contract.addPet('5', OWNER);
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at) VALUES (?, ?, ?, ?, ?)').bind('5', OWNER, 1, '', opts.sleptAt ?? null).run();
  await env.DB.prepare('INSERT INTO riddles (day, text, answers, salt, hash, sealed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(DAY, 'What has hands but cannot clap?', JSON.stringify(['a clock', 'clock']), 'salt', 'h', opts.sealed === false ? null : 1)
    .run();
  return now;
}
const dayRow = () => env.DB.prepare('SELECT * FROM ritual_days WHERE token_id = ? AND day = ?').bind('5', DAY).first<any>();
const stored = () => env.DB.prepare('SELECT * FROM riddle_answers WHERE token_id = ?').bind('5').all<any>().then((r) => r.results);
const life = () => env.DB.prepare('SELECT * FROM pet_life WHERE token_id = ?').bind('5').first<any>();

describe('an answer in its day', () => {
  // spec: add-daily-ritual › Riddle rule › ответ принят
  it('is accepted: the answer is stored, the day is marked, one ritual_completed for the riddle', async () => {
    const now = await setup();
    expect(await answer('a clock')).toEqual({ status: 200, body: { status: 'accepted' } });
    expect(await dayRow()).toMatchObject({ riddle_at: now });
    expect(await stored()).toEqual([{ token_id: '5', day: DAY, text: 'a clock', correct: 1, answered_at: now }]);
    expect(h.events().filter((e) => e.name === 'ritual_completed')).toEqual([{ name: 'ritual_completed', props: { part: 'riddle' } }]);
    // the diary's own state: the field is replaced by the owner's answer, with no verdict
    const diary = await api('/api/pets/5/diary', { token: await owner() });
    expect(diary.body.riddle).toEqual({ kind: 'answered', day: DAY, text: 'What has hands but cannot clap?', answer: 'a clock' });
    expect(JSON.stringify(diary.body)).not.toContain('"correct"');
  });

  // spec: add-daily-ritual › Riddle rule › ответ принят × the answer cannot be written
  it('gives the claim of the day back when the answer cannot be written, so the retry is a first answer', async () => {
    const now = await setup();
    await env.DB.exec("CREATE TRIGGER fail_answer BEFORE INSERT ON riddle_answers BEGIN SELECT RAISE(ABORT, 'no'); END");
    const res = await SELF.fetch('https://game.test/api/pets/5/riddle', {
      method: 'POST',
      headers: { 'privy-id-token': await owner(), 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
      body: JSON.stringify({ text: 'a clock', day: DAY }),
    });
    expect(res.status).toBe(500);
    await res.text();
    // the batch is whole or nothing; the claim is not left behind
    expect(await dayRow()).toMatchObject({ riddle_at: null });
    expect(await stored()).toEqual([]);
    expect(await life()).toBeNull();
    expect(h.events().filter((e) => e.name === 'ritual_completed')).toEqual([]);
    await env.DB.exec('DROP TRIGGER fail_answer');
    expect(await answer('a clock')).toEqual({ status: 200, body: { status: 'accepted' } });
    expect(await dayRow()).toMatchObject({ riddle_at: now });
    expect(await stored()).toEqual([{ token_id: '5', day: DAY, text: 'a clock', correct: 1, answered_at: now }]);
    expect(await life()).toMatchObject({ mood_day: DAY, riddles: 1 });
  });

  // spec: add-daily-ritual › Riddle rule › ответ принят × mood and clever
  it('lifts the mood of the day and counts a deed of «clever», right or wrong', async () => {
    await setup();
    expect(await answer('a harp')).toEqual({ status: 200, body: { status: 'accepted' } });
    expect(await life()).toMatchObject({ mood_day: DAY, riddles: 1 });
    expect((await stored())[0]).toMatchObject({ text: 'a harp', correct: 0 });
  });

  // spec: add-daily-ritual › Riddle rule › ответ принят × limits of the text: 40 and 41, a line break, no visible character
  it('takes 40 characters and refuses 41, a line break and a text with nothing visible, writing nothing', async () => {
    await setup();
    for (const bad of ['x'.repeat(41), 'a\nb', 'a\rb', 'a b', '   ', '​​', '😀'.repeat(41)]) {
      expect((await answer(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await dayRow()).toBeNull();
    expect(await stored()).toEqual([]);
    // 40 code points: a text of 40 emoji is 80 UTF-16 units and passes (the server counts code points)
    expect((await answer('😀'.repeat(40))).body).toEqual({ status: 'accepted' });
    expect((await stored())[0]!.text).toBe('😀'.repeat(40));
  });

  it('refuses a request with no text or no day, and a visitor, a stranger', async () => {
    await setup();
    expect((await api('/api/pets/5/riddle', { token: await owner(), body: { text: 'a clock' } })).status).toBe(400);
    expect((await api('/api/pets/5/riddle', { token: await owner(), body: { day: DAY } })).status).toBe(400);
    expect((await api('/api/pets/5/riddle', { body: { text: 'a clock', day: DAY } })).status).toBe(401);
    expect((await api('/api/pets/5/riddle', { token: await token('did:privy:other', NEAR_ACCOUNT(9)), body: { text: 'a clock', day: DAY } })).status).toBe(403);
    expect(await dayRow()).toBeNull();
  });

  // spec: add-daily-ritual › Riddle rule › ответ принят × a second answer, a stale tab
  it('takes a second answer of the day for nothing: the first stays, no second event, no second deed', async () => {
    await setup();
    await answer('a clock');
    at(9, 5);
    expect((await answer('a harp')).body).toEqual({ status: 'already' });
    expect(await stored()).toHaveLength(1);
    expect((await stored())[0]).toMatchObject({ text: 'a clock', correct: 1 });
    expect((await life()).riddles).toBe(1);
    expect(h.events().filter((e) => e.name === 'ritual_completed')).toHaveLength(1);
  });

  it('takes two sends at once for one answer', async () => {
    await setup();
    const both = await Promise.all([answer('a clock'), answer('clock')]);
    expect(both.map((r) => r.body.status).sort()).toEqual(['accepted', 'already']);
    expect(await stored()).toHaveLength(1);
    expect((await life()).riddles).toBe(1);
  });

  // spec: add-daily-ritual › Riddle rule › ответ принят × nothing in the logs or in NEAR AI
  it('puts the answer in no log and sends nothing to NEAR AI', async () => {
    await setup();
    await answer('a very private guess');
    expect(h.logs().join('\n')).not.toContain('private');
    expect(h.net().ai.calls).toEqual([]);
    expect(JSON.stringify(h.events())).not.toContain('private');
  });

  // spec: add-daily-ritual › Riddle rule › ответ принят × an asleep pet
  it('is not taken from a pet that sleeps: 409 asleep, nothing written', async () => {
    await setup({ sleptAt: at(8, 0) });
    expect(await answer('a clock')).toEqual({ status: 409, body: { code: 'asleep' } });
    expect(await dayRow()).toBeNull();
    expect(await stored()).toEqual([]);
    expect(await life()).toBeNull();
  });

  it('does not open before the commit is on chain: 409 not_sealed', async () => {
    await setup({ sealed: false });
    expect(await answer('a clock')).toEqual({ status: 409, body: { code: 'not_sealed' } });
    expect(await dayRow()).toBeNull();
  });
});

describe('the match', () => {
  // spec: add-daily-ritual › Riddle rule › угадал × case and edge spaces
  it('ignores case and the spaces at the edges, and nothing more', async () => {
    await setup();
    await env.DB.exec('UPDATE riddles SET answers = \'["a Clock", "clock"]\'');
    const cases: [string, number][] = [
      ['  A CLOCK  ', 1],
      ['CLOCK', 1],
      ['a  clock', 0],
      ['clock!', 0],
      ['the clock', 0],
    ];
    for (const [text, correct] of cases) {
      await env.DB.exec('DELETE FROM ritual_days; DELETE FROM riddle_answers');
      expect((await answer(text)).body.status).toBe('accepted');
      expect((await stored())[0]!.correct, text).toBe(correct);
    }
  });
});

describe('an answer after its day', () => {
  // spec: add-daily-ritual › Riddle rule › ответ опоздал
  it('writes nothing: not the answer, not the ritual, not the mood, not «clever»', async () => {
    await setup();
    at(0, 0, 1, DAY + 1);
    expect(await answer('a clock', DAY)).toEqual({ status: 200, body: { status: 'late' } });
    expect(await dayRow()).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM ritual_days').first<any>()).toEqual({ n: 0 });
    expect(await stored()).toEqual([]);
    expect(await life()).toBeNull();
    expect(h.events().filter((e) => e.name === 'ritual_completed')).toEqual([]);
  });

  it('is told late before anything else is looked at: also for a pet that sleeps and a riddle not sealed', async () => {
    await setup({ sleptAt: at(8, 0), sealed: false });
    at(0, 0, 1, DAY + 1);
    expect((await answer('a clock', DAY)).body).toEqual({ status: 'late' });
  });
});
