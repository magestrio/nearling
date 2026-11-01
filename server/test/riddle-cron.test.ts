// The riddle of the day in the cron: the row, the commit that opens it, the reveal that closes it
// (`riddle/cron.ts`), the list it reads and the hash it files (`riddle/list.ts`, `riddle/hash.ts`).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../contract/tests/fixtures/riddle-hash.json';
import { clean, tick } from '../src/cron';
import { RIDDLE_COMMIT_TGAS } from '../src/chain';
import { riddleBytes, riddleHash } from '../src/riddle/hash';
import { parseRiddleList } from '../src/riddle/list';
import { clearPause, setPause } from '../src/servicePause';
import { riddleTick } from '../src/riddle/cron';
import { harness } from './helpers/api';

const h = harness();
beforeEach(() => h.net().contract.fundRiddles());
const DAY =Math.floor(Date.UTC(2036, 10, 4) / 86_400_000);
const DAY_MS = 86_400_000;
/** The time `hh:mm:ss` of the UTC day `day` (the clock of the Worker and of the fake chain alike). */
const at = (hh: number, mm: number, ss = 0, day = DAY) => {
  const t = day * DAY_MS + ((hh * 60 + mm) * 60 + ss) * 1000;
  vi.setSystemTime(t);
  return t;
};
const row = (day = DAY) => env.DB.prepare('SELECT * FROM riddles WHERE day = ?').bind(day).first<any>();
const sentMethods = () => h.net().contract.sends.map((s) => s.method);
const LIST = JSON.parse(env.RIDDLE_LIST) as { text: string; answers: string[] }[];
const hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('the hash the contract files', () => {
  // spec: add-daily-ritual › Riddle commit contract › коммит записан × the hash on the Worker
  it('is the sha256 of the borsh bytes the contract hashes, on the vector both sides read', async () => {
    const bytes = riddleBytes(fixture.day, fixture.riddle, fixture.answers, fixture.salt);
    expect([...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(fixture.bytes_hex);
    expect(await riddleHash(fixture.day, fixture.riddle, fixture.answers, fixture.salt)).toBe(fixture.hash);
  });

  // spec: add-daily-ritual › Riddle commit contract › коммит записан × the hash on the Worker
  it('does not make "ab" + "c" the same as "a" + "bc"', async () => {
    expect(await riddleHash(1, 'x', ['ab', 'c'], 's')).not.toBe(await riddleHash(1, 'x', ['a', 'bc'], 's'));
    expect(await riddleHash(1, 'x', ['a'], 's')).not.toBe(await riddleHash(2, 'x', ['a'], 's'));
    expect(hex('é')).toBe('c3a9');
  });
});

describe('the list of riddles', () => {
  // spec: add-daily-ritual › Riddle rule › загадка ещё не запечатана × a bad list
  it('is parsed when every riddle has a text and at least one answer, and refused otherwise', () => {
    expect(parseRiddleList(env.RIDDLE_LIST)).toHaveLength(3);
    for (const bad of [undefined, '', 'nope', '{}', '[]', '[{"text":"a"}]', '[{"text":"","answers":["x"]}]', '[{"text":"a","answers":[]}]', '[{"text":"a","answers":[1]}]', '[null]']) {
      expect(parseRiddleList(bad), String(bad)).toBeNull();
    }
  });
});

describe('the commit', () => {
  // spec: add-daily-ritual › Riddle commit contract › коммит записан × the server opens it
  it('is made by the first tick of the day: one row with the riddle, its salt and its hash, and the riddle opens once the commit is on chain', async () => {
    at(0, 1);
    await tick(env, at(0, 1));
    const r = await row();
    expect(r.text).toBe(LIST[DAY % 3]!.text);
    expect(JSON.parse(r.answers)).toEqual(LIST[DAY % 3]!.answers);
    expect(r.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(r.hash).toBe(await riddleHash(DAY, r.text, JSON.parse(r.answers), r.salt));
    expect(r.sealed_at).toBe(at(0, 1));
    expect(r.revealed_at).toBeNull();
    // the chain holds the hash of the row, filed under the day of its clock
    expect(h.net().contract.commits).toEqual([{ day: DAY, hash: r.hash }]);
    expect(h.net().contract.sends.at(-1)).toMatchObject({ method: 'riddle_commit', args: { hash: r.hash }, gas: (RIDDLE_COMMIT_TGAS * 10n ** 12n).toString() });
    expect(h.logs()).toContain('riddle_sealed');
    // the next minute sends nothing, and the salt and hash stay as they were
    await tick(env, at(0, 2));
    expect(sentMethods()).toEqual(['riddle_commit']);
    expect(await row()).toEqual(r);
  });

  // spec: add-daily-ritual › Riddle commit contract › коммит записан × the server opens it
  it('puts the gas the commit burnt into the project\'s spend', async () => {
    at(0, 1);
    h.net().contract.burnt = '4500000000000000000000';
    await riddleTick(env, at(0, 1));
    const spend = await env.DB.prepare("SELECT kind, usd_micros FROM project_spend").all<any>();
    expect(spend.results).toHaveLength(1);
    expect(spend.results[0].kind).toBe('gas');
    expect(spend.results[0].usd_micros).toBeGreaterThan(0);
  });

  // spec: add-daily-ritual › Riddle rule › загадка ещё не запечатана
  it('does not open while the network cannot be read, and opens at the next minute', async () => {
    at(0, 1);
    h.net().contract.down = true;
    await tick(env, at(0, 1));
    expect((await row()).sealed_at).toBeNull();
    expect(h.logs()).toContain('riddle_unreadable');
    expect(h.net().contract.commits).toEqual([]);
    h.net().contract.down = false;
    await tick(env, at(0, 2));
    expect((await row()).sealed_at).toBe(at(0, 2));
  });

  // spec: add-daily-ritual › Riddle rule › загадка ещё не запечатана × gas pause
  it('waits for the gas pause and goes when it lifts', async () => {
    at(0, 1);
    await setPause(env.DB, 'gas', at(0, 0));
    await riddleTick(env, at(0, 1));
    expect(sentMethods()).toEqual([]);
    expect(await row()).toBeNull();
    await clearPause(env.DB);
    await riddleTick(env, at(0, 2));
    expect(sentMethods()).toEqual(['riddle_commit']);
    expect((await row()).sealed_at).not.toBeNull();
  });

  // spec: add-daily-ritual › Riddle rule › загадка ещё не запечатана × AI pause
  it('goes on the pause of NEAR AI, which does not stop it', async () => {
    at(0, 1);
    await setPause(env.DB, 'ai', at(0, 0));
    await riddleTick(env, at(0, 1));
    expect(sentMethods()).toEqual(['riddle_commit']);
    expect((await row()).sealed_at).not.toBeNull();
  });

  // spec: add-daily-ritual › Riddle rule › загадка ещё не запечатана × a bad list
  it('opens no riddle from a list that does not parse, and says so in a log line', async () => {
    at(0, 1);
    const vars = env as { RIDDLE_LIST: string };
    const list = vars.RIDDLE_LIST;
    vars.RIDDLE_LIST = '[{"text":"no answers"}]';
    try {
      await tick(env, at(0, 1));
      await tick(env, at(0, 2));
    } finally {
      vars.RIDDLE_LIST = list;
    }
    expect(await row()).toBeNull();
    expect(sentMethods()).toEqual([]);
    expect(h.logs().filter((l) => l === 'riddle_list_bad')).toHaveLength(2);
    // the list put right: the riddle opens
    await tick(env, at(0, 3));
    expect((await row()).sealed_at).not.toBeNull();
  });

  // spec: add-daily-ritual › Riddle commit contract › коммит записан × the outcome was lost
  it('finds a commit whose answer was lost on the chain and sends none again', async () => {
    at(0, 1);
    h.net().contract.mode = 'executed-but-silent';
    await riddleTick(env, at(0, 1));
    const lost = await row();
    expect(lost.sealed_at).toBeNull();
    expect(h.net().contract.commits).toHaveLength(1);
    h.net().contract.mode = 'normal';
    await riddleTick(env, at(0, 2));
    expect((await row()).sealed_at).toBe(at(0, 2));
    expect(sentMethods()).toEqual(['riddle_commit']);
    expect(h.net().contract.commits).toEqual([{ day: DAY, hash: lost.hash }]);
  });

  // spec: add-daily-ritual › Riddle commit contract › коммит записан × the chain's day behind the Worker's
  it('waits while the chain is still on the day before, sending nothing', async () => {
    at(0, 0, 10);
    h.net().contract.dayOverride = DAY - 1;
    await riddleTick(env, at(0, 0, 10));
    expect(sentMethods()).toEqual([]);
    expect((await row()).sealed_at).toBeNull();
    h.net().contract.dayOverride = null;
    await riddleTick(env, at(0, 1, 10));
    expect(sentMethods()).toEqual(['riddle_commit']);
    expect(h.net().contract.commits[0]!.day).toBe(DAY);
  });

  // spec: add-daily-ritual › Riddle commit contract › коммит записан × last two minutes of the day
  it('sends none in the last two minutes of the day, and that day\'s riddle stays held up', async () => {
    at(23, 57, 59);
    await riddleTick(env, at(23, 57, 59));
    expect(sentMethods()).toEqual(['riddle_commit']);
    h.net().contract.commits.length = 0;
    h.net().contract.riddleCommits.clear();
    await env.DB.exec('DELETE FROM riddles');
    await riddleTick(env, at(23, 58, 0));
    await riddleTick(env, at(23, 59, 30));
    expect(sentMethods()).toEqual(['riddle_commit']);
    expect((await row()).sealed_at).toBeNull();
    // the new day: its own riddle
    await riddleTick(env, at(0, 0, 30, DAY + 1));
    expect((await row(DAY + 1)).sealed_at).not.toBeNull();
  });

  // spec: add-daily-ritual › Riddle commit contract › второй коммит за сутки × a foreign hash
  it('closes the day when another hash was filed first, and sends no more that day', async () => {
    at(0, 1);
    h.net().contract.riddleCommits.set(DAY, 'ff'.repeat(32));
    await riddleTick(env, at(0, 1));
    expect((await row()).foreign_hash).toBe(1);
    expect((await row()).sealed_at).toBeNull();
    expect(h.logs()).toContain('riddle_foreign');
    await riddleTick(env, at(0, 2));
    await riddleTick(env, at(12, 0));
    expect(sentMethods()).toEqual([]);
    // nothing to reveal for that day either
    await riddleTick(env, at(0, 5, 0, DAY + 1));
    expect(sentMethods()).toEqual(['riddle_commit']);
    expect((await row(DAY + 1)).sealed_at).not.toBeNull();
  });

  // spec: add-daily-ritual › Riddle commit contract › запас хранилища пуст × no send, no gas
  it('sends nothing and burns no gas while the reserve cannot pay a commit, and opens when it is filled', async () => {
    at(0, 1);
    h.net().contract.riddleReserve = 100n;
    await riddleTick(env, at(0, 1));
    await riddleTick(env, at(0, 2));
    expect(sentMethods()).toEqual([]);
    expect(h.logs().filter((l) => l === 'riddle_reserve_low')).toHaveLength(2);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM project_spend').first<any>()).n).toBe(0);
    expect((await row()).sealed_at).toBeNull();
    h.net().contract.fundRiddles();
    await riddleTick(env, at(0, 3));
    expect((await row()).sealed_at).not.toBeNull();
  });

  // spec: add-daily-ritual › Riddle commit contract › запас хранилища пуст × no send, no gas
  it('reads a refusal of the contract for a reserve that emptied between the read and the send as the same wait', async () => {
    at(0, 1);
    h.net().contract.commitFails = 'reserve_empty';
    await riddleTick(env, at(0, 1));
    expect((await row()).sealed_at).toBeNull();
    expect(h.logs()).toContain('riddle_reserve_low');
    h.net().contract.commitFails = null;
    await riddleTick(env, at(0, 2));
    expect((await row()).sealed_at).not.toBeNull();
  });
});

describe('the reveal', () => {
  /** The riddle of DAY sealed at 00:01. */
  async function sealed() {
    await riddleTick(env, at(0, 1));
    return (await row())!;
  }

  // spec: add-daily-ritual › Riddle reveal contract › раскрытие записано × the cron sends it, the salt goes
  it('is sent after the day with the riddle, its answers and its salt, and the salt is cleared', async () => {
    const r = await sealed();
    // during the day nothing is revealed
    await riddleTick(env, at(18, 0));
    expect(sentMethods()).toEqual(['riddle_commit']);
    await riddleTick(env, at(0, 1, 0, DAY + 1));
    expect(sentMethods()).toEqual(['riddle_commit', 'riddle_commit', 'riddle_reveal']);
    expect(h.net().contract.reveals).toEqual([{ day: DAY, riddle: r.text, answers: JSON.parse(r.answers), salt: r.salt }]);
    const done = await row();
    expect(done.revealed_at).toBe(at(0, 1, 0, DAY + 1));
    expect(done.salt).toBeNull();
    expect(h.logs()).toContain('riddle_revealed');
    // the commit left the chain and is not sent again
    expect(h.net().contract.riddleCommits.has(DAY)).toBe(false);
    await riddleTick(env, at(0, 2, 0, DAY + 1));
    expect(sentMethods().filter((m) => m === 'riddle_reveal')).toHaveLength(1);
  });

  // spec: add-daily-ritual › Riddle reveal contract › раскрытие записано × the cron sends it, the salt goes
  it('waits for the gas pause, and for a chain that has not reached the next day', async () => {
    await sealed();
    await setPause(env.DB, 'gas', at(0, 0, 0, DAY + 1));
    await riddleTick(env, at(0, 1, 0, DAY + 1));
    expect(sentMethods().filter((m) => m === 'riddle_reveal')).toEqual([]);
    await clearPause(env.DB);
    // the Worker's clock is ahead: the contract refuses, nothing changes, the claim is released
    h.net().contract.dayOverride = DAY;
    await riddleTick(env, at(0, 2, 0, DAY + 1));
    expect((await row()).revealed_at).toBeNull();
    expect(h.logs()).toContain('reveal_failed:reveal_too_early');
    h.net().contract.dayOverride = null;
    await riddleTick(env, at(0, 3, 0, DAY + 1));
    expect((await row()).revealed_at).not.toBeNull();
  });

  // spec: add-daily-ritual › Riddle reveal contract › раскрытие записано × the outcome was lost
  it('finds a reveal whose answer was lost on the chain and sends none again', async () => {
    await sealed();
    h.net().contract.mode = 'executed-but-silent';
    await riddleTick(env, at(0, 1, 0, DAY + 1));
    expect((await row()).revealed_at).toBeNull();
    expect(h.net().contract.reveals).toHaveLength(1);
    h.net().contract.mode = 'normal';
    await riddleTick(env, at(0, 2, 0, DAY + 1));
    expect((await row()).revealed_at).not.toBeNull();
    expect((await row()).salt).toBeNull();
    expect(sentMethods().filter((m) => m === 'riddle_reveal')).toHaveLength(1);
  });

  // spec: add-daily-ritual › Riddle reveal contract › раскрытие записано × the cron sends it, the salt goes
  it('reveals the oldest days first, three a tick', async () => {
    // five past days, sealed and never revealed (the gas pause held the reveals up for days)
    for (let d = 5; d >= 1; d -= 1) {
      const day = DAY - d;
      const hash = await riddleHash(day, 'r', ['a'], 's');
      await env.DB.prepare('INSERT INTO riddles (day, text, answers, salt, hash, sealed_at) VALUES (?, ?, ?, ?, ?, 1)').bind(day, 'r', '["a"]', 's', hash).run();
      h.net().contract.riddleCommits.set(day, hash);
    }
    await riddleTick(env, at(12, 0));
    expect(h.net().contract.reveals.map((r) => r.day)).toEqual([DAY - 5, DAY - 4, DAY - 3]);
    await riddleTick(env, at(12, 1));
    expect(h.net().contract.reveals.map((r) => r.day)).toEqual([DAY - 5, DAY - 4, DAY - 3, DAY - 2, DAY - 1]);
  });
});

describe('retention', () => {
  // spec: add-daily-ritual › Riddle rule › ответ ещё не раскрыт × retention
  it('deletes the answers of days before yesterday and a revealed riddle after the next day, never one that was not revealed', async () => {
    const now = at(10, 0);
    const riddle = (day: number, revealed: boolean) =>
      env.DB.prepare('INSERT INTO riddles (day, text, answers, salt, hash, sealed_at, revealed_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(day, 'r', '["a"]', revealed ? null : 's', 'h', 1, revealed ? 2 : null).run();
    await riddle(DAY - 3, false);
    await riddle(DAY - 2, true);
    await riddle(DAY - 1, true);
    await riddle(DAY, false);
    for (const day of [DAY - 2, DAY - 1, DAY]) {
      await env.DB.prepare('INSERT INTO riddle_answers (token_id, day, text, correct, answered_at) VALUES (?, ?, ?, 1, 1)').bind('7', day, 'a clock').run();
    }
    await clean(env, now);
    expect((await env.DB.prepare('SELECT day FROM riddles ORDER BY day').all<any>()).results.map((r) => r.day)).toEqual([DAY - 3, DAY - 1, DAY]);
    expect((await env.DB.prepare('SELECT day FROM riddle_answers ORDER BY day').all<any>()).results.map((r) => r.day)).toEqual([DAY - 1, DAY]);
  });
});
