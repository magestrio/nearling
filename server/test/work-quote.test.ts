// A worker's price and its places (`add-pet-work` › `Hire quote data`, `Hire price rule`), at the module that
// holds them: the later stages call `hold`, `answered` and `release`, and these tests hold the numbers they stand on.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { utcDay } from '../src/http';
import { HIRE_AUTO_LIMIT_YOCTO, HIRE_FEE_MAX_YOCTO, HIRE_FEE_MIN_YOCTO, HIRE_FEE_STEP_YOCTO, MAX_JOBS_PER_DAY, workerPrice } from '../src/pricing';
import { clean } from '../src/cron';
import { answered, hold, priceOf, release, STALE_HELD_MS } from '../src/work/quote';
import { harness } from './helpers/api';

const h = harness();
const WORKER = '31';
const HIGH = 10n ** 30n;
const day = () => utcDay(Date.now());
const now = () => Date.now();

async function saveSkill(tokenId = WORKER): Promise<void> {
  await env.DB.prepare("INSERT INTO skills (token_id, label, ct, iv, updated_at) VALUES (?, 'sums', X'00', X'00', 0)").bind(tokenId).run();
}
async function counts(tokenId = WORKER, d = day()): Promise<{ n: number; held: number } | null> {
  return env.DB.prepare('SELECT n, held FROM worker_answers WHERE token_id = ? AND day = ?').bind(tokenId, d).first<{ n: number; held: number }>();
}
/** One answer that reached the asker: a place held and turned into an answer. */
async function answer(tokenId = WORKER): Promise<void> {
  const taken = await hold(env, tokenId, day(), HIGH, now());
  expect(taken.ok).toBe(true);
  await answered(env, tokenId, day());
}

describe('Hire quote data', () => {
  // spec: add-pet-work › Hire quote data › no answer
  it('gives the place back when the call ends with nothing shown: the count and the price stay, a failed call raises nobody\'s price', async () => {
    await saveSkill();
    await answer();
    const before = await priceOf(env, WORKER, day());
    expect(before).toEqual({ yocto: HIRE_FEE_MIN_YOCTO + HIRE_FEE_STEP_YOCTO, count: 1, open: true });

    const taken = await hold(env, WORKER, day(), HIGH, now());
    expect(taken).toEqual({ ok: true, fee: before.yocto });
    // while the call is on its way the next asker already meets the higher price
    expect((await priceOf(env, WORKER, day())).yocto).toBe(HIRE_FEE_MIN_YOCTO + 2n * HIRE_FEE_STEP_YOCTO);
    await release(env, WORKER, day());
    expect(await priceOf(env, WORKER, day())).toEqual(before);
    expect(await counts()).toEqual({ n: 1, held: 0 });
    // a second release of the same place, or one with nothing held, never takes an answer back
    await release(env, WORKER, day());
    expect(await counts()).toEqual({ n: 1, held: 0 });
  });

  // spec: add-pet-work › Hire quote data › hire record rejected
  it('keeps the count when the hire is later dropped: the worker did answer, no price already quoted is taken back', async () => {
    await saveSkill();
    await answer();
    await answer();
    const quoted = await priceOf(env, WORKER, day());
    // the resend without the hire marks the hire row dropped (stage 9); the day's count is not read from it
    await env.DB.prepare("INSERT INTO hires (id, hirer_id, worker_id, worker_name, kind, fee_yocto, fee_usd_micros, status, created_at) VALUES ('h1', '5', ?, 'Pixel', 'pet', ?, 0, 'dropped', 0)")
      .bind(WORKER, quoted.yocto.toString())
      .run();
    expect(await priceOf(env, WORKER, day())).toEqual(quoted);
    expect(await counts()).toEqual({ n: 2, held: 0 });
    // a late release can't turn an answer that reached the asker back into a free place
    await release(env, WORKER, day());
    expect(await counts()).toEqual({ n: 2, held: 0 });
  });

  // spec: add-pet-work › Hire quote data › shown price too low
  it('holds nothing and answers with its price when the ceiling is below the price, a skilled worker or not', async () => {
    await saveSkill();
    await answer();
    const price = (await priceOf(env, WORKER, day())).yocto;
    const refused = await hold(env, WORKER, day(), price - 1n, now());
    expect(refused).toEqual({ ok: false, price, open: true });
    expect(await counts()).toEqual({ n: 1, held: 0 });
    // a ceiling of exactly the price holds, at that price
    expect(await hold(env, WORKER, day(), price, now())).toEqual({ ok: true, fee: price });

    // a worker without a skill is the floor, and a ceiling under it is refused too
    const plain = '32';
    expect(await hold(env, plain, day(), HIRE_FEE_MIN_YOCTO - 1n, now())).toEqual({ ok: false, price: HIRE_FEE_MIN_YOCTO, open: true });
    expect(await counts(plain)).toEqual({ n: 0, held: 0 });
    expect(await hold(env, plain, day(), HIRE_FEE_MIN_YOCTO, now())).toEqual({ ok: true, fee: HIRE_FEE_MIN_YOCTO });
  });

  // spec: add-pet-work › Hire quote data › two askers at once
  it('lets the first of two askers at the same shown price hold the place; the second meets the higher price, and the price falls back if the first fails', async () => {
    await saveSkill();
    await answer();
    const shown = (await priceOf(env, WORKER, day())).yocto;
    const [first, second] = await Promise.all([hold(env, WORKER, day(), shown, now()), hold(env, WORKER, day(), shown, now())]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    const refused = first.ok ? second : first;
    expect(refused).toEqual({ ok: false, price: shown + HIRE_FEE_STEP_YOCTO, open: true });
    expect(await counts()).toEqual({ n: 1, held: 1 });

    await release(env, WORKER, day());
    expect(await hold(env, WORKER, day(), shown, now())).toEqual({ ok: true, fee: shown });
  });

  // spec: add-pet-work › Hire quote data › price rose during an Auto turn
  it('holds no place under the Auto limit once the price is above it', async () => {
    await saveSkill();
    await answer();
    await answer();
    // the third answer is the limit: floor + 2 steps
    expect(await hold(env, WORKER, day(), HIRE_AUTO_LIMIT_YOCTO, now())).toEqual({ ok: true, fee: HIRE_AUTO_LIMIT_YOCTO });
    await answered(env, WORKER, day());
    // the fourth is above it: no place, nothing held, the price now
    expect(await hold(env, WORKER, day(), HIRE_AUTO_LIMIT_YOCTO, now())).toEqual({ ok: false, price: HIRE_AUTO_LIMIT_YOCTO + HIRE_FEE_STEP_YOCTO, open: true });
    expect(await counts()).toEqual({ n: 3, held: 0 });
  });

  // spec: add-pet-work › Hire quote data › two askers at once × desk died
  it('clears a place left held by a desk that died after five minutes, and the days before yesterday', async () => {
    await saveSkill();
    expect((await hold(env, WORKER, day(), HIGH, now())).ok).toBe(true);
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n, held) VALUES (?, ?, 4, 0)').bind(WORKER, day() - 2).run();
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n, held) VALUES (?, ?, 4, 0)').bind(WORKER, day() - 1).run();
    await clean(env, now() + STALE_HELD_MS - 1);
    expect(await counts()).toEqual({ n: 0, held: 1 });
    await clean(env, now() + STALE_HELD_MS + 1);
    expect(await counts()).toEqual({ n: 0, held: 0 });
    expect(await counts(WORKER, day() - 2)).toBeNull();
    expect(await counts(WORKER, day() - 1)).toEqual({ n: 4, held: 0 });
  });
});

describe('Hire price rule', () => {
  // spec: add-pet-work › Hire price rule › price climbs
  it('raises the price by a step for the next asker with every answer of the day, those before the skill was saved too', async () => {
    // three answers before any skill: the floor each time
    for (let i = 0; i < 3; i += 1) {
      expect((await priceOf(env, WORKER, day())).yocto).toBe(HIRE_FEE_MIN_YOCTO);
      await answer();
    }
    expect((await priceOf(env, WORKER, day())).yocto).toBe(HIRE_FEE_MIN_YOCTO);
    // the skill is saved: those three already count
    await saveSkill();
    const quote = await priceOf(env, WORKER, day());
    expect(quote).toEqual({ yocto: workerPrice(true, 3), count: 3, open: true });
    expect(quote.yocto).toBe(HIRE_FEE_MIN_YOCTO + 3n * HIRE_FEE_STEP_YOCTO);
    // the fee of the next hire is the price when the place is held, and the one after it is a step higher
    expect(await hold(env, WORKER, day(), HIGH, now())).toEqual({ ok: true, fee: quote.yocto });
    expect((await priceOf(env, WORKER, day())).yocto).toBe(quote.yocto + HIRE_FEE_STEP_YOCTO);
    // a skill forgotten: back to the floor, the count stays (it is the day's answers)
    await env.DB.exec('DELETE FROM skills');
    expect(await priceOf(env, WORKER, day())).toEqual({ yocto: HIRE_FEE_MIN_YOCTO, count: 4, open: true });
  });

  // spec: add-pet-work › Hire price rule › price climbs
  it('tops out at the tenth answer, and a worker with ten answers and places is no worker', async () => {
    await saveSkill();
    for (let i = 0; i < MAX_JOBS_PER_DAY - 1; i += 1) await answer();
    expect((await priceOf(env, WORKER, day())).yocto).toBe(HIRE_FEE_MAX_YOCTO);
    // the tenth place, at the highest fee
    expect(await hold(env, WORKER, day(), HIRE_FEE_MAX_YOCTO, now())).toEqual({ ok: true, fee: HIRE_FEE_MAX_YOCTO });
    expect(await priceOf(env, WORKER, day())).toMatchObject({ count: MAX_JOBS_PER_DAY, open: false });
    // no eleventh place, whatever the ceiling
    expect(await hold(env, WORKER, day(), HIGH, now())).toMatchObject({ ok: false, open: false });
    expect(await counts()).toEqual({ n: MAX_JOBS_PER_DAY - 1, held: 1 });
  });

  // spec: add-pet-work › Hire price rule › new day
  it('starts a new UTC day at the floor, and pays the lower price for a ceiling set the day before', async () => {
    await saveSkill();
    for (let i = 0; i < 4; i += 1) await answer();
    const high = (await priceOf(env, WORKER, day())).yocto;
    expect(high).toBe(HIRE_FEE_MIN_YOCTO + 4n * HIRE_FEE_STEP_YOCTO);
    const tomorrow = day() + 1;
    expect(await priceOf(env, WORKER, tomorrow)).toEqual({ yocto: HIRE_FEE_MIN_YOCTO, count: 0, open: true });
    // a tap at the old higher price on screen pays the lower one
    expect(await hold(env, WORKER, tomorrow, high, now())).toEqual({ ok: true, fee: HIRE_FEE_MIN_YOCTO });
  });
});
