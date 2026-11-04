import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/cron';
import { run } from '../src/spend';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';
import { addPets, advise, payerToken, saveSkill, PAYER, WORKER } from './helpers/work';
import { errand, owner, richPet } from './helpers/errands';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const PET = '5';

describe('verification receipt index', () => {
  // spec: add-verification › Verification screen › success
  it('returns model and price on every public pointer so the list needs no selected-thought reads', async () => {
    h.net().contract.addPet(PET, OWNER);
    await run(env, PET, { kind: 'reply', mode: 'chat', text: 'Hello' });
    await tick(env, Date.now() + 11 * 60_000);
    const result = await api(`/api/verification/pets/${PET}`);
    expect(result.status).toBe(200);
    const pointer = result.body.thoughts[0];
    expect(pointer).toMatchObject({ model: 'Qwen/Qwen3.8-27B', priceYocto: expect.stringMatching(/^[0-9]+$/),
      nearUsdRate: env.NEAR_USD_RATE });
    expect(pointer).not.toHaveProperty('replyText');
  });

  // spec: add-verification › Receipt index data › ещё не списана
  it('records the receipt address, payer, rate and reply state when an ordinary thought enters a session', async () => {
    h.net().contract.addPet(PET, OWNER);
    const out = await run(env, PET, { kind: 'reply', mode: 'chat', text: 'Tell me something' });
    expect('thoughtId' in out).toBe(true);
    const row = await env.DB.prepare('SELECT * FROM thoughts WHERE token_id = ?').bind(PET).first<any>();
    expect(row).toMatchObject({
      status: 'unbilled',
      receipt_token_id: PET,
      paying_token_id: PET,
      debit_tx_hash: null,
      near_usd_rate: env.NEAR_USD_RATE,
      without_reply: 0,
      link_eligible: 1,
    });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM receipt_links').first()).toEqual({ n: 0 });
  });

  // spec: add-verification › Receipt index data › байты стёрты
  it('preserves whether the thought had a reply when a clear removes its words', async () => {
    h.net().contract.addPet(PET, OWNER);
    await run(env, PET, { kind: 'reply', mode: 'chat', text: 'Remember this' });
    const row = await env.DB.prepare('SELECT id, without_reply FROM thoughts WHERE token_id = ?').bind(PET).first<{ id: string; without_reply: number }>();
    expect(row?.without_reply).toBe(0);
    await env.DB.prepare('UPDATE thoughts SET erased_at = ?, player_text = NULL, reply_text = NULL WHERE id = ?').bind(Date.now(), row!.id).run();
    const erased = await env.DB.prepare('SELECT without_reply, erased_at, reply_text FROM thoughts WHERE id = ?').bind(row!.id).first<any>();
    expect(erased).toMatchObject({ without_reply: 0, reply_text: null });
    expect(erased.erased_at).not.toBeNull();
  });

  // spec: add-verification › Receipt index data › ещё не списана
  it('attaches only an executed batch hash to the billed pointer', async () => {
    h.net().contract.addPet(PET, OWNER);
    await run(env, PET, { kind: 'reply', mode: 'chat', text: 'Hello' });
    await tick(env, Date.now() + 11 * 60_000);
    const row = await env.DB.prepare('SELECT status, debit_tx_hash FROM thoughts WHERE token_id = ?').bind(PET).first<any>();
    expect(row.status).toBe('billed');
    expect(row.debit_tx_hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,}$/);
    expect(h.net().contract.outcomes.has(row.debit_tx_hash)).toBe(true);
  });

  // spec: add-verification › Receipt index data › ответ с навыком
  it('indexes a worker answer on the worker address but remembers the paying pet', async () => {
    addPets(h);
    await saveSkill('Be concise.');
    await advise(await payerToken());
    const row = await env.DB.prepare("SELECT token_id, receipt_token_id, paying_token_id, worker_id, skilled, link_eligible, near_usd_rate FROM thoughts WHERE kind = 'advice'")
      .first<any>();
    expect(row).toMatchObject({ token_id: PAYER, receipt_token_id: WORKER, paying_token_id: PAYER,
      worker_id: WORKER, skilled: 1, link_eligible: 0, near_usd_rate: env.NEAR_USD_RATE });
  });

  // spec: add-verification › Receipt index data › поручение
  it("indexes the paid errand's form and search count without moving its receipt address", async () => {
    richPet(h);
    await errand(await owner(), 'read', 'Tell me what this means');
    const row = await env.DB.prepare("SELECT token_id, receipt_token_id, paying_token_id, form, searches, near_usd_rate FROM thoughts WHERE kind = 'errand'")
      .first<any>();
    expect(row).toMatchObject({ token_id: PET, receipt_token_id: PET, paying_token_id: PET,
      form: 'read', near_usd_rate: env.NEAR_USD_RATE });
    expect(row.searches).toBe(0);
  });

  // spec: add-verification › Receipt index data › пачка отклонена
  it('drops the debit link and public call evidence when the batch is refused', async () => {
    h.net().contract.addPet(PET, OWNER);
    await run(env, PET, { kind: 'reply', mode: 'chat', text: 'Hello again' });
    h.net().contract.debitFails = 'daily_cap';
    await tick(env, Date.now() + 11 * 60_000);
    const row = await env.DB.prepare('SELECT id, status, debit_tx_hash FROM thoughts WHERE token_id = ?').bind(PET)
      .first<{ id: string; status: string; debit_tx_hash: string | null }>();
    expect(row).toMatchObject({ status: 'project', debit_tx_hash: null });
    const selected = (await api(`/api/verification/pets/${PET}/thoughts/${row!.id}`)).body;
    expect(selected).toMatchObject({ status: 'project', calls: [] });
  });
});
