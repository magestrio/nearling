// The end of a day's ritual in D1 (`pet/ritual.ts` › `settleRitual`, `settleOpenRows`) and the close of the
// days that ended (`pet/close.ts`). The streak mark that follows a completed ritual is the next stage's;
// a test of it here would be its own, so this file stops at `completed_at` and `excused`.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { ritual, tick } from '../src/cron';
import { closeDays } from '../src/pet/close';
import { desk, enqueueJob } from '../src/pet/desk';
import { doableParts, isComplete, partsOf, readFacts, settleOpenRows, settleRitual, SETTLE_PER_TICK } from '../src/pet/ritual';
import { setPause } from '../src/servicePause';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const DAY = Math.floor(Date.UTC(2026, 10, 4) / 86_400_000);
const DAY_MS = 86_400_000;
const at = (hh: number, mm: number, ss = 0, day = DAY) => {
  const t = day * DAY_MS + ((hh * 60 + mm) * 60 + ss) * 1000;
  vi.setSystemTime(t);
  return t;
};
const ENTRY = 'I dreamed of clocks.\nDid you sleep well?';

async function pet(id: string, opts: { sleptAt?: number | null; tiredDay?: number | null; diaryDay?: number | null; bornAt?: number } = {}) {
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at, tired_day, diary_day) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, NEAR_ACCOUNT(1), opts.bornAt ?? 1, '', opts.sleptAt ?? null, opts.tiredDay ?? null, opts.diaryDay ?? null)
    .run();
}
async function entry(id: string, createdAt: number, text: string | null = ENTRY) {
  await env.DB.prepare(
    "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES (?, ?, ?, 'diary', NULL, ?, 'm', '1', 0, 'pet', 'unbilled')",
  )
    .bind(crypto.randomUUID(), id, createdAt, text)
    .run();
}
async function riddle(day = DAY, sealed = true) {
  await env.DB.prepare('INSERT OR REPLACE INTO riddles (day, text, answers, salt, hash, sealed_at) VALUES (?, ?, ?, ?, ?, ?)').bind(day, 'r', '["a"]', 's', 'h', sealed ? 1 : null).run();
}
async function dayRow(id: string, patch: Partial<Record<'opened_at' | 'read_at' | 'question_at' | 'riddle_at', number>> = {}, day = DAY) {
  const cols = ['token_id', 'day', ...Object.keys(patch)];
  await env.DB.prepare(`INSERT OR REPLACE INTO ritual_days (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(id, day, ...Object.values(patch)).run();
}
const rowOf = (id: string, day = DAY) => env.DB.prepare('SELECT * FROM ritual_days WHERE token_id = ? AND day = ?').bind(id, day).first<any>();
const completed = async (id: string, day = DAY) => (await rowOf(id, day))?.completed_at ?? null;

describe('the end of the ritual', () => {
  // spec: add-daily-ritual › Daily ritual flow › ритуал завершён × the rule of the parts
  it('is written once, when the last part available is done', async () => {
    const now = at(9, 0);
    await pet('1');
    await entry('1', at(0, 5));
    await riddle();
    await dayRow('1', { opened_at: 1, read_at: 1, riddle_at: 1 });
    expect(await settleRitual(env, '1', now)).toBe(false);
    expect(await completed('1')).toBeNull();
    await env.DB.exec('UPDATE ritual_days SET question_at = 1');
    expect(await settleRitual(env, '1', now)).toBe(true);
    expect(await completed('1')).toBe(now);
    // a second look changes nothing: the first moment stays
    expect(await settleRitual(env, '1', at(9, 5))).toBe(false);
    expect(await completed('1')).toBe(now);
  });

  // spec: add-daily-ritual › Daily ritual flow › дневник ещё пишется × a riddle answered before the entry
  it('does not end while the entry is being written, and ends with no one on the screen when the 30 minutes pass', async () => {
    await pet('1');
    await riddle();
    await dayRow('1', { riddle_at: at(0, 5) });
    expect(await settleRitual(env, '1', at(0, 10))).toBe(false);
    // the cron looks at the row each minute: still inside the window
    await ritual(env, at(0, 29));
    expect(await completed('1')).toBeNull();
    // the window is over and no entry came: "diary not written", and the riddle ends the ritual
    await ritual(env, at(0, 30));
    expect(await completed('1')).toBe(at(0, 30));
  });

  // spec: add-daily-ritual › Daily ritual flow › дневник ещё пишется × a riddle answered before the entry
  it('ends once the entry has appeared on the screen and been shown', async () => {
    await pet('1');
    await riddle();
    await dayRow('1', { opened_at: 1, riddle_at: 1 });
    expect(await settleRitual(env, '1', at(0, 10))).toBe(false);
    // the entry lands: it is a part to read, and the question is a part
    await entry('1', at(0, 12), 'I dreamed of clocks.');
    expect(await settleRitual(env, '1', at(0, 13))).toBe(false);
    await env.DB.exec('UPDATE ritual_days SET read_at = 1');
    expect(await settleRitual(env, '1', at(0, 14))).toBe(true);
  });

  // spec: add-daily-ritual › Ritual day rule › питомец устал × completes at once
  it('ends at once for a tired pet whose other parts are done, after the job that found it tired', async () => {
    await pet('1', { tiredDay: DAY });
    h.net().contract.addPet('1', NEAR_ACCOUNT(1));
    await entry('1', at(0, 5));
    await riddle();
    await dayRow('1', { opened_at: 1, read_at: 1, riddle_at: 1 });
    expect(await completed('1')).toBeNull();
    at(9, 0);
    // the desk runs a job (refused as tired) and then settles the day
    const id = await enqueueJob(env.DB, '1', { kind: 'reply', mode: 'chat', text: 'Hello' });
    await desk(env, '1').process('1');
    expect((await env.DB.prepare('SELECT status, result FROM jobs WHERE id = ?').bind(id).first<any>()).result).toContain('tired');
    expect(await completed('1')).toBe(Date.now());
  });

  // spec: add-daily-ritual › Daily ritual flow › ритуал завершён × a pause starts with the question left
  it('ends within a minute, with no one on the screen, when a pause of the services takes the question', async () => {
    await pet('1');
    await entry('1', at(0, 5));
    await riddle();
    await dayRow('1', { opened_at: 1, read_at: 1, riddle_at: 1 });
    await ritual(env, at(9, 0));
    expect(await completed('1')).toBeNull();
    await setPause(env.DB, 'ai', at(9, 0, 30));
    await ritual(env, at(9, 1));
    expect(await completed('1')).toBe(at(9, 1));
  });
});

describe('the end of the ritual writes the day to the chain', () => {
  const onChain = (id: string) => {
    h.net().contract.addPet(id, NEAR_ACCOUNT(1));
    // The cron has closed yesterday: a write waits for that (`pet/mark.ts`).
    return env.DB.prepare('INSERT OR IGNORE INTO ritual_clock (id, closed_day) VALUES (1, ?)').bind(DAY - 1).run();
  };
  const marks = () => h.net().contract.marks;

  // spec: add-daily-ritual › Daily ritual flow › ритуал завершён × the day is marked
  it('marks the day once, the moment the last part is done', async () => {
    await onChain('1');
    await pet('1');
    await entry('1', at(0, 5));
    await riddle();
    await dayRow('1', { opened_at: 1, read_at: 1, question_at: 1 });
    const now = at(9, 0);
    expect(await settleRitual(env, '1', now)).toBe(false);
    expect(marks()).toEqual([]);
    await env.DB.exec('UPDATE ritual_days SET riddle_at = 1');
    expect(await settleRitual(env, '1', now)).toBe(true);
    expect(marks()).toMatchObject([{ token_id: '1', day: DAY, skipped: 0, streak: 1 }]);
    expect((await rowOf('1'))!.marked_at).toBe(now);
    // a second look sends nothing more
    await settleRitual(env, '1', at(9, 1));
    expect(marks()).toHaveLength(1);
  });

  // spec: add-daily-ritual › Ritual data › уснул до конца ритуала
  it('ends the ritual and writes the day for a pet that fell asleep after a part was done', async () => {
    await onChain('1');
    await pet('1', { sleptAt: at(8, 0) });
    await entry('1', at(0, 5));
    await riddle();
    await dayRow('1', { opened_at: 1, read_at: 1 });
    expect(await settleRitual(env, '1', at(9, 0))).toBe(true);
    expect(marks()).toMatchObject([{ token_id: '1', day: DAY }]);
  });

  // spec: add-daily-ritual › Ritual data › уснул до конца ритуала × the entry appeared on the open diary
  it('waits for the entry that the thought of the sleep wrote, and writes the day once it is shown', async () => {
    await onChain('1');
    await pet('1', { sleptAt: at(8, 0) });
    await riddle();
    await dayRow('1', { opened_at: 1 });
    // the thought that put the pet to sleep landed its entry on the open screen
    await entry('1', at(8, 0), 'I dreamed of clocks.');
    expect(await settleRitual(env, '1', at(8, 1))).toBe(false);
    expect(marks()).toEqual([]);
    await env.DB.exec('UPDATE ritual_days SET read_at = 1');
    expect(await settleRitual(env, '1', at(8, 2))).toBe(true);
    expect(marks()).toHaveLength(1);
  });

  // spec: add-daily-ritual › Ritual data › запись не написана
  it('ends the ritual and writes the day with no one on the screen when the 30 minutes pass without an entry', async () => {
    await onChain('1');
    await pet('1');
    await riddle();
    await dayRow('1', { riddle_at: at(0, 5) });
    await ritual(env, at(0, 29));
    expect(marks()).toEqual([]);
    await ritual(env, at(0, 30));
    expect(marks()).toMatchObject([{ token_id: '1', day: DAY, streak: 1 }]);
    expect((await rowOf('1'))!.marked_at).toBe(at(0, 30));
  });
});

describe('a pet that sleeps', () => {
  // spec: add-daily-ritual › Daily ritual flow › уснул в нетронутый день
  it('ends nothing for a day with no part done and the Diary not opened, and sends nothing', async () => {
    await pet('1', { sleptAt: at(8, 0) });
    await entry('1', at(0, 5));
    await riddle();
    expect(await settleRitual(env, '1', at(9, 0))).toBe(false);
    // the Diary screen did stand, but the pet is awake: opening alone completes nothing
    await dayRow('1', { opened_at: 1 });
    await env.DB.exec('UPDATE pets SET slept_at = NULL');
    expect(await settleRitual(env, '1', at(9, 5))).toBe(false);
    expect(h.net().contract.sends).toEqual([]);
  });

  // spec: add-daily-ritual › Daily ritual flow › уснул в нетронутый день × woke the same day
  it('has the parts available again when it wakes the same day', async () => {
    await pet('1', { sleptAt: at(8, 0) });
    await entry('1', at(0, 5));
    await riddle();
    expect(await settleRitual(env, '1', at(9, 0))).toBe(false);
    const asleep = (await readFacts(env, '1', at(9, 0)))!;
    expect(partsOf(asleep)).toEqual(['diary']);
    await env.DB.exec('UPDATE pets SET slept_at = NULL');
    const awake = (await readFacts(env, '1', at(10, 0)))!;
    expect(partsOf(awake)).toEqual(['diary', 'question', 'riddle']);
    expect(doableParts(awake)).toEqual(['question', 'riddle']);
    expect(isComplete(awake)).toBe(false);
  });

  it('ends for a pet that fell asleep after a part was done, with only what a sleeping pet cannot do left', async () => {
    await pet('1', { sleptAt: at(8, 0) });
    await entry('1', at(0, 5));
    await riddle();
    await dayRow('1', { opened_at: 1, read_at: 1 });
    expect(await settleRitual(env, '1', at(9, 0))).toBe(true);
  });

  it('ends for a pet that fell asleep with the Diary open and the entry not yet shown only once it is shown', async () => {
    await pet('1', { sleptAt: at(8, 0) });
    await entry('1', at(0, 5));
    await riddle();
    await dayRow('1', { opened_at: 1 });
    expect(await settleRitual(env, '1', at(9, 0))).toBe(false);
    await env.DB.exec('UPDATE ritual_days SET read_at = 1');
    expect(await settleRitual(env, '1', at(9, 1))).toBe(true);
  });

  it('ends for a sleeping pet that opened the Diary on a day with no entry and no riddle', async () => {
    await pet('1', { sleptAt: at(8, 0) });
    await dayRow('1', { opened_at: 1 });
    expect(await settleRitual(env, '1', at(9, 0))).toBe(true);
  });
});

describe('a clear of the memory', () => {
  it('settles the day: an entry erased with its question leaves nothing to read or answer', async () => {
    const owner = NEAR_ACCOUNT(1);
    h.net().contract.addPet('1', owner);
    await pet('1');
    await entry('1', at(0, 5));
    await riddle();
    await dayRow('1', { opened_at: 1, riddle_at: 1 });
    at(9, 0);
    expect(await settleRitual(env, '1', Date.now())).toBe(false);
    const res = await api('/api/pets/1/memory/clear', { token: await token('did:privy:owner', owner), body: {} });
    expect(res.status).toBe(200);
    // the settle runs after the response
    const now = Date.now();
    await vi.waitFor(async () => expect(await completed('1')).toBe(now));
  });
});

describe('the cron looking at the open rows', () => {
  it('looks at a few a tick, the ones looked at longest ago first, and leaves the ended ones alone', async () => {
    const now = at(9, 0);
    await riddle();
    for (let i = 0; i < SETTLE_PER_TICK + 10; i += 1) {
      await pet(String(i));
      await dayRow(String(i), { opened_at: 1 });
    }
    await settleOpenRows(env, now);
    const looked = await env.DB.prepare('SELECT COUNT(*) AS n FROM ritual_days WHERE checked_at = ?').bind(now).first<{ n: number }>();
    expect(looked!.n).toBe(SETTLE_PER_TICK);
    await settleOpenRows(env, at(9, 1));
    const second = await env.DB.prepare('SELECT COUNT(*) AS n FROM ritual_days WHERE checked_at = ?').bind(at(9, 1)).first<{ n: number }>();
    // the ten never looked at come first, then the ones looked at longest ago
    expect(second!.n).toBe(SETTLE_PER_TICK);
    const unseen = await env.DB.prepare('SELECT COUNT(*) AS n FROM ritual_days WHERE checked_at IS NULL').first<{ n: number }>();
    expect(unseen!.n).toBe(0);
  });
});

describe('the close of a day', () => {
  /** A clock that says the days before `closed` are closed, and a tick at the start of the day after. */
  const clockAt = (closed: number) => env.DB.prepare('INSERT OR REPLACE INTO ritual_clock (id, closed_day) VALUES (1, ?)').bind(closed).run();

  it('runs in the minute cron: the days that ended are closed by a tick', async () => {
    await clockAt(DAY - 2);
    await pet('1', { sleptAt: at(20, 0, 0, DAY - 1) });
    await tick(env, at(0, 1));
    expect(await rowOf('1', DAY - 1)).toMatchObject({ excused: 1 });
  });

  it('starts its clock at yesterday on the first run and writes nothing', async () => {
    await pet('1', { sleptAt: 5 });
    await closeDays(env, at(0, 1));
    expect((await env.DB.prepare('SELECT closed_day FROM ritual_clock').first<any>()).closed_day).toBe(DAY - 1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM ritual_days').first<any>()).n).toBe(0);
  });

  // spec: add-daily-ritual › Streak rule › питомец спал
  it('excuses a day that ended with the pet asleep and the ritual not ended, and leaves a completed one alone', async () => {
    await clockAt(DAY - 2);
    await riddle(DAY - 1);
    await pet('1', { sleptAt: at(20, 0, 0, DAY - 1) });
    await pet('2', { sleptAt: at(20, 0, 0, DAY - 1) });
    await pet('3');
    await entry('3', at(0, 5, 0, DAY - 1));
    await env.DB.prepare('INSERT INTO ritual_days (token_id, day, read_at, completed_at) VALUES (?, ?, 1, ?)').bind('2', DAY - 1, 77).run();
    await closeDays(env, at(0, 1));
    expect(await rowOf('1', DAY - 1)).toMatchObject({ excused: 1, completed_at: null });
    // the ritual ended before the pet slept: the day counts, it is not excused
    expect(await rowOf('2', DAY - 1)).toMatchObject({ excused: 0, completed_at: 77 });
    // an awake pet with a diary and a riddle that day: a miss, not an excuse
    expect(await rowOf('3', DAY - 1)).toBeNull();
    expect((await env.DB.prepare('SELECT closed_day FROM ritual_clock').first<any>()).closed_day).toBe(DAY - 1);
  });

  // spec: add-daily-ritual › Streak rule › питомец спал × days the cron missed
  it('closes every day the cron missed, one by one, and a day it closed is not closed twice', async () => {
    await clockAt(DAY - 5);
    await pet('1', { sleptAt: at(20, 0, 0, DAY - 5) });
    await riddle(DAY - 4);
    await riddle(DAY - 3);
    await riddle(DAY - 2);
    await riddle(DAY - 1);
    await closeDays(env, at(0, 1));
    const rows = (await env.DB.prepare("SELECT day, excused FROM ritual_days WHERE token_id = '1' ORDER BY day").all<any>()).results;
    expect(rows).toEqual([DAY - 4, DAY - 3, DAY - 2, DAY - 1].map((day) => ({ day, excused: 1 })));
    expect((await env.DB.prepare('SELECT closed_day FROM ritual_clock').first<any>()).closed_day).toBe(DAY - 1);
    // nothing to close at the next minute
    await env.DB.exec('DELETE FROM ritual_days');
    await closeDays(env, at(0, 2));
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM ritual_days').first<any>()).n).toBe(0);
  });

  it('excuses the day for pets with nothing available: the riddle never opened and no entry', async () => {
    await clockAt(DAY - 2);
    await pet('1');
    await pet('2');
    await entry('2', at(0, 5, 0, DAY - 1));
    // a pet born after that day has no such day at all
    await pet('3', { bornAt: at(5, 0) });
    await riddle(DAY - 1, false);
    await closeDays(env, at(0, 1));
    expect(await rowOf('1', DAY - 1)).toMatchObject({ excused: 1 });
    expect(await rowOf('2', DAY - 1)).toBeNull();
    expect(await rowOf('3', DAY - 1)).toBeNull();
    // the riddle sealed that day: the same pet missed it
    await clockAt(DAY - 1);
    await env.DB.exec('DELETE FROM ritual_days');
    await riddle(DAY, true);
    await closeDays(env, at(0, 2, 0, DAY + 1));
    expect(await rowOf('1', DAY)).toBeNull();
  });

  // spec: add-daily-ritual › Streak rule › день не записан
  it('excuses a completed day whose mark did not land by the end of the next day, and no earlier', async () => {
    await clockAt(DAY - 2);
    await pet('1');
    await riddle(DAY - 1);
    await entry('1', at(0, 5, 0, DAY - 1));
    await env.DB.prepare('INSERT INTO ritual_days (token_id, day, completed_at) VALUES (?, ?, 5)').bind('1', DAY - 2).run();
    await env.DB.prepare('INSERT INTO ritual_days (token_id, day, completed_at) VALUES (?, ?, 5)').bind('1', DAY - 1).run();
    await env.DB.prepare('INSERT INTO ritual_days (token_id, day, completed_at, marked_at) VALUES (?, ?, 5, 6)').bind('1', DAY - 3).run();
    // closing DAY - 1: the day before it has had its whole next day; DAY - 1 has not
    await closeDays(env, at(0, 1));
    expect((await rowOf('1', DAY - 2)).excused).toBe(1);
    expect((await rowOf('1', DAY - 1)).excused).toBe(0);
    expect((await rowOf('1', DAY - 3)).excused).toBe(0);
    // one day on, DAY - 1 has had its next day too
    await closeDays(env, at(0, 1, 0, DAY + 1));
    expect((await rowOf('1', DAY - 1)).excused).toBe(1);
  });
});

describe('the read mark', () => {
  const OWNER = NEAR_ACCOUNT(1);
  const owner = () => token('did:privy:owner', OWNER);
  const read = async (day = DAY, id = '1') => api(`/api/pets/${id}/diary/read`, { token: await owner(), body: { day } });
  const state = async () => (await api('/api/pets/1/state', { token: await owner() })).body;
  async function mine(sleptAt: number | null = null) {
    h.net().contract.addPet('1', OWNER);
    await env.DB.prepare('INSERT OR IGNORE INTO ritual_clock (id, closed_day) VALUES (1, ?)').bind(DAY - 1).run();
    await pet('1', { sleptAt });
    await entry('1', at(0, 5));
    await riddle();
    return at(9, 0);
  }

  // spec: add-daily-ritual › Daily ritual flow › встречает дневником × the read mark and its event
  it('opens the day and reads the entry shown, with one ritual_completed for the diary', async () => {
    const now = await mine();
    expect((await state()).diaryUnread).toBe(true);
    expect(await read()).toEqual({ status: 200, body: { ok: true } });
    expect(await rowOf('1')).toMatchObject({ opened_at: now, read_at: now, completed_at: null });
    expect(h.events().filter((e) => e.name === 'ritual_completed')).toEqual([{ name: 'ritual_completed', props: { part: 'diary' } }]);
  });

  // spec: add-daily-ritual › Streak rule › серия записана позже × the response does not wait for the mark
  it('answers at once when the read is the last part, while the mark waits for a slow chain', async () => {
    await mine();
    await dayRow('1', { question_at: 1, riddle_at: 1 });
    let open!: () => void;
    h.net().contract.sendGate = new Promise<void>((resolve) => (open = resolve));
    expect(await read()).toEqual({ status: 200, body: { ok: true } });
    const now = Date.now();
    await vi.waitFor(async () => expect((await rowOf('1'))!.completed_at).toBe(now));
    expect(h.net().contract.marks).toEqual([]);
    open();
    await vi.waitFor(() => expect(h.net().contract.marks).toMatchObject([{ token_id: '1', day: DAY }]));
  });

  // spec: add-daily-ritual › Daily ritual flow › встречает дневником × a reload after the read
  it('is sent again after a reload and changes nothing: the first moments stay, no second event', async () => {
    const first = await mine();
    await read();
    at(9, 5);
    expect((await read()).body).toEqual({ ok: true });
    expect(await rowOf('1')).toMatchObject({ opened_at: first, read_at: first });
    expect(h.events().filter((e) => e.name === 'ritual_completed')).toHaveLength(1);
  });

  // spec: add-daily-ritual › Daily ritual flow › встречает дневником × a second tab
  it("is read in one tab and the other's diaryUnread goes false", async () => {
    await mine();
    expect((await state()).diaryUnread).toBe(true);
    await read();
    expect((await state()).diaryUnread).toBe(false);
    // and an entry that is erased is no unread entry
    await env.DB.exec('DELETE FROM ritual_days');
    await env.DB.exec('UPDATE thoughts SET reply_text = NULL, erased_at = 1');
    expect((await state()).diaryUnread).toBe(false);
  });

  it('writes nothing for another day than the Worker\'s, and answers 400 to no day', async () => {
    await mine();
    expect((await read(DAY - 1)).body).toEqual({ ok: true });
    expect(await rowOf('1')).toBeNull();
    expect((await api('/api/pets/1/diary/read', { token: await owner(), body: {} })).status).toBe(400);
  });

  it('turns away a stranger and a visitor, writing nothing', async () => {
    await mine();
    expect((await api('/api/pets/1/diary/read', { body: { day: DAY } })).status).toBe(401);
    const other = await api('/api/pets/1/diary/read', { token: await token('did:privy:other', NEAR_ACCOUNT(9)), body: { day: DAY } });
    expect(other.status).toBe(403);
    expect(await rowOf('1')).toBeNull();
  });

  // spec: add-daily-ritual › Daily ritual flow › уснул в нетронутый день × a sleeping pet's diary address marks no opening
  it("writes nothing for a sleeping pet that opened nothing today, whatever the request says", async () => {
    await mine(at(8, 0));
    expect((await read()).body).toEqual({ ok: true });
    expect(await rowOf('1')).toBeNull();
    expect(h.net().contract.sends).toEqual([]);
    expect(h.events().filter((e) => e.name === 'ritual_completed')).toEqual([]);
  });

  // spec: add-daily-ritual › Daily ritual flow › уснул в нетронутый день × GET diary marks nothing
  it('is marked by neither the poll nor the read of the address: GET …/diary writes no row', async () => {
    await mine();
    for (let n = 0; n < 3; n += 1) expect((await api('/api/pets/1/diary', { token: await owner() })).status).toBe(200);
    await env.DB.exec('UPDATE pets SET slept_at = 1');
    expect((await api('/api/pets/1/diary', { token: await owner() })).status).toBe(200);
    expect(await rowOf('1')).toBeNull();
    expect(h.events().filter((e) => e.name === 'ritual_completed')).toEqual([]);
  });

  // spec: add-daily-ritual › Diary screen › asleep × the read mark is accepted
  it('accepts the read mark of a pet that fell asleep on the open screen: the entry its thought wrote is read, the ritual ends', async () => {
    await mine();
    await read();
    // the pet falls asleep with the Diary open; the entry its last thought wrote appears and is shown
    await env.DB.exec('DELETE FROM thoughts');
    await env.DB.exec('UPDATE ritual_days SET read_at = NULL');
    await entry('1', at(9, 1), 'A new line.');
    await env.DB.exec('UPDATE pets SET slept_at = 1');
    expect((await read()).body).toEqual({ ok: true });
    expect((await rowOf('1'))!.read_at).toBe(Date.now());
    // the settle runs after the response
    const now = Date.now();
    await vi.waitFor(async () => expect((await rowOf('1'))!.completed_at).toBe(now));
    await vi.waitFor(() => expect(h.net().contract.marks).toMatchObject([{ token_id: '1', day: DAY }]));
  });
});
