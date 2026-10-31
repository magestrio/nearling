// The write of a finished ritual's day to the contract (`pet/mark.ts` › `writeDueMark`): the claim, the
// reads, `skipped`, `mark_before`, the send, the finish, the events, and what a lost outcome, a day ahead
// of the chain, two days pending and the pauses do to it.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { markDueDays } from '../src/pet/ritual';
import { ritual } from '../src/cron';
import { closeDays } from '../src/pet/close';
import { writeDueMark } from '../src/pet/mark';
import { setPause } from '../src/servicePause';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const DAY = Math.floor(Date.UTC(2026, 10, 4) / 86_400_000);
const DAY_MS = 86_400_000;
const at = (hh: number, mm: number, ss = 0, day = DAY) => {
  const t = day * DAY_MS + ((hh * 60 + mm) * 60 + ss) * 1000;
  vi.setSystemTime(t);
  return t;
};

/** A pet of the chain and of D1; `chain` is what the contract holds of its streak. */
async function pet(id: string, chain: { streak?: number; freezes?: number; last?: number | null } = {}, d1: { sleptAt?: number | null; gifted?: number } = {}) {
  h.net().contract.addPet(id, OWNER, { streak: chain.streak ?? 0, freezes: chain.freezes ?? 1, last_streak_day: chain.last ?? null });
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at, gifted_unmarked) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, OWNER, 1, '', d1.sleptAt ?? null, d1.gifted ?? 0)
    .run();
  // The cron has closed yesterday (a write waits for that: `closed_day`); a test of the wait moves it.
  await env.DB.prepare('INSERT OR IGNORE INTO ritual_clock (id, closed_day) VALUES (1, ?)').bind(DAY - 1).run();
}
/** A day whose ritual ended (and, with `excused`, a day that goes into `skipped`). */
async function ended(id: string, day: number, patch: { excused?: number; completed?: number | null } = {}) {
  await env.DB.prepare('INSERT INTO ritual_days (token_id, day, completed_at, excused) VALUES (?, ?, ?, ?)')
    .bind(id, day, patch.completed === undefined ? day * DAY_MS + 3_600_000 : patch.completed, patch.excused ?? 0)
    .run();
}
const rowOf = (id: string, day: number) => env.DB.prepare('SELECT * FROM ritual_days WHERE token_id = ? AND day = ?').bind(id, day).first<any>();
const marks = () => h.net().contract.marks;
const sends = () => h.net().contract.sends.filter((s) => s.method === 'streak_mark');
const chainPet = (id: string) => h.net().contract.pets.get(id)!;

describe('the mark of a finished day', () => {
  // spec: add-daily-ritual › Streak rule › серия записана позже
  // spec: add-daily-ritual › Daily ritual flow › ритуал завершён × the day is marked
  it('sends the first mark with no skipped, finishes the row once, clears the quiet of a gifted pet and pays the gas', async () => {
    await pet('1', {}, { gifted: 1 });
    await ended('1', DAY);
    await ended('1', DAY - 1, { completed: 5 });
    at(10, 0);
    h.net().contract.burnt = '1000000000000000000000';
    expect(await writeDueMark(env, '1')).toBe('written');
    expect(sends()).toHaveLength(2);
    expect(sends()[0]!.args).toEqual({ token_id: '1', day: DAY - 1, skipped: 0 });
    expect(sends()[0]!.gas).toBe((5n * 10n ** 12n).toString());
    expect(sends()[0]!.deposit).toBe('0');
    // the older day went first, then the newer one in the same call (the older first: design.md › The mark)
    expect(marks().map((m) => [m.day, m.streak])).toEqual([[DAY - 1, 1], [DAY, 2]]);
    expect(await rowOf('1', DAY)).toMatchObject({ marked_at: Date.now(), sending_at: null });
    // the rows of earlier days went with the mark that landed
    expect(await rowOf('1', DAY - 1)).toBeNull();
    expect((await env.DB.prepare("SELECT gifted_unmarked AS g FROM pets WHERE token_id = '1'").first<any>()).g).toBe(0);
    const spend = await env.DB.prepare("SELECT kind, usd_micros FROM project_spend WHERE kind = 'gas'").all<any>();
    expect(spend.results).toHaveLength(2);
    expect(h.logs()).toContain('streak_sent');
    // nothing is left to write
    expect(await writeDueMark(env, '1')).toBe('idle');
    expect(sends()).toHaveLength(2);
  });

  // spec: add-daily-ritual › Streak rule › серия записана позже × two days pending
  it('writes the older day first and the newer one after it, one at a time', async () => {
    await pet('1', { streak: 3, freezes: 1, last: DAY - 3 });
    await ended('1', DAY - 1);
    await ended('1', DAY);
    at(0, 5);
    expect(await writeDueMark(env, '1')).toBe('written');
    // DAY - 2 was not played: a freeze covers it; the second mark misses nothing
    expect(marks().map((m) => [m.day, m.skipped, m.streak, m.freezes])).toEqual([
      [DAY - 1, 0, 4, 0],
      [DAY, 0, 5, 0],
    ]);
  });

  // spec: add-daily-ritual › Daily ritual flow › уснул в нетронутый день × the day ended asleep goes into skipped
  it('counts the days that ended asleep as skipped, and the contract spends no freeze for them', async () => {
    // the last mark was on DAY - 4; DAY - 3 was slept through, DAY - 2 and DAY - 1 were not played
    await pet('1', { streak: 4, freezes: 1, last: DAY - 4 }, { sleptAt: at(20, 0, 0, DAY - 3) });
    await env.DB.prepare('INSERT OR REPLACE INTO ritual_clock (id, closed_day) VALUES (1, ?)').bind(DAY - 4).run();
    await env.DB.prepare('INSERT INTO riddles (day, text, answers, salt, hash, sealed_at) VALUES (?, ?, ?, ?, ?, 1)').bind(DAY - 3, 'r', '["a"]', 's', 'h').run();
    await closeDays(env, at(0, 1, 0, DAY - 2));
    expect(await rowOf('1', DAY - 3)).toMatchObject({ excused: 1, completed_at: null });
    // the cron went on closing the days up to yesterday (the days it closed are not the test's point)
    await env.DB.exec(`UPDATE ritual_clock SET closed_day = ${DAY - 1}`);
    // the pet woke on DAY - 2 and played on the day after the next
    await env.DB.exec('UPDATE pets SET slept_at = NULL');
    await ended('1', DAY);
    at(9, 0);
    expect(await writeDueMark(env, '1')).toBe('written');
    // between DAY - 4 and DAY: three days; one excused: skipped 1, two missed, one freeze: a restart
    expect(sends()[0]!.args).toEqual({ token_id: '1', day: DAY, skipped: 1 });
    expect(JSON.parse((await rowOf('1', DAY)).mark_before)).toEqual({ streak: 4, freezes: 1, last: DAY - 4, skipped: 1 });
  });

  // spec: add-daily-ritual › Streak rule › питомец спал × yesterday is not closed yet
  it('waits while yesterday is not closed, and then counts the night with nothing available as skipped, not missed', async () => {
    // the last mark was on DAY - 2; DAY - 1 had no riddle and no entry for the pet: the close excuses it
    await pet('1', { streak: 3, freezes: 1, last: DAY - 2 });
    await env.DB.exec(`UPDATE ritual_clock SET closed_day = ${DAY - 2}`);
    await ended('1', DAY);
    at(0, 0, 30);
    // the ritual of the new day ended before the cron closed the old one
    expect(await writeDueMark(env, '1')).toBe('waiting');
    expect(sends()).toEqual([]);
    expect(await rowOf('1', DAY)).toMatchObject({ marked_at: null, sending_at: null, excused: 0 });
    // the cron's own tick: it closes yesterday first, the mark follows a minute on
    await closeDays(env, at(0, 1));
    expect(await rowOf('1', DAY - 1)).toMatchObject({ excused: 1 });
    expect(await writeDueMark(env, '1')).toBe('written');
    expect(sends()[0]!.args).toEqual({ token_id: '1', day: DAY, skipped: 1 });
    expect(chainPet('1')).toMatchObject({ streak: 4, freezes: 1, last_streak_day: DAY });
    expect(h.events().some((e) => e.name === 'streak_frozen' || e.name === 'streak_reset')).toBe(false);
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию × events when the mark lands
  it('fires streak_frozen once per covered day when the mark lands, and not before', async () => {
    await pet('1', { streak: 3, freezes: 2, last: DAY - 3 });
    await ended('1', DAY);
    at(9, 0);
    h.net().contract.mode = 'executed-but-silent';
    expect(await writeDueMark(env, '1')).toBe('failed');
    // the transaction ran and nobody heard: the events wait for the writer that learns it landed
    expect(h.events().filter((e) => e.name === 'streak_frozen')).toHaveLength(0);
    expect(marks()).toHaveLength(1);
    h.net().contract.mode = 'normal';
    expect(await writeDueMark(env, '1')).toBe('found');
    expect(h.events().filter((e) => e.name === 'streak_frozen')).toHaveLength(2);
    expect(h.events().some((e) => e.name === 'streak_reset')).toBe(false);
    // a third look finds nothing to do: the events came once
    expect(await writeDueMark(env, '1')).toBe('idle');
    expect(h.events().filter((e) => e.name === 'streak_frozen')).toHaveLength(2);
    expect(chainPet('1')).toMatchObject({ streak: 4, freezes: 0, last_streak_day: DAY });
  });

  // spec: add-daily-ritual › Streak rule › серия началась заново × events when the mark lands
  it('fires streak_reset with the length of the last streak when the mark lands over more misses than freezes', async () => {
    await pet('1', { streak: 5, freezes: 1, last: DAY - 4 });
    await ended('1', DAY);
    at(9, 0);
    expect(await writeDueMark(env, '1')).toBe('written');
    expect(h.events().filter((e) => e.name === 'streak_reset')).toEqual([{ name: 'streak_reset', props: { last_days: 5 } }]);
    expect(h.events().some((e) => e.name === 'streak_frozen')).toBe(false);
    expect(chainPet('1')).toMatchObject({ streak: 1, freezes: 0 });
  });

  // spec: add-daily-ritual › Streak rule › серия началась заново × the first mark after a gift brings the lines back
  it('ends the quiet of a gifted pet with the first mark after the gift, and not with a mark that failed', async () => {
    await pet('1', { streak: 2, freezes: 1, last: DAY - 1 }, { gifted: 1 });
    await ended('1', DAY);
    at(9, 0);
    h.net().contract.markFails = 'bad_day';
    expect(await writeDueMark(env, '1')).toBe('failed');
    expect((await env.DB.prepare("SELECT gifted_unmarked AS g FROM pets WHERE token_id = '1'").first<any>()).g).toBe(1);
    h.net().contract.markFails = null;
    expect(await writeDueMark(env, '1')).toBe('written');
    expect((await env.DB.prepare("SELECT gifted_unmarked AS g FROM pets WHERE token_id = '1'").first<any>()).g).toBe(0);
  });

  // spec: add-daily-ritual › Streak rule › серия записана позже × the outcome was lost
  it('reads the chain before it sends again, so a mark whose answer was lost is found and not sent twice', async () => {
    await pet('1');
    await ended('1', DAY);
    at(9, 0);
    h.net().contract.mode = 'executed-but-silent';
    expect(await writeDueMark(env, '1')).toBe('failed');
    expect(h.logs()).toContain('streak_unknown');
    expect(await rowOf('1', DAY)).toMatchObject({ marked_at: null, sending_at: null });
    h.net().contract.mode = 'normal';
    expect(await writeDueMark(env, '1')).toBe('found');
    expect(marks()).toHaveLength(1);
    expect(sends()).toHaveLength(1);
    expect(await rowOf('1', DAY)).toMatchObject({ marked_at: Date.now() });
  });

  it('sends nothing for a mark that is refused, and tries again with the chain read first', async () => {
    await pet('1');
    await ended('1', DAY);
    at(9, 0);
    h.net().contract.markFails = 'too_many_skipped';
    expect(await writeDueMark(env, '1')).toBe('failed');
    expect(h.logs()).toContain('streak_failed:too_many_skipped');
    expect(await rowOf('1', DAY)).toMatchObject({ marked_at: null, sending_at: null });
    h.net().contract.markFails = null;
    expect(await writeDueMark(env, '1')).toBe('written');
  });

  // spec: add-daily-ritual › Streak rule › серия записана позже × the Worker's day ahead of the chain
  it("is released while the Worker's clock is ahead of the chain's, and sent a minute on", async () => {
    await pet('1');
    await ended('1', DAY);
    at(0, 0, 3);
    h.net().contract.dayOverride = DAY - 1;
    expect(await writeDueMark(env, '1')).toBe('waiting');
    expect(sends()).toEqual([]);
    expect(await rowOf('1', DAY)).toMatchObject({ marked_at: null, sending_at: null });
    h.net().contract.dayOverride = null;
    at(0, 1);
    expect(await writeDueMark(env, '1')).toBe('written');
    expect(sends()).toHaveLength(1);
  });

  // spec: add-daily-ritual › Streak rule › серия записана позже × gas pause
  it('waits on a gas pause and goes when it lifts', async () => {
    await pet('1');
    await ended('1', DAY);
    at(9, 0);
    await setPause(env.DB, 'gas', Date.now());
    expect(await writeDueMark(env, '1')).toBe('paused');
    expect(sends()).toEqual([]);
    await env.DB.exec('UPDATE service_pause SET reason = NULL');
    expect(await writeDueMark(env, '1')).toBe('written');
  });

  // spec: add-daily-ritual › Streak rule › серия записана позже × AI pause
  it('is not stopped by the pause of NEAR AI', async () => {
    await pet('1');
    await ended('1', DAY);
    at(9, 0);
    await setPause(env.DB, 'ai', Date.now());
    expect(await writeDueMark(env, '1')).toBe('written');
    expect(marks()).toHaveLength(1);
  });

  // spec: add-daily-ritual › Streak rule › день не записан
  it('excuses a day the mark could not reach before the end of the next day, and sends nothing for it', async () => {
    await pet('1', { streak: 3, freezes: 1, last: DAY - 5 });
    await ended('1', DAY - 3);
    await ended('1', DAY);
    at(9, 0);
    // the call writes off the old day and goes on to the next
    expect(await writeDueMark(env, '1')).toBe('excused');
    // DAY - 3 is older than yesterday: it goes into `skipped` of the next mark and is never sent
    expect(await rowOf('1', DAY - 3)).toBeNull();
    expect(sends().map((s) => s.args.day)).toEqual([DAY]);
    expect(sends()[0]!.args.skipped).toBe(1);
    expect(h.logs()).toContain('streak_lost');
  });

  it('leaves an excused day that was completed alone: the close already wrote it off', async () => {
    await pet('1');
    await ended('1', DAY - 2, { excused: 1 });
    at(9, 0);
    expect(await writeDueMark(env, '1')).toBe('idle');
    expect(sends()).toEqual([]);
  });

  it('does not take a day while another writer holds it, and takes it when the claim is stale', async () => {
    await pet('1');
    await ended('1', DAY);
    at(9, 0);
    await env.DB.prepare('UPDATE ritual_days SET sending_at = ? WHERE token_id = ?').bind(Date.now() - 10_000, '1').run();
    expect(await writeDueMark(env, '1')).toBe('busy');
    expect(sends()).toEqual([]);
    await env.DB.prepare('UPDATE ritual_days SET sending_at = ? WHERE token_id = ?').bind(Date.now() - 61_000, '1').run();
    expect(await writeDueMark(env, '1')).toBe('written');
  });

  it('is released when the chain cannot be read, and sends nothing', async () => {
    await pet('1');
    await ended('1', DAY);
    at(9, 0);
    h.net().contract.failingViews.add('pet_view');
    expect(await writeDueMark(env, '1')).toBe('unreadable');
    expect(h.logs()).toContain('streak_unreadable');
    expect(await rowOf('1', DAY)).toMatchObject({ sending_at: null });
    expect(sends()).toEqual([]);
  });

  it('writes up to 20 pets in a tick, the ones looked at longest ago first', async () => {
    for (let i = 0; i < 25; i += 1) {
      await pet(String(i));
      await ended(String(i), DAY);
    }
    const now = at(9, 0);
    await markDueDays(env, now);
    expect(sends()).toHaveLength(20);
    await ritual(env, at(9, 1));
    expect(sends()).toHaveLength(25);
  });
});
