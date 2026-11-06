import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { claimWatch, dueWatches } from '../src/watch/day';
import { runWatch } from '../src/watch/run';
import { finishDueWatches } from '../src/watch/settle';
import { tick } from '../src/cron';
import { utcDay } from '../src/http';
import { api, harness } from './helpers/api';
import { noEnergy, owner, PET, pauseServices, richPet, STARTER } from './helpers/errands';
import { NEAR_ACCOUNT } from './helpers/network';
import { DAILY_CAP_YOCTO } from '../src/pricing';

const h = harness();
const path = `/api/pets/${PET}/watch`;
async function saved() {
  richPet(h);
  const tk = await owner();
  await api(path, { token: tk, method: 'PUT', body: { target: 'NEAR price' } });
  return tk;
}

describe('Watch day rule', () => {
  // spec: add-pet-errands › Watch day rule › already checked today
  it('claims once at the saved UTC hour, including a replacement and two competing ticks', async () => {
    const tk = await saved();
    vi.setSystemTime(new Date(Date.UTC(2036, 10, 1, 9, 59)));
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('not_due');
    vi.setSystemTime(new Date(Date.UTC(2036, 10, 1, 10, 0)));
    const claims = await Promise.all([claimWatch(env, PET, Date.now()), claimWatch(env, PET, Date.now())]);
    expect(claims.filter((x) => x.kind === 'started')).toHaveLength(1);
    await api(path, { token: tk, method: 'PUT', body: { target: 'Rust compiler releases' } });
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('not_due');
    await api(path, { token: tk, method: 'DELETE' });
    await api(path, { token: tk, method: 'PUT', body: { target: 'NEAR price' } });
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('not_due');
    expect((await api(path, { token: tk })).body.nextCheck).toBe(new Date(Date.UTC(2036, 10, 2, 10)).toISOString());
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM watch_checks').first<{ n: number }>())?.n).toBe(1);
  });

  // spec: add-pet-errands › Watch day rule › failed check used today's slot
  // spec: add-pet-errands › Watch day rule › failed check used today's slot × reload
  it('keeps a failed started day used and starts next day at the saved hour', async () => {
    await saved();
    const day = utcDay(Date.now());
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('started');
    await env.DB.prepare("UPDATE watch_checks SET status = 'failed' WHERE token_id = ? AND day = ?").bind(PET, day).run();
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('not_due');
    vi.setSystemTime(new Date((day + 1) * 86_400_000 + 9 * 3_600_000));
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('not_due');
    vi.setSystemTime(new Date((day + 1) * 86_400_000 + 10 * 3_600_000));
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('started');
  });

  // spec: add-pet-errands › Watch day rule › return after blocked days
  // spec: add-pet-errands › Watch day rule › return after blocked days × feed after hour
  it('records a skipped sleeping day without backfill after feeding later', async () => {
    await saved();
    const pet = h.net().contract.pets.get(PET)!;
    pet.project_food = '0'; pet.given_food = '0';
    expect(await claimWatch(env, PET, Date.now())).toMatchObject({ kind: 'skipped', reason: 'sleeping' });
    pet.given_food = (50n * STARTER).toString();
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('not_due');
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    const used: string[] = [];
    await dueWatches(env, Date.now(), async ({ row }) => { used.push(row.token_id); });
    expect(used).toEqual([PET]);
  });

  // spec: add-pet-errands › Daily watch flow › sleeping pause
  it('tells the owner why today was skipped, until a replaced target starts a new comparison', async () => {
    const tk = await saved();
    expect((await api(path, { token: tk })).body.pause).toBeNull();
    const pet = h.net().contract.pets.get(PET)!;
    pet.project_food = '0'; pet.given_food = '0';
    expect(await claimWatch(env, PET, Date.now())).toMatchObject({ kind: 'skipped', reason: 'sleeping' });
    const read = (await api(path, { token: tk })).body;
    expect(read.pause).toBe('sleeping');
    expect(read.nextCheck).toBe(new Date((utcDay(Date.now()) + 1) * 86_400_000 + new Date().getUTCHours() * 3_600_000).toISOString());
    // a different target is a new comparison: today's skip is not its pause, and today's slot stays used
    const replaced = (await api(path, { token: tk, method: 'PUT', body: { target: 'Rust compiler releases' } })).body;
    expect(replaced.pause).toBeNull();
    expect(await claimWatch(env, PET, Date.now())).toMatchObject({ kind: 'not_due' });
    // the owner's own read never leaves the owner (a visitor reads the target only)
    expect((await api(path, {})).status).toBe(401);
  });

  // spec: add-pet-errands › Daily watch flow › target replaced
  // spec: add-pet-errands › Daily watch flow › target replaced after failed check
  it('keeps today\'s used slot when the target is replaced and drops the old comparison', async () => {
    const tk = await saved();
    const day = utcDay(Date.now());
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('started');
    await env.DB.prepare("UPDATE watch_checks SET status = 'failed' WHERE token_id = ? AND day = ?").bind(PET, day).run();
    await env.DB.prepare("UPDATE watch_targets SET latest_result = 'failed' WHERE token_id = ?").bind(PET).run();
    const read = (await api(path, { token: tk, method: 'PUT', body: { target: 'Rust compiler releases' } })).body;
    // the failed check is not replayed for the new target; it starts after 00:00 UTC with no baseline
    expect(read).toMatchObject({ target: 'Rust compiler releases', lastStartedDay: day, latestResult: null, pause: null });
    expect(read.nextCheck).toBe(new Date((day + 1) * 86_400_000 + new Date().getUTCHours() * 3_600_000).toISOString());
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('not_due');
    expect(await env.DB.prepare('SELECT 1 FROM watch_observations WHERE token_id = ?').bind(PET).first()).toBeNull();
    expect(h.net().ai.calls).toHaveLength(0);
  });

  // spec: add-pet-errands › Daily watch flow › energy pause
  // spec: add-pet-errands › Daily watch flow › services pause
  it('skips energy and service blocks before any outbound search', async () => {
    await saved();
    await noEnergy();
    expect(await claimWatch(env, PET, Date.now())).toMatchObject({ kind: 'skipped', reason: 'energy' });
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    await pauseServices();
    expect(await claimWatch(env, PET, Date.now())).toMatchObject({ kind: 'skipped', reason: 'services' });
    expect(h.net().ai.calls).toHaveLength(0);
  });

  // spec: add-pet-errands › Daily watch flow › food pause
  // spec: add-pet-errands › Daily watch flow › cap pause
  it('skips insufficient food and the daily cap without starting work', async () => {
    await saved();
    const pet = h.net().contract.pets.get(PET)!;
    pet.given_food = '0';
    expect(await claimWatch(env, PET, Date.now())).toMatchObject({ kind: 'skipped', reason: 'food' });
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    pet.given_food = (50n * STARTER).toString();
    pet.debit_day = utcDay(Date.now());
    pet.debited_today = DAILY_CAP_YOCTO.toString();
    expect(await claimWatch(env, PET, Date.now())).toMatchObject({ kind: 'skipped', reason: 'cap' });
    expect(h.net().ai.calls).toHaveLength(0);
  });

  // spec: add-pet-errands › Watch target data › watch received with a gift
  it('does not claim after transfer until the new owner resumes', async () => {
    await saved();
    const pet = h.net().contract.pets.get(PET)!;
    pet.owner_id = NEAR_ACCOUNT(2); pet.transfer_generation += 1;
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('not_due');
    expect((await env.DB.prepare('SELECT paused FROM watch_targets WHERE token_id = ?').bind(PET).first<{ paused: number }>())?.paused).toBe(1);
  });
});

describe('Daily watch flow', () => {
  const page = 'https://science.example.com/meteor';
  async function pageWatch() {
    richPet(h);
    const tk = await owner();
    expect((await api(path, { token: tk, method: 'PUT', body: { target: page } })).status).toBe(200);
    return tk;
  }
  async function check(body: string, reply = 'The peak is in November.') {
    h.net().web.page(page, { body: `<main><p>${body}</p></main>` });
    h.net().ai.push({ stream: { searches: 1 } }, { content: reply });
    const claim = await claimWatch(env, PET, Date.now());
    expect(claim.kind).toBe('started');
    const result = await runWatch(env, PET, { kind: 'watch', day: utcDay(Date.now()), revision: 1 }, 0);
    expect('thoughtId' in result, JSON.stringify({ result, events: h.events(), logs: h.logs(),
      checks: (await env.DB.prepare('SELECT * FROM watch_checks').all()).results,
      thoughts: (await env.DB.prepare('SELECT kind, status, price_yocto FROM thoughts').all()).results,
      sessions: (await env.DB.prepare('SELECT * FROM debit_sessions').all()).results,
      calls: (await env.DB.prepare('SELECT n, label FROM thought_calls').all()).results })).toBe(true);
    return result;
  }

  // spec: add-pet-errands › Daily watch flow › first check
  it('runs a due check from cron through the pet desk once', async () => {
    await pageWatch();
    h.net().web.page(page, { body: '<main><p>The peak is in November.</p></main>' });
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'The peak is in November.' });
    await tick(env, Date.now());
    expect((await env.DB.prepare('SELECT status FROM watch_checks WHERE token_id = ?').bind(PET).first<{ status: string }>())?.status).toBe('paid');
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE token_id = ? AND kind = 'watch' AND status = 'done'").bind(PET).first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare('SELECT counted_days, last_counted_day FROM pet_life WHERE token_id = ?').bind(PET).first<any>())).toMatchObject({ counted_days: 1, last_counted_day: null });
    await tick(env, Date.now());
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE token_id = ? AND kind = 'watch'").bind(PET).first<{ n: number }>())?.n).toBe(1);
  });

  // spec: add-pet-errands › Watch day rule › failed check used today's slot × Worker stops after claim
  it('queues a claimed slot on the next tick when the Worker stopped before enqueue', async () => {
    await pageWatch();
    const day = utcDay(Date.now());
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('started');
    expect(await env.DB.prepare("SELECT 1 FROM jobs WHERE kind = 'watch'").first()).toBeNull();
    h.net().web.page(page, { body: '<main><p>The peak is in November.</p></main>' });
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'The peak is in November.' });
    await tick(env, Date.now());
    expect((await env.DB.prepare('SELECT status FROM watch_checks WHERE token_id = ? AND day = ?').bind(PET, day).first<{ status: string }>())?.status).toBe('paid');
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE token_id = ? AND kind = 'watch'").bind(PET).first<{ n: number }>())?.n).toBe(1);
    await tick(env, Date.now());
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE token_id = ? AND kind = 'watch'").bind(PET).first<{ n: number }>())?.n).toBe(1);
  });

  // spec: add-pet-errands › Daily watch flow › first check
  // spec: add-pet-errands › Watch observation data › comparison has no prior observation
  it('charges and indexes the first baseline without a Diary watch line', async () => {
    const tk = await pageWatch();
    const pet = h.net().contract.pets.get(PET)!;
    const before = BigInt(pet.given_food) + BigInt(pet.project_food);
    const first = await check('The peak is in November.');
    const row = await env.DB.prepare('SELECT status, price_yocto, receipt_id, changed FROM watch_checks WHERE token_id = ?').bind(PET).first<any>();
    expect(row).toMatchObject({ status: 'paid', changed: 0, receipt_id: (first as any).thoughtId });
    expect(BigInt(pet.given_food) + BigInt(pet.project_food)).toBe(before - BigInt(row.price_yocto));
    const quietDiary = await api(`/api/pets/${PET}/diary`, { token: tk });
    expect(quietDiary.body.watch, JSON.stringify(quietDiary)).toEqual([]);
    expect((await api(path, { token: tk })).body).toMatchObject({ latestResult: 'first', latestReceiptId: row.receipt_id });
    expect((await env.DB.prepare('SELECT energy_used FROM pet_life WHERE token_id = ?').bind(PET).first<{ energy_used: number }>())?.energy_used).toBe(1);
    expect(h.events().filter((event) => event.name === 'watch_checked').at(-1)?.props).toMatchObject({ outcome: 'unchanged', price_usd: expect.any(Number) });
  });

  // spec: add-pet-errands › Watch observation data › comparison has no prior observation × reload
  // spec: add-pet-errands › Daily watch flow › first check
  it('reconciles a confirmed debit after the Worker loses the result write', async () => {
    await pageWatch();
    await check('The peak is in November.');
    const baseline = await env.DB.prepare('SELECT named_content, source_urls FROM watch_observations WHERE token_id = ?').bind(PET).first<any>();
    const before = h.net().contract.pets.get(PET)!.last_debit_id;
    const calls = h.net().ai.calls.length;
    await env.DB.batch([
      env.DB.prepare(`UPDATE watch_checks SET status = 'started', pending_content = ?, pending_sources = ?, pending_result = 'first', cost_usd_micros = 100
        WHERE token_id = ?`).bind(baseline.named_content, baseline.source_urls, PET),
      env.DB.prepare('DELETE FROM watch_observations WHERE token_id = ?').bind(PET),
      env.DB.prepare('UPDATE watch_targets SET latest_result = NULL, latest_price_yocto = NULL, latest_receipt_id = NULL WHERE token_id = ?').bind(PET),
    ]);
    await finishDueWatches(env);
    expect((await env.DB.prepare('SELECT status, pending_content FROM watch_checks WHERE token_id = ?').bind(PET).first<any>())).toMatchObject({ status: 'paid', pending_content: null });
    expect((await env.DB.prepare('SELECT named_content, source_urls FROM watch_observations WHERE token_id = ?').bind(PET).first())).toEqual(baseline);
    expect((await env.DB.prepare('SELECT latest_result, latest_receipt_id FROM watch_targets WHERE token_id = ?').bind(PET).first<any>())).toMatchObject({ latest_result: 'first', latest_receipt_id: expect.any(String) });
    expect(h.net().contract.pets.get(PET)!.last_debit_id).toBe(before);
    expect(h.net().ai.calls).toHaveLength(calls);
  });

  // spec: add-pet-errands › Watch target data › watch received with a gift
  // spec: add-pet-errands › Watch day rule › failed check used today's slot
  it('drops an unsent queued check after a gift instead of billing the new owner', async () => {
    await pageWatch();
    const day = utcDay(Date.now());
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('started');
    const thought = 'a'.repeat(24);
    const session = 'b'.repeat(24);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO debit_sessions (id, token_id, day, opened_at, last_at, status) VALUES (?, ?, ?, ?, ?, 'open')")
        .bind(session, PET, day, Date.now(), Date.now()),
      env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, model, price_yocto, price_usd_micros, payer, session_id, status) VALUES (?, ?, ?, 'watch', ?, '100', 1, 'pet', ?, 'unbilled')")
        .bind(thought, PET, Date.now(), env.MODEL_ID, session),
      env.DB.prepare("UPDATE watch_checks SET receipt_id = ?, pending_result = 'first', owner_generation = 0 WHERE token_id = ? AND day = ?")
        .bind(thought, PET, day),
    ]);
    const pet = h.net().contract.pets.get(PET)!;
    pet.owner_id = NEAR_ACCOUNT(2);
    pet.transfer_generation = 1;
    const sends = h.net().contract.sends.length;
    await finishDueWatches(env);
    expect(h.net().contract.sends).toHaveLength(sends);
    expect((await env.DB.prepare('SELECT status FROM thoughts WHERE id = ?').bind(thought).first<{ status: string }>())?.status).toBe('project');
    expect((await env.DB.prepare('SELECT status FROM watch_checks WHERE token_id = ? AND day = ?').bind(PET, day).first<{ status: string }>())?.status).toBe('failed');
  });

  // spec: add-pet-errands › Daily watch flow › unchanged check
  // spec: add-pet-errands › Daily watch flow › named content changed
  it('keeps a quiet receipt, then shows only a named change in that day’s Diary', async () => {
    const tk = await pageWatch();
    await check('The peak is in November.');
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    h.net().web.page(page, { body: '<header>Clock 11:00</header><main><p>The peak is in November.</p></main><footer>Ad</footer>' });
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'The peak is in November.' });
    const quiet = await claimWatch(env, PET, Date.now());
    expect(quiet.kind).toBe('started');
    await runWatch(env, PET, { kind: 'watch', day: utcDay(Date.now()), revision: 1 }, 0);
    const dayTwoDiary = await api(`/api/pets/${PET}/diary`, { token: await owner() });
    expect(dayTwoDiary.body.watch, JSON.stringify(dayTwoDiary)).toEqual([]);
    expect((await api(path, { token: await owner() })).body.latestResult).toBe('unchanged');
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    const changed = await check('The peak moved to December.', 'The peak moved to December.');
    const diary = (await api(`/api/pets/${PET}/diary`, { token: await owner() })).body;
    expect(diary.watch).toEqual([{ target: page, change: 'The peak moved to December.',
      sources: [{ label: 'science.example.com', url: page }], priceYocto: expect.stringMatching(/^[0-9]+$/), receiptId: (changed as any).thoughtId }]);
    expect((await api(path, { token: await owner(), method: 'DELETE' })).status).toBe(200);
    expect((await api(`/api/pets/${PET}/diary`, { token: await owner() })).body.watch).toEqual(diary.watch);
    expect(h.events().filter((event) => event.name === 'watch_checked').map((event) => event.props.outcome)).toEqual(['unchanged', 'unchanged', 'changed']);
    expect((await env.DB.prepare('SELECT energy_used FROM pet_life WHERE token_id = ?').bind(PET).first<{ energy_used: number }>())?.energy_used).toBe(1);
  });

  // spec: add-pet-errands › Daily watch flow › search unavailable
  // spec: add-pet-errands › Watch day rule › failed check used today's slot
  it('uses the started slot but charges no food when search is unavailable', async () => {
    const tk = await pageWatch();
    h.net().ai.push({ status: 503 });
    const claim = await claimWatch(env, PET, Date.now());
    expect(claim.kind).toBe('started');
    const before = h.net().contract.pets.get(PET)!.given_food;
    expect(await runWatch(env, PET, { kind: 'watch', day: utcDay(Date.now()), revision: 1 }, 0)).toEqual({ code: 'watch_failed' });
    expect(h.net().contract.pets.get(PET)!.given_food).toBe(before);
    expect((await api(path, { token: tk })).body).toMatchObject({ latestResult: 'search_down', latestReceiptId: null });
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('not_due');
    expect(h.events().filter((event) => event.name === 'watch_checked').at(-1)?.props).toEqual({ outcome: 'failed', cost_usd: 0, price_usd: 0 });
  });

  // spec: add-pet-errands › Daily watch flow › paid failed search
  it('bills both signed no-search calls after the third failed check today', async () => {
    await pageWatch();
    await env.DB.prepare('INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 3)').bind(PET, utcDay(Date.now())).run();
    h.net().ai.push({ stream: { searches: 0 } }, { stream: { searches: 0 } });
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('started');
    const result = await runWatch(env, PET, { kind: 'watch', day: utcDay(Date.now()), revision: 1 }, 0);
    expect('thoughtId' in result).toBe(true);
    const check = await env.DB.prepare('SELECT status, price_yocto, receipt_id FROM watch_checks WHERE token_id = ?').bind(PET).first<any>();
    expect(check).toMatchObject({ status: 'paid', receipt_id: (result as any).thoughtId });
    expect(BigInt(check.price_yocto)).toBeGreaterThan(0n);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM thought_calls WHERE thought_id = ?').bind(check.receipt_id).first<{ n: number }>())?.n).toBe(2);
    expect(h.events().filter((event) => event.name === 'watch_checked').at(-1)?.props).toMatchObject({ outcome: 'failed', price_usd: expect.any(Number) });
  });

  // spec: add-pet-errands › Daily watch flow › blocked target page
  it('refuses a private target without fetching or billing', async () => {
    richPet(h);
    const tk = await owner();
    expect((await api(path, { token: tk, method: 'PUT', body: { target: 'http://127.0.0.1/private' } })).status).toBe(200);
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('started');
    expect(await runWatch(env, PET, { kind: 'watch', day: utcDay(Date.now()), revision: 1 }, 0)).toEqual({ code: 'watch_failed' });
    expect(h.net().ai.calls).toHaveLength(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM thoughts WHERE kind = ?').bind('watch').first<{ n: number }>())?.n).toBe(0);
    expect((await api(path, { token: tk })).body.latestResult).toBe('blocked');
  });

  // spec: add-pet-errands › Daily watch flow › unreadable named source
  // spec: add-pet-errands › Watch observation data › named source unreadable
  it('pays for a signed search but leaves the baseline when the named page is unreadable', async () => {
    await pageWatch();
    await check('The peak is in November.');
    const baseline = await env.DB.prepare('SELECT named_content, observed_day FROM watch_observations WHERE token_id = ?').bind(PET).first<any>();
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    h.net().web.page(page, { status: 404 });
    h.net().ai.push({ stream: { searches: 1 } });
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('started');
    const result = await runWatch(env, PET, { kind: 'watch', day: utcDay(Date.now()), revision: 1 }, 0);
    expect('thoughtId' in result).toBe(true);
    expect((await api(path, { token: await owner() })).body).toMatchObject({ latestResult: 'unreadable', latestReceiptId: (result as any).thoughtId });
    expect(await env.DB.prepare('SELECT named_content, observed_day FROM watch_observations WHERE token_id = ?').bind(PET).first()).toEqual(baseline);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM thought_calls WHERE thought_id = ?').bind((result as any).thoughtId).first<{ n: number }>())?.n).toBe(1);
    expect((await api(`/api/pets/${PET}/diary`, { token: await owner() })).body.watch).toEqual([]);
  });
});
