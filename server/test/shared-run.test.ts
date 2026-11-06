import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { upToFor } from '../src/errands/price';
import { desk } from '../src/pet/desk';
import { startReadyShared } from '../src/errands/sharedRun';
import { finishDueShared, readSharedReceiptFunding } from '../src/errands/sharedSettle';
import { ERRAND_DEADLINE_MS, settleLate } from '../src/errands/late';
import { openSession } from '../src/spend';
import { utcDay } from '../src/http';
import { api, harness } from './helpers/api';
import { addPet, noEnergy, owner, PET, quote } from './helpers/errands';
import { keyedPlayer, NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const JOB = 'When does the meteor shower peak?';
const create = (token: string, form = 'find', job = JOB) => api(`/api/pets/${PET}/shared-errands`, { token, body: { form, job } });

describe('Friend-funded errand flow', () => {
  // spec: add-pet-errands › Errand price data › no search ran twice
  // spec: add-pet-errands › Shared errand funding data › completed job settles
  it('settles a paid no-search result after the three project-paid failures without inventing a report', async () => {
    addPet(h);
    const tk = await owner();
    const created = await create(tk);
    await env.DB.prepare('INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 3)').bind(PET, utcDay(Date.now())).run();
    const friend = keyedPlayer();
    h.net().contract.balances.set(friend.account, 10n ** 24n);
    const friendToken = await token(`did:privy:${friend.account}`, friend.account);
    h.net().ai.push({ stream: { searches: 0 }, tokensIn: 200, tokensOut: 30 },
      { stream: { searches: 0 }, tokensIn: 210, tokensOut: 25 });
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken, body: { portion: '0.01', code: created.body.code } });
    await api(`/api/pets/${PET}/feed/send`, { token: friendToken, body: { ...await friend.sign(built.body.tx), code: created.body.code } });
    await desk(env, PET).process(PET);
    const shared = await env.DB.prepare('SELECT state, report, receipt_id FROM shared_errands WHERE token_id = ?').bind(PET).first<any>();
    expect(shared.state).toBe('failed');
    expect(shared.report).toBeNull();
    expect(shared.receipt_id).toMatch(/^[0-9a-f]{24}$/);
    expect(h.net().contract.debits).toHaveLength(1);
    expect(h.net().contract.pets.get(PET)!.shared_job).toBeNull();
  }, 15_000);
  // spec: add-pet-errands › Shared errand funding data › completed job settles
  it('keeps one debit session for the same shared job across a UTC day change', async () => {
    const hash = 'a'.repeat(64);
    const first = await openSession(env, PET, Date.now(), hash);
    const second = await openSession(env, PET, Date.now() + 86_400_000, hash);
    expect(second).toBe(first);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM debit_sessions WHERE shared_job_hash = ?').bind(hash).first<{ n: number }>())?.n).toBe(1);
  });
  // spec: add-pet-errands › Errand flow › not back in 3 minutes
  // spec: add-pet-errands › Shared errand funding data › failed run without a debit
  it('ends an unstarted timed-out shared run without charging and never queues a replay', async () => {
    addPet(h);
    const tk = await owner();
    const created = await create(tk);
    const friend = keyedPlayer();
    h.net().contract.balances.set(friend.account, 10n ** 24n);
    const friendToken = await token(`did:privy:${friend.account}`, friend.account);
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken, body: { portion: '0.01', code: created.body.code } });
    await api(`/api/pets/${PET}/feed/send`, { token: friendToken, body: { ...await friend.sign(built.body.tx), code: created.body.code } });
    expect(await settleLate(env, PET, Date.now() + ERRAND_DEADLINE_MS + 1)).toBe(true);
    await finishDueShared(env);
    await startReadyShared(env);
    const row = await env.DB.prepare('SELECT state, receipt_id FROM shared_errands WHERE token_id = ?').bind(PET).first<any>();
    expect(row).toMatchObject({ state: 'failed', receipt_id: null });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'errand'").first<{ n: number }>())?.n).toBe(1);
    expect(h.net().contract.debits).toHaveLength(0);
    expect(h.net().contract.pets.get(PET)!.shared_job?.state).toBe('Running');
  });
  // spec: add-pet-errands › Shared errand funding data › failed run without a debit
  it('keeps food reserved and the link open after a search fails before any paid call', async () => {
    addPet(h);
    const tk = await owner();
    const created = await create(tk);
    const friend = keyedPlayer();
    h.net().contract.balances.set(friend.account, 10n ** 24n);
    const friendToken = await token(`did:privy:${friend.account}`, friend.account);
    h.net().ai.push({ status: 503 });
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken, body: { portion: '0.01', code: created.body.code } });
    await api(`/api/pets/${PET}/feed/send`, { token: friendToken, body: { ...await friend.sign(built.body.tx), code: created.body.code } });
    await desk(env, PET).process(PET);
    await finishDueShared(env);
    expect((await env.DB.prepare('SELECT state, receipt_id FROM shared_errands WHERE token_id = ?').bind(PET).first<any>()))
      .toMatchObject({ state: 'failed', receipt_id: null });
    expect(h.net().contract.pets.get(PET)!.shared_job?.state).toBe('Running');
    expect(h.net().contract.debits).toHaveLength(0);
    expect((await api(`/api/pets/${PET}/errand/${created.body.code}`, { token: tk })).body.state).toBe('failed');
  });
  // spec: add-pet-errands › Friend-funded errand flow › funding complete but paused
  // spec: add-pet-errands › Friend-funded errand flow › enough food
  it('waits through an energy block and starts only once when the next eligible day is checked', async () => {
    addPet(h);
    const tk = await owner();
    const created = await create(tk);
    await noEnergy();
    const friend = keyedPlayer();
    h.net().contract.balances.set(friend.account, 10n ** 24n);
    const friendToken = await token(`did:privy:${friend.account}`, friend.account);
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken, body: { portion: '0.01', code: created.body.code } });
    const sent = await api(`/api/pets/${PET}/feed/send`, { token: friendToken, body: { ...await friend.sign(built.body.tx), code: created.body.code } });
    expect(sent.body.status).toBe('ok');
    expect(h.net().contract.pets.get(PET)!.shared_job?.state).toBe('Funding');
    expect(await env.DB.prepare("SELECT 1 FROM jobs WHERE kind = 'errand'").first()).toBeNull();
    await env.DB.prepare('UPDATE pet_life SET energy_used = 0 WHERE token_id = ?').bind(PET).run();
    // Ten older unfunded links must not consume the cron's ten attempts.
    for (let n = 0; n < 10; n++) await env.DB.prepare(`INSERT INTO shared_errands
      (token_id, code_hash, job_hash, owner_account, owner_generation, memory_epoch, form, job, allowance_yocto, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, 'find', 'old job', ?, 'funding', 1, 1)`)
      .bind(String(100 + n), `old-code-${n}`, `old-hash-${n}`, NEAR_ACCOUNT(1), created.body.needed.yocto).run();
    await startReadyShared(env);
    await startReadyShared(env);
    expect(h.net().contract.sends.filter((send) => send.method === 'shared_job_start')).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'errand'").first<{ n: number }>())?.n).toBe(1);
  });
  // spec: add-pet-errands › Friend-funded errand flow › enough food
  // spec: add-pet-errands › Shared errand funding data › completed job settles
  it('starts once from confirmed linked food, debits one thought at once and closes the reserve', async () => {
    addPet(h);
    const tk = await owner();
    const created = await create(tk);
    const friend = keyedPlayer();
    h.net().contract.balances.set(friend.account, 10n ** 24n);
    const friendToken = await token(`did:privy:${friend.account}`, friend.account);
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'It peaks in November [1].' });
    const built = await api(`/api/pets/${PET}/feed`, { token: friendToken, body: { portion: '0.01', code: created.body.code } });
    const sent = await api(`/api/pets/${PET}/feed/send`, { token: friendToken, body: { ...await friend.sign(built.body.tx), code: created.body.code } });
    expect(sent.body.status).toBe('ok');
    expect((await env.DB.prepare('SELECT state FROM shared_errands WHERE token_id = ?').bind(PET).first<{ state: string }>())?.state).toBe('running');
    await desk(env, PET).process(PET);
    const shared = await env.DB.prepare('SELECT state, report, receipt_id FROM shared_errands WHERE token_id = ?').bind(PET).first<any>();
    expect(shared.state).toBe('reported');
    expect(shared.report).toContain('peaks in November');
    expect(shared.receipt_id).toMatch(/^[0-9a-f]{24}$/);
    expect(h.net().contract.sends.filter((send) => send.method === 'shared_job_start')).toHaveLength(1);
    expect(h.net().contract.sends.filter((send) => send.method === 'debit_session')).toHaveLength(1);
    expect(h.net().contract.debits[0]!.thoughts[0]!.job_hash).toMatch(/^[0-9a-f]{64}$/);
    const spent = await env.DB.prepare('SELECT funding_index, spent_yocto, contributor_account FROM shared_errand_contributions WHERE token_id = ?').bind(PET).first<{ funding_index: number; spent_yocto: string; contributor_account: string }>();
    expect(spent).toMatchObject({ funding_index: 0, contributor_account: friend.account });
    expect(BigInt(spent!.spent_yocto)).toBeGreaterThan(0n);
    const billed = await env.DB.prepare('SELECT debit_tx_hash, shared_job_hash FROM thoughts WHERE id = ?').bind(shared.receipt_id).first<{ debit_tx_hash: string; shared_job_hash: string }>();
    expect(await readSharedReceiptFunding(env, billed!.debit_tx_hash, billed!.shared_job_hash)).toEqual([{ index: 0, kind: 'near', amount: spent!.spent_yocto }]);
    expect(h.net().contract.pets.get(PET)!.shared_job).toBeNull();
    const link = `/api/pets/${PET}/errand/${created.body.code}`;
    expect((await api(link, { token: friendToken })).body).toMatchObject({ viewer: 'sponsor', report: shared.report, receiptId: shared.receipt_id });
    expect((await api(link, { token: tk })).body).toMatchObject({ viewer: 'owner', report: shared.report });
    expect((await api(link)).body).not.toHaveProperty('report');
  }, 15_000);
  // spec: add-pet-errands › Friend-funded errand flow › owner shares a job
  it('quotes the full three-search amount independently of food and opens the chain reserve before returning a link', async () => {
    addPet(h, { project_food: '0', given_food: '0' });
    const tk = await owner();
    const estimated = (await quote(tk, 'check')).body;
    expect(estimated.block).toMatchObject({ reason: 'asleep' });
    expect(estimated.sharedNeeded.yocto).toBe(upToFor(env, 3).yocto.toString());
    const created = await create(tk, 'check');
    expect(created.status).toBe(201);
    expect(created.body.needed.yocto).toBe(estimated.sharedNeeded.yocto);
    expect(created.body.url).toMatch(new RegExp(`^/pet/${PET}/errand/[0-9a-f]{64}$`));
    const row = await env.DB.prepare('SELECT * FROM shared_errands WHERE token_id = ?').bind(PET).first<any>();
    expect(row).toMatchObject({ form: 'check', job: JOB, state: 'funding', allowance_yocto: estimated.sharedNeeded.yocto });
    expect(JSON.stringify(row)).not.toContain(created.body.code);
    expect(h.net().contract.pets.get(PET)!.shared_job).toMatchObject({ hash: row.job_hash, allowance: row.allowance_yocto, state: 'Funding' });
    expect(h.net().contract.sends.filter((s) => s.method === 'shared_job_open')).toHaveLength(1);
    expect(h.net().ai.calls).toHaveLength(0);
  });

  // spec: add-pet-errands › Friend-funded errand flow › another shared job is waiting
  it('keeps one active hash and points the owner to the first job', async () => {
    addPet(h);
    const tk = await owner();
    const first = await create(tk);
    expect(first.status).toBe(201);
    const second = await create(tk, 'check', 'Is the sky blue?');
    expect(second).toMatchObject({ status: 409, body: { code: 'shared_job_active', url: first.body.url } });
    expect(h.net().contract.sends.filter((s) => s.method === 'shared_job_open')).toHaveLength(1);
    expect((await env.DB.prepare('SELECT job FROM shared_errands WHERE token_id = ?').bind(PET).first<{ job: string }>())?.job).toBe(JOB);
    expect((await create(tk)).body.url).toBe(first.body.url);
  });

  // spec: add-pet-errands › Friend-funded errand flow › owner shares a job
  it('accepts only the current owner and a visible find/check job of at most 500 code points', async () => {
    addPet(h);
    const tk = await owner();
    const other = await token('did:privy:other', NEAR_ACCOUNT(9));
    expect((await create(other)).status).toBe(403);
    for (const [form, job] of [['read', JOB], ['find', '   '], ['check', 'x'.repeat(501)]]) {
      expect((await create(tk, form, job)).status).toBe(400);
    }
    expect(await env.DB.prepare('SELECT 1 FROM shared_errands').first()).toBeNull();
    expect((await create(tk, 'find', '😀'.repeat(500))).status).toBe(201);
  });

  // spec: add-pet-errands › Shared job open contract › reserve storage unavailable
  it('returns a prepare failure and exposes no link when the chain refuses the open', async () => {
    addPet(h);
    const tk = await owner();
    h.net().contract.sharedOpenFails = 'pool_empty';
    expect(await create(tk)).toMatchObject({ status: 503, body: { code: 'prepare_failed' } });
    expect(await env.DB.prepare('SELECT 1 FROM shared_errands').first()).toBeNull();
    expect(h.net().contract.pets.get(PET)!.shared_job).toBeUndefined();
  });

  // spec: add-pet-errands › Friend-funded errand flow › owner shares a job
  it('keeps the signed open hash on a lost answer and never signs a second open while its outcome is unknown', async () => {
    addPet(h);
    const tk = await owner();
    h.net().contract.mode = 'lost';
    expect(await create(tk)).toMatchObject({ status: 503, body: { code: 'preparing' } });
    const row = await env.DB.prepare('SELECT open_tx_hash, state FROM shared_errands WHERE token_id = ?').bind(PET).first<{ open_tx_hash: string; state: string }>();
    expect(row?.open_tx_hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,50}$/);
    expect(row?.state).toBe('opening');
    h.net().contract.mode = 'normal';
    expect(await create(tk)).toMatchObject({ status: 409, body: { code: 'preparing' } });
    expect(h.net().contract.sends.filter((s) => s.method === 'shared_job_open')).toHaveLength(0);
    vi.setSystemTime(new Date(Date.now() + 11_000));
    expect(await create(tk)).toMatchObject({ status: 409, body: { code: 'preparing' } });
    expect(h.net().contract.sends.filter((s) => s.method === 'shared_job_open')).toHaveLength(1);
    const recovered = await create(tk);
    expect(recovered.status).toBe(200);
    expect(recovered.body.url).toMatch(new RegExp(`^/pet/${PET}/errand/[0-9a-f]{64}$`));
    expect(h.net().contract.sends.filter((s) => s.method === 'shared_job_open')).toHaveLength(1);
  });
});
