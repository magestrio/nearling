// The riddle of the day in the cron part `riddle` (ADR-009): the row of today with its salt and hash,
// the commit that seals it on chain (the riddle opens only after that), and the reveal of the riddles
// of past days. Each send follows ADR-008: the chain is read before a transaction is signed, so a send
// whose outcome was lost is found there and never sent twice.
import { chainDay, ChainUnreachable, RIDDLE_COMMIT_TGAS, RIDDLE_REVEAL_TGAS, riddleView } from '../chain';
import { utcDay } from '../http';
import { nearUsdRate, yoctoToUsdMicros } from '../pricing';
import { isPaused } from '../servicePause';
import { riddleHash } from './hash';
import { parseRiddleList, riddleOf } from './list';

/** A claim older than this belongs to a sender that is gone: 25 s of send and two 8 s reads, with room. */
export const RIDDLE_CLAIM_STALE_MS = 60_000;
/** No commit is sent in the last 120 seconds of a day: the send takes up to 25 s and the nonce retries
 * more, and a hash for day D filed under D+1 could never be revealed. */
export const COMMIT_CUTOFF_MS = 120_000;
/** At most this many reveals are sent in a tick, the oldest day first. */
export const REVEALS_PER_TICK = 3;

const TGAS = 1_000_000_000_000n;

interface RiddleRow {
  day: number;
  text: string;
  answers: string;
  salt: string | null;
  hash: string;
  sealed_at: number | null;
  foreign_hash: number;
}

const randomSalt = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The part of the minute: the commit of today, then the reveals. Gas pause: neither is sent. */
export async function riddleTick(env: Env, nowMs: number): Promise<void> {
  if (await isPaused(env.DB, 'riddle')) return;
  await commitToday(env, nowMs);
  await revealPast(env, nowMs);
}

/** The row of today, made once by the first tick of the day (`INSERT OR IGNORE`: two ticks make one). A
 * list that is bad makes no row. */
async function rowOfToday(env: Env, day: number): Promise<RiddleRow | null> {
  const select = () => env.DB.prepare('SELECT day, text, answers, salt, hash, sealed_at, foreign_hash FROM riddles WHERE day = ?').bind(day).first<RiddleRow>();
  const existing = await select();
  if (existing !== null) return existing;
  const list = parseRiddleList(env.RIDDLE_LIST);
  if (list === null) {
    console.log('riddle_list_bad');
    return null;
  }
  const riddle = riddleOf(list, day);
  const salt = randomSalt();
  const hash = await riddleHash(day, riddle.text, riddle.answers, salt);
  await env.DB.prepare('INSERT OR IGNORE INTO riddles (day, text, answers, salt, hash) VALUES (?, ?, ?, ?, ?)').bind(day, riddle.text, JSON.stringify(riddle.answers), salt, hash).run();
  return select();
}

async function commitToday(env: Env, nowMs: number): Promise<void> {
  const day = utcDay(nowMs);
  const row = await rowOfToday(env, day);
  if (row === null || row.sealed_at !== null || row.foreign_hash === 1) return;
  if (nowMs >= (day + 1) * 86_400_000 - COMMIT_CUTOFF_MS) return;

  const claim = await env.DB.prepare('UPDATE riddles SET claim_at = ?2 WHERE day = ?1 AND sealed_at IS NULL AND foreign_hash = 0 AND (claim_at IS NULL OR claim_at < ?3) RETURNING day')
    .bind(day, nowMs, nowMs - RIDDLE_CLAIM_STALE_MS)
    .first();
  if (claim === null) return;
  const release = () => env.DB.prepare('UPDATE riddles SET claim_at = NULL WHERE day = ? AND sealed_at IS NULL').bind(day).run();

  try {
    // The chain's day decides: blocks only move forward, so a send after this read cannot land a day early.
    if ((await chainDay(env)) !== day) {
      await release();
      return;
    }
    const seen = await riddleView(env, day);
    if (seen.hash !== null) {
      if (seen.hash === row.hash) {
        await seal(env, day, nowMs, null);
      } else {
        await env.DB.prepare('UPDATE riddles SET foreign_hash = 1, claim_at = NULL WHERE day = ?').bind(day).run();
        console.log('riddle_foreign');
      }
      return;
    }
    if (BigInt(seen.reserve) < BigInt(seen.commit_cost)) {
      await release();
      console.log('riddle_reserve_low');
      return;
    }
    const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
      methodName: 'riddle_commit',
      args: { hash: row.hash },
      gas: (RIDDLE_COMMIT_TGAS * TGAS).toString(),
    });
    if (answer.status === 'ok') {
      await seal(env, day, nowMs, answer.burnt ?? null);
      return;
    }
    // A refusal, an unreachable network or an outcome nobody heard: the next attempt reads the chain
    // first, so a commit that did land is found there.
    await release();
    if (answer.status === 'failed' && answer.code === 'reserve_empty') console.log('riddle_reserve_low');
    else console.log(answer.status === 'unknown' ? 'riddle_unknown' : `riddle_failed:${answer.status === 'failed' ? answer.code : 'unreachable'}`);
  } catch (e) {
    if (!(e instanceof ChainUnreachable)) throw e;
    await release();
    console.log('riddle_unreadable');
  }
}

/** The riddle opens: the commit is on chain. Once. */
async function seal(env: Env, day: number, nowMs: number, burnt: string | null): Promise<void> {
  const sealed = await env.DB.prepare('UPDATE riddles SET sealed_at = ?2, claim_at = NULL WHERE day = ?1 AND sealed_at IS NULL RETURNING day').bind(day, nowMs).first();
  if (sealed === null) return;
  console.log('riddle_sealed');
  await payGas(env, nowMs, burnt);
}

/** The reveals of sealed rows of past days, oldest first. A riddle whose commit is no longer on chain
 * was revealed by a send whose answer was lost: it is finished, nothing is sent. */
async function revealPast(env: Env, nowMs: number): Promise<void> {
  const rows = await env.DB.prepare('SELECT day, text, answers, salt, hash, sealed_at, foreign_hash FROM riddles WHERE sealed_at IS NOT NULL AND revealed_at IS NULL AND day < ? ORDER BY day LIMIT ?')
    .bind(utcDay(nowMs), REVEALS_PER_TICK)
    .all<RiddleRow>();
  for (const row of rows.results) {
    const claim = await env.DB.prepare('UPDATE riddles SET reveal_claim_at = ?2 WHERE day = ?1 AND revealed_at IS NULL AND (reveal_claim_at IS NULL OR reveal_claim_at < ?3) RETURNING day')
      .bind(row.day, nowMs, nowMs - RIDDLE_CLAIM_STALE_MS)
      .first();
    if (claim === null) continue;
    const release = () => env.DB.prepare('UPDATE riddles SET reveal_claim_at = NULL WHERE day = ? AND revealed_at IS NULL').bind(row.day).run();
    try {
      const seen = await riddleView(env, row.day);
      if (seen.hash === null) {
        await finishReveal(env, row.day, nowMs, null);
        continue;
      }
      const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
        methodName: 'riddle_reveal',
        args: { day: row.day, riddle: row.text, answers: JSON.parse(row.answers) as string[], salt: row.salt },
        gas: (RIDDLE_REVEAL_TGAS * TGAS).toString(),
      });
      if (answer.status === 'ok') {
        await finishReveal(env, row.day, nowMs, answer.burnt ?? null);
        continue;
      }
      await release();
      console.log(answer.status === 'unknown' ? 'reveal_unknown' : `reveal_failed:${answer.status === 'failed' ? answer.code : 'unreachable'}`);
    } catch (e) {
      if (!(e instanceof ChainUnreachable)) throw e;
      await release();
      console.log('riddle_unreadable');
    }
  }
}

/** The riddle is revealed: the verdicts may be read, and the salt goes (§8 › Хранение: «соль — до
 * раскрытия»). The one place that knows a riddle has been revealed; `add-wardrobe` reads each owner's
 * `riddle_answers.correct` for the riddle's item from here. Once. */
export async function finishReveal(env: Env, day: number, nowMs: number, burnt: string | null): Promise<void> {
  const done = await env.DB.prepare('UPDATE riddles SET revealed_at = ?2, salt = NULL, reveal_claim_at = NULL WHERE day = ?1 AND revealed_at IS NULL RETURNING day').bind(day, nowMs).first();
  if (done === null) return;
  console.log('riddle_revealed');
  await payGas(env, nowMs, burnt);
}

/** The gas a send burned goes to the project's spend, as a stage change's does. */
async function payGas(env: Env, nowMs: number, burnt: string | null): Promise<void> {
  if (burnt === null) return;
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  if (rate === null) {
    console.log('rate_missing');
    return;
  }
  await env.DB.prepare('INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, ?, ?)').bind(nowMs, 'gas', yoctoToUsdMicros(BigInt(burnt), rate)).run();
}
