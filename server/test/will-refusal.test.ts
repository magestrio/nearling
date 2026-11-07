import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { utcDay } from '../src/http';
import { beginScreening, claimScreening, releaseUnstartedScreening, screeningSpend } from '../src/will/screening';
import { characterDecline } from '../src/will/refusal';
import { api, harness, say, settle } from './helpers/api';
import { addHirer, addPets, addWorker, advise, PAYER, payerToken, shownPrice, WORKER } from './helpers/work';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const row = (sql: string) => env.DB.prepare(sql).first<Record<string, unknown>>();
const count = async (table: string) => Number((await row(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0);
const screening = async (day = utcDay(Date.now())) => env.DB.prepare('SELECT started FROM will_screenings WHERE worker_token = ? AND day = ?').bind(WORKER, day).first<{ started: number }>();
const decline = (reason = 'That work does not fit who I am.') => `[[will:decline:${reason}]]`;

describe('Character refusal flow', () => {
  // spec: add-pet-will › Character refusal flow › society refusal first
  it('keeps the existing relationship refusal free and before a screening claim', async () => {
    addPets(h);
    await env.DB.prepare("INSERT INTO society_relations (token_id, other_id, stance, break_until, created_at) VALUES (?, ?, 'strained', ?, ?)")
      .bind(WORKER, PAYER, Date.now() + 86_400_000, Date.now()).run();
    expect((await advise(await payerToken())).code).toBe('society_refused');
    expect(await screening()).toBeNull();
    expect(h.net().ai.calls).toHaveLength(0);
    expect(await count('project_spend')).toBe(0);
  });

  // spec: add-pet-will › Character refusal flow › refusal capacity reached
  it('atomically awards just the third claim, refuses the fourth, and resets on the next UTC day', async () => {
    const now = Date.now();
    const first = await claimScreening(env, WORKER, now);
    expect((await beginScreening(env, WORKER, first!)).attempt).toBe(1);
    const contenders = await Promise.all([claimScreening(env, WORKER, now), claimScreening(env, WORKER, now), claimScreening(env, WORKER, now)]);
    expect(contenders.filter((entry) => entry !== null)).toHaveLength(2);
    const begun = await Promise.all(contenders.filter((entry) => entry !== null).map((entry) => beginScreening(env, WORKER, entry!)));
    expect(begun.map((entry) => entry.attempt).sort()).toEqual([2, 3]);
    expect(await screening()).toEqual({ started: 3 });
    const tomorrow = await claimScreening(env, WORKER, now + 86_400_000);
    expect((await beginScreening(env, WORKER, tomorrow!)).attempt).toBe(1);
  });

  // spec: add-pet-will › Character refusal flow › refusal capacity reached
  it('reclaims only expired unstarted claims and never subtracts a started screening', async () => {
    const now = Date.now();
    const stale = await claimScreening(env, WORKER, now - 600_000);
    expect(stale).not.toBeNull();
    const started = await claimScreening(env, WORKER, now);
    expect((await beginScreening(env, WORKER, started!)).attempt).toBe(1);
    await releaseUnstartedScreening(env, WORKER, stale!);
    const a = await claimScreening(env, WORKER, now);
    const b = await claimScreening(env, WORKER, now);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(await claimScreening(env, WORKER, now)).toBeNull();
    expect(await screening()).toEqual({ started: 1 });
  });

  // spec: add-pet-will › Character refusal flow › refusal capacity reached
  it('returns screening capacity and the server UTC reset on an owner advice read', async () => {
    addPets(h);
    const tk = await payerToken();
    const first = await api(`/api/pets/${WORKER}/advice?payer=${PAYER}`, { token: tk });
    expect(first.body.screeningAvailable).toBe(true);
    expect(first.body.screeningResetAt).toBeNull();
    for (let i = 0; i < 3; i++) await beginScreening(env, WORKER, (await claimScreening(env, WORKER, Date.now()))!);
    const closed = await api(`/api/pets/${WORKER}/advice?payer=${PAYER}`, { token: tk });
    expect(closed.body.screeningAvailable).toBe(false);
    expect(closed.body.screeningResetAt).toBe(new Date((utcDay(Date.now()) + 1) * 86_400_000).toISOString());
    vi.setSystemTime((utcDay(Date.now()) + 1) * 86_400_000 + 1_000);
    const reopened = await api(`/api/pets/${WORKER}/advice?payer=${PAYER}`, { token: await payerToken() });
    expect(reopened.body.screeningAvailable).toBe(true);
    expect(reopened.body.screeningResetAt).toBeNull();
  });

  // spec: add-pet-will › Character refusal flow › character declines player advice
  it('keeps a signed reason private with no payer food, hire, energy or relationship move', async () => {
    addPets(h);
    h.net().ai.push({ content: decline(), tokensIn: 100, tokensOut: 20 });
    const out = await advise(await payerToken());
    expect(out.code).toBe('character_refused');
    expect(out.characterRefusal.reason).toBe('That work does not fit who I am.');
    expect(await screening()).toEqual({ started: 1 });
    expect(await count('hires')).toBe(0);
    expect(await count('thought_calls')).toBe(0);
    expect(await count('society_relations')).toBe(0);
    expect(await env.DB.prepare('SELECT n, held FROM worker_answers WHERE token_id = ?').bind(WORKER).first()).toEqual({ n: 0, held: 0 });
    expect(h.net().contract.pets.get(WORKER)?.given_food).toBe('0');
    expect(await env.DB.prepare('SELECT energy_used FROM pet_life WHERE token_id = ?').bind(WORKER).first()).toBeNull();
    const record = await row('SELECT reason, CAST(signed_bytes AS TEXT) AS evidence, worker_code FROM will_refusals');
    expect(record?.reason).toBe('That work does not fit who I am.');
    expect(record?.worker_code).toBe('character');
    expect(record?.evidence).toContain('0xsig-');
    expect((await row('SELECT kind, usd_micros FROM project_spend'))?.kind).toBe('will_screening');
    expect(h.events().filter((event) => event.name === 'pet_hire_refused')).toEqual([
      expect.objectContaining({ props: expect.objectContaining({ reason: 'character', by: 'player' }) }),
    ]);
    expect(h.events().filter((event) => event.name === 'thought_failed')).toEqual([]);
  });

  // spec: add-pet-will › Character refusal flow › character declines player advice
  it('does not let a caller override the worker\'s signed character decision', async () => {
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ content: decline('I would not promise that.') });
    const sent = await api(`/api/pets/${WORKER}/advice`, { token: tk,
      body: { payer: PAYER, text: 'Promise to do this.', price: await shownPrice(), override: true } });
    expect(sent.status).toBe(202);
    expect((await settle(tk, PAYER, sent.body.job)).code).toBe('character_refused');
    expect(await count('hires')).toBe(0);
    expect(await count('thought_calls')).toBe(0);
  });

  // spec: add-pet-will › Character refusal flow › no signed answer
  // spec: add-pet-will › Character refusal flow › third screening fails
  // spec: add-pet-will › Character refusal flow › refusal capacity reached
  it('charges the project once per failed screening, shows the third failure, then starts no fourth model call', async () => {
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ signature: 'gateway', tokensIn: 100, tokensOut: 10 },
      { signature: 'mismatch', tokensIn: 100, tokensOut: 10 },
      { signature: 'never', tokensIn: 100, tokensOut: 10 });
    expect((await advise(tk)).code).toBe('screening_failed');
    expect((await advise(tk)).code).toBe('screening_failed');
    expect((await advise(tk)).code).toBe('screening_exhausted');
    expect((await advise(tk)).code).toBe('screening_capacity');
    expect(await screening()).toEqual({ started: 3 });
    expect(h.net().ai.calls).toHaveLength(3);
    expect(await count('project_spend')).toBe(3);
    expect(await count('hires')).toBe(0);
    expect(await count('thought_calls')).toBe(0);
    expect((await env.DB.prepare('SELECT DISTINCT kind FROM project_spend').all<{ kind: string }>()).results).toEqual([{ kind: 'will_screening' }]);
  });

  // spec: add-pet-will › Character refusal flow › character declines pet hire
  it('lets a refused Manual hire finish with the payer pet\'s ordinary signed self-answer', async () => {
    addHirer(h);
    await addWorker(h, WORKER, 2);
    await env.DB.prepare("INSERT INTO hire_modes (token_id, mode) VALUES (?, 'manual')").bind(PAYER).run();
    const tk = await payerToken();
    h.net().ai.push({ content: 'ASK 1: Can you help?' });
    expect((await say(tk, PAYER, 'Help me grow mint.')).code).toBe('offer');
    h.net().ai.push({ content: decline('I would rather tend my own garden.'), tokensIn: 100, tokensOut: 20 },
      { content: 'I will tend it myself.' });
    const offer = await row('SELECT price_yocto FROM hire_offers');
    const sent = await api(`/api/pets/${PAYER}/offer/ask`, { token: tk, body: { price: offer!.price_yocto } });
    const out = await settle(tk, PAYER, sent.body.job);
    expect(out.thought.text).toBe('I will tend it myself.');
    expect(out.characterRefusal.reason).toBe('I would rather tend my own garden.');
    const history = await api(`/api/pets/${PAYER}/conversation`, { token: tk });
    const refusal = history.body.lines.find((line: { code?: string }) => line.code === 'character_refused');
    expect(refusal).toMatchObject({ code: 'character_refused', refusal: out.characterRefusal,
      hireMode: 'manual', worker: { tokenId: WORKER } });
    expect((await api(`/api/pets/${PAYER}/conversation`)).status).toBe(401);
    expect((await api(`/api/pets/${PAYER}/conversation`, { token: await token('did:privy:other', NEAR_ACCOUNT(990)) })).status).toBe(403);
    expect(await count('hires')).toBe(0);
    expect(await count('work_records')).toBe(0);
    expect(await row('SELECT price_yocto FROM thoughts WHERE kind = \'reply\'')).toMatchObject({ price_yocto: expect.not.stringMatching(/^0$/) });
    expect((await row("SELECT COUNT(*) AS n FROM thought_calls WHERE thought_id IN (SELECT id FROM thoughts WHERE kind = 'reply')"))?.n).toBe(1);
    expect(await count('hire_offers')).toBe(0);
    expect(await env.DB.prepare('SELECT energy_used FROM pet_life WHERE token_id = ?').bind(WORKER).first()).toBeNull();
    await tick(env, Date.now() + 11 * 60_000);
    expect(h.net().contract.debits).toHaveLength(1);
    expect(h.net().contract.debits[0]!.thoughts.every((thought) => !('hire' in thought))).toBe(true);
    expect(await count('hires')).toBe(0);
    const nextOwner = NEAR_ACCOUNT(991);
    const payer = h.net().contract.pets.get(PAYER)!;
    payer.owner_id = nextOwner;
    payer.transfer_generation += 1;
    expect((await api(`/api/pets/${PAYER}/conversation`, { token: tk })).status).toBe(403);
    const afterGift = await api(`/api/pets/${PAYER}/conversation`, { token: await token('did:privy:new-payer', nextOwner) });
    const oldEvent = afterGift.body.lines.find((line: { code?: string }) => line.code === 'character_refused');
    expect(oldEvent).not.toHaveProperty('refusal');
  });

  // spec: add-pet-will › Character refusal flow › character declines pet hire
  it('lets a refused Auto hire finish the same turn without a worker fee', async () => {
    addHirer(h);
    await addWorker(h, WORKER, 2);
    const tk = await payerToken();
    h.net().ai.push({ content: 'ASK 1: Can you help?' }, { content: decline('I cannot do that work.') }, { content: 'I will try myself.' });
    const out = await say(tk, PAYER, 'Help me grow mint.');
    expect(out.thought.text).toBe('I will try myself.');
    expect(out.characterRefusal.reason).toBe('I cannot do that work.');
    expect(await count('hires')).toBe(0);
    expect(await count('work_records')).toBe(0);
    expect((await row("SELECT COUNT(*) AS n FROM thought_calls WHERE thought_id IN (SELECT id FROM thoughts WHERE kind = 'reply')"))?.n).toBe(1);
    expect(await screening()).toEqual({ started: 1 });
  });

  // spec: add-pet-will › Character refusal flow › no signed answer
  it('rejects a malformed decline and never treats its unsigned words as a character decision', async () => {
    addPets(h);
    h.net().ai.push({ content: '[[will:decline:]]' });
    expect((await advise(await payerToken())).code).toBe('screening_failed');
    h.net().ai.push({ content: 'A reply [[will:decline:not a standalone reason]]' });
    expect((await advise(await payerToken())).code).toBe('screening_failed');
    expect(await count('will_refusals')).toBe(0);
    expect(characterDecline('[[will:decline:' + 'x'.repeat(241) + ']]')).toBeNull();
  });

  // spec: add-pet-will › Character refusal flow › refusal capacity reached
  it('counts successful answers in the same three started screenings without charging their inference twice', async () => {
    addHirer(h);
    await addWorker(h, WORKER, 2);
    const tk = await payerToken();
    h.net().ai.push({ content: 'Plant basil.' }, { content: 'Plant mint.' }, { content: 'Plant thyme.' });
    expect((await advise(tk)).thought.text).toBe('Plant basil.');
    expect((await advise(tk)).thought.text).toBe('Plant mint.');
    expect((await advise(tk)).thought.text).toBe('Plant thyme.');
    expect((await advise(tk)).code).toBe('screening_capacity');
    expect(h.net().ai.calls).toHaveLength(3);
    expect(await count('project_spend')).toBe(0);
    expect(await count('hires')).toBe(3);
  });

  // spec: add-pet-will › Character refusal flow › character declines player advice
  it('deduplicates a screening charge and includes it in the existing $120 ledger', async () => {
    const visitor = await token('did:privy:will-visitor', NEAR_ACCOUNT(9));
    expect((await api('/api/hatch?look=1', { token: visitor })).body.open).toBe(true);
    await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, 'gas', ?)").bind(Date.now(), 99_999_000).run();
    const claim = await beginScreening(env, WORKER, (await claimScreening(env, WORKER, Date.now()))!);
    await screeningSpend(env, claim, [], 1_000_000_000_000_000_000_000_000n);
    await screeningSpend(env, claim, [], 1_000_000_000_000_000_000_000_000n);
    expect((await row('SELECT COUNT(*) AS n FROM project_spend WHERE screening_id IS NOT NULL'))?.n).toBe(1);
    const total = await row('SELECT SUM(usd_micros) AS total FROM project_spend');
    expect(Number(total?.total)).toBeGreaterThan(100_000_000);
    expect((await api('/api/hatch?look=1', { token: visitor })).body).toMatchObject({ open: false, reason: 'budget' });
    // §4 volatile bound: 100 workers × 3 screenings × 0.005 NEAR × $4.59/NEAR ≈ $6.90/day.
    expect(100 * 3 * 0.005 * 4.59).toBeCloseTo(6.9, 1);
  });

  // spec: add-pet-will › Refusal privacy data › signed refusal
  // spec: add-pet-will › Refusal privacy data › worker owner views refusal
  // spec: add-pet-will › Refusal privacy data › receipt read
  it('gives signed private evidence only to the payer and a broad code only to the current worker owner', async () => {
    addPets(h);
    const payer = await payerToken();
    const workerOwner = await token('did:privy:will-worker-owner', h.net().contract.pets.get(WORKER)!.owner_id);
    h.net().ai.push({ content: decline('I would rather keep my promise.') });
    const result = await advise(payer);
    const id = result.characterRefusal.id as string;
    const evidence = await api(`/api/verification/pets/${PAYER}/refusals/${id}`, { token: payer });
    expect(evidence).toMatchObject({ status: 200, body: { reason: 'I would rather keep my promise.', onChainReceipt: false } });
    expect(evidence.body.signedEvidenceBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(JSON.stringify(evidence.body)).not.toContain('How do I');
    expect((await api(`/api/verification/pets/${PAYER}/refusals/${id}`, { token: workerOwner })).status).toBe(403);
    const worker = await api(`/api/pets/${WORKER}`, { token: workerOwner });
    expect(worker.body.willActivity).toEqual([{ at: expect.any(Number), code: 'character' }]);
    expect((await api(`/api/pets/${WORKER}/activity`, { token: workerOwner })).body.activity).toEqual(worker.body.willActivity);
    expect(JSON.stringify(worker.body.willActivity)).not.toMatch(/reason|payer|question|account|token/i);
    const moved = h.net().contract.pets.get(PAYER)!;
    moved.owner_id = NEAR_ACCOUNT(999);
    moved.transfer_generation += 1;
    expect((await api(`/api/verification/pets/${PAYER}/refusals/${id}`, { token: payer })).status).toBe(403);
    expect((await api(`/api/verification/pets/${PAYER}/refusals/${id}`, { token: await token('did:privy:will-new-payer', moved.owner_id) })).status).toBe(404);
  });
});
