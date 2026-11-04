import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/cron';
import { reconcile, type GiftFlight } from '../src/gift/flight';
import { run } from '../src/spend';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token, type FakePet } from './helpers/network';
import { addPets, advise, payerToken, PAYER, WORKER } from './helpers/work';

const h = harness();
const PET = '5';
const OWNER = NEAR_ACCOUNT(1);
const NEXT = NEAR_ACCOUNT(2);
const OPERATION = 'publish_test_operation_001';

async function billed(mode: 'chat' | 'deep' = 'chat') {
  h.net().contract.addPet(PET, OWNER);
  if (mode === 'deep') h.net().ai.push(
    { content: '', finish: 'length', tokensOut: 3000, reasoning: 3000 },
    { content: 'A short answer.', tokensOut: 25 },
  );
  await run(env, PET, { kind: 'reply', mode, text: 'The exact request' });
  await tick(env, Date.now() + 11 * 60_000);
  const row = await env.DB.prepare('SELECT id, debit_tx_hash FROM thoughts WHERE token_id = ?').bind(PET)
    .first<{ id: string; debit_tx_hash: string | null }>();
  expect(row?.debit_tx_hash).toBeTruthy();
  return row!;
}

async function publish(thought: string, account = OWNER, operationId = OPERATION) {
  const tk = await token(`did:privy:link-${account.slice(0, 8)}`, account);
  return api(`/api/verification/pets/${PET}/thoughts/${thought}/links`, { token: tk, body: { operationId } });
}

describe('receipt links', () => {
  // spec: add-verification › Receipt link data › publish by another account
  // spec: add-verification › Receipt link flow › publish
  it('publishes only for the current payer owner and retries one operation with one code', async () => {
    const { id } = await billed();
    expect((await api(`/api/verification/pets/${PET}/thoughts/${id}/links`, { body: { operationId: OPERATION } })).status).toBe(401);
    expect((await publish(id, NEXT)).status).toBe(403);
    const first = await publish(id);
    expect(first.status).toBe(200);
    expect(first.body.code).toMatch(/^[0-9a-f]{64}$/);
    expect((await publish(id)).body).toEqual(first.body);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM receipt_links').first()).toEqual({ n: 1 });
    const row = await env.DB.prepare('SELECT code_hash FROM receipt_links').first<{ code_hash: string }>();
    expect(row!.code_hash).not.toBe(first.body.code);
  });

  // spec: add-verification › Receipt link flow › visitor opens link
  // spec: add-verification › Receipt link flow › multiple calls on one link
  // spec: add-verification › Receipt link flow › unknown link
  it('serves one thought without a session and downloads its exact BLOBs in order', async () => {
    const { id } = await billed('deep');
    const made = await publish(id);
    expect(made.status).toBe(200);
    const code = made.body.code as string;
    const publicRead = await api(`/api/verification/receipts/${code}`);
    expect(publicRead.body).toMatchObject({ status: 'live', thought: { id, payingTokenId: PET } });
    expect(JSON.stringify(publicRead.body)).not.toContain('The exact request');
    const calls = await env.DB.prepare('SELECT n, req_bytes, res_bytes FROM thought_calls WHERE thought_id = ? ORDER BY n')
      .bind(id).all<{ n: number; req_bytes: ArrayBuffer; res_bytes: ArrayBuffer }>();
    expect(calls.results).toHaveLength(2);
    expect(publicRead.body.thought.calls).toHaveLength(calls.results.length);
    for (const call of calls.results) {
      for (const [part, expected] of [['request', call.req_bytes], ['reply', call.res_bytes]] as const) {
        const response = await SELF.fetch(`https://game.test/api/verification/receipts/${code}/calls/${call.n}/${part}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/octet-stream');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(expected));
      }
    }
    expect((await api(`/api/verification/receipts/${'0'.repeat(64)}`)).status).toBe(404);
    expect((await api(`/api/verification/receipts/${code}/calls/3/request`)).status).toBe(404);
  });

  // spec: add-verification › Receipt link flow › ineligible receipt
  it('refuses a false billed row, wrong token, failed chain read and mismatched pointer', async () => {
    const { id, debit_tx_hash } = await billed();
    await env.DB.prepare("UPDATE thoughts SET status = 'unbilled' WHERE id = ?").bind(id).run();
    expect((await publish(id)).status).toBe(409);
    await env.DB.prepare("UPDATE thoughts SET status = 'billed' WHERE id = ?").bind(id).run();
    expect((await api(`/api/verification/pets/6/thoughts/${id}/links`, { token: await token('did:privy:wrong-pet', OWNER), body: { operationId: OPERATION } })).status).toBe(404);
    await env.DB.prepare("UPDATE thoughts SET price_yocto = '999' WHERE id = ?").bind(id).run();
    expect((await publish(id)).status).toBe(409);
    await env.DB.prepare('UPDATE thoughts SET price_yocto = ? WHERE id = ?').bind(
      (h.net().contract.debits.at(-1)!.thoughts[0] as { price: string }).price, id).run();
    h.net().contract.txBlind = true;
    expect((await publish(id)).status).toBe(503);
    h.net().contract.txBlind = false;
    const bad = h.net().contract.outcomes.get(debit_tx_hash!) as { status: unknown };
    bad.status = { Failure: { ActionError: 'failed' } };
    expect((await publish(id)).status).toBe(409);
  });

  // spec: add-verification › Receipt link data › private skill request
  // spec: add-verification › Receipt link data › adapter request
  it('refuses skilled, adapter and absent bytes on every call', async () => {
    const { id } = await billed();
    await env.DB.prepare('UPDATE thoughts SET skilled = 1 WHERE id = ?').bind(id).run();
    expect((await publish(id)).status).toBe(409);
    await env.DB.prepare('UPDATE thoughts SET skilled = 0, adapter_used = 1 WHERE id = ?').bind(id).run();
    expect((await publish(id)).status).toBe(409);
    await env.DB.prepare('UPDATE thoughts SET adapter_used = 0 WHERE id = ?').bind(id).run();
    await env.DB.prepare("UPDATE thought_calls SET req_bytes = x'' WHERE thought_id = ?").bind(id).run();
    expect((await publish(id)).status).toBe(409);
    await env.DB.prepare("UPDATE thought_calls SET req_bytes = x'01' WHERE thought_id = ?").bind(id).run();
    expect((await publish(id)).status).toBe(409);
  });

  // spec: add-verification › Receipt link data › ownership unavailable
  it('fails closed when the owner cannot be read, including an existing download', async () => {
    const { id } = await billed();
    const code = (await publish(id)).body.code as string;
    h.net().contract.down = true;
    expect((await publish(id, OWNER, 'another_operation_001')).status).toBe(503);
    const response = await SELF.fetch(`https://game.test/api/verification/receipts/${code}/calls/0/reply`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('The exact request');
  });

  // spec: add-verification › Receipt link data › memory clear revokes link
  // spec: add-verification › Receipt link flow › link revoked
  it('revokes in the memory-clear batch and erases every exact byte', async () => {
    const { id } = await billed();
    const code = (await publish(id)).body.code as string;
    const tk = await token('did:privy:clear-link', OWNER);
    expect((await api(`/api/pets/${PET}/memory/clear`, { token: tk, body: {} })).status).toBe(200);
    expect((await api(`/api/verification/receipts/${code}`)).body.code).toBe('revoked');
    expect((await SELF.fetch(`https://game.test/api/verification/receipts/${code}/calls/0/request`)).status).toBe(410);
    const calls = await env.DB.prepare('SELECT length(req_bytes) AS req, length(res_bytes) AS res FROM thought_calls WHERE thought_id = ?')
      .bind(id).all<{ req: number; res: number }>();
    expect(calls.results.every((call) => call.req === 0 && call.res === 0)).toBe(true);
  });

  // spec: add-verification › Receipt link data › memory clear revokes link
  it('does not serve bytes held before a clear commits during the chain read', async () => {
    const { id } = await billed();
    const code = (await publish(id)).body.code as string;
    h.net().contract.meanwhile.tx = async () => {
      await env.DB.batch([
        env.DB.prepare('UPDATE receipt_links SET revoked_at = ? WHERE thought_id = ?').bind(Date.now(), id),
        env.DB.prepare("UPDATE thought_calls SET req_bytes = x'', res_bytes = x'' WHERE thought_id = ?").bind(id),
      ]);
    };
    const response = await SELF.fetch(`https://game.test/api/verification/receipts/${code}/calls/0/request`);
    expect(response.status).toBe(410);
    expect((await api(`/api/verification/receipts/${code}`)).body.code).toBe('revoked');
  });

  // spec: add-verification › Receipt link data › gift revokes link
  it('permanently revokes a code after a direct transfer away and back', async () => {
    const { id } = await billed();
    const code = (await publish(id)).body.code as string;
    const neverReadWhileAway = (await publish(id, OWNER, 'second_direct_transfer_code')).body.code as string;
    const pet = h.net().contract.pets.get(PET)! as FakePet & { transfer_generation: number };
    pet.owner_id = NEXT;
    pet.transfer_generation = 1;
    expect((await api(`/api/verification/receipts/${code}`)).body.code).toBe('revoked');
    pet.owner_id = OWNER;
    pet.transfer_generation = 2;
    expect((await api(`/api/verification/receipts/${code}`)).body.code).toBe('revoked');
    expect((await api(`/api/verification/receipts/${neverReadWhileAway}`)).body.code).toBe('revoked');
    const stored = await env.DB.prepare('SELECT revoked_at FROM receipt_links WHERE thought_id = ?').bind(id)
      .first<{ revoked_at: number | null }>();
    expect(stored?.revoked_at).not.toBeNull();
  });

  // spec: add-verification › Receipt link data › gift revokes link
  it('revokes a pre-migration code with no transfer generation', async () => {
    const { id } = await billed();
    const code = (await publish(id)).body.code as string;
    await env.DB.prepare('UPDATE receipt_links SET transfer_generation = NULL WHERE thought_id = ?').bind(id).run();
    expect((await api(`/api/verification/receipts/${code}`)).body.code).toBe('revoked');
  });

  // spec: add-verification › Receipt link data › gift revokes link
  it('withholds bytes while a transfer is unresolved and revokes on confirmed settlement', async () => {
    const { id } = await billed();
    const code = (await publish(id)).body.code as string;
    const hash = 'gift-test-hash';
    await env.DB.prepare("INSERT INTO gift_flights (token_id, code, sender, receiver, tx_hash, signed_bytes, state, created_at) VALUES (?, ?, ?, ?, ?, x'00', 'unknown', ?)")
      .bind(PET, 'gift-code', OWNER, NEXT, hash, Date.now()).run();
    expect((await SELF.fetch(`https://game.test/api/verification/receipts/${code}/calls/0/request`)).status).toBe(409);
    expect((await publish(id, OWNER, 'another_operation_002')).status).toBe(409);
    h.net().contract.outcomes.set(hash, { status: { SuccessValue: '' }, transaction_outcome: { block_hash: 'x', outcome: { tokens_burnt: '0' } }, receipts_outcome: [] });
    const row = await env.DB.prepare('SELECT * FROM gift_flights WHERE token_id = ?').bind(PET).first<GiftFlight>();
    expect((await reconcile(env, row!)).body).toMatchObject({ status: 'ok' });
    h.net().contract.pets.get(PET)!.owner_id = NEXT;
    expect((await api(`/api/verification/receipts/${code}`)).body.code).toBe('revoked');
    expect((await SELF.fetch(`https://game.test/api/verification/receipts/${code}/calls/0/reply`)).status).toBe(410);
    expect((await publish(id)).status).toBe(403);
    const publicReceipt = await api(`/api/verification/pets/${PET}/thoughts/${id}`);
    expect(publicReceipt.body).toMatchObject({ id, tokenId: PET, viewer: 'visitor' });
    expect(publicReceipt.body).not.toHaveProperty('privateCalls');
  });

  // spec: add-verification › Receipt link flow › ineligible receipt
  it('rejects a worker receipt if its adjacent hire fee or skill differs', async () => {
    addPets(h);
    await advise(await payerToken());
    await tick(env, Date.now() + 11 * 60_000);
    const row = await env.DB.prepare("SELECT id FROM thoughts WHERE kind = 'advice'").first<{ id: string }>();
    const tk = await payerToken();
    const path = `/api/verification/pets/${WORKER}/thoughts/${row!.id}/links`;
    expect((await api(path, { token: tk, body: { operationId: OPERATION } })).status).toBe(200);
    const fee = await env.DB.prepare('SELECT fee_yocto FROM hires WHERE answer_thought_id = ?').bind(row!.id).first<{ fee_yocto: string }>();
    await env.DB.prepare("UPDATE hires SET fee_yocto = '999' WHERE answer_thought_id = ?").bind(row!.id).run();
    expect((await api(path, { token: tk, body: { operationId: 'another_operation_003' } })).status).toBe(409);
    await env.DB.prepare('UPDATE hires SET fee_yocto = ?, skilled = 1 WHERE answer_thought_id = ?')
      .bind(fee!.fee_yocto, row!.id).run();
    expect((await api(path, { token: tk, body: { operationId: 'another_operation_004' } })).status).toBe(409);
  });

  // spec: add-verification › Verification flow › вопрос найма
  it('publishes a paying pet hire question with a worker reference and no hire event', async () => {
    addPets(h);
    const { id } = await billed();
    await env.DB.prepare("UPDATE thoughts SET kind = 'hire_question', worker_id = ?, receipt_token_id = ? WHERE id = ?")
      .bind(WORKER, PET, id).run();
    expect((await publish(id)).status).toBe(200);
  });

  // spec: add-verification › Verification flow › ответ работника
  it('publishes a worker answer whose hire was not recorded on chain', async () => {
    addPets(h);
    await advise(await payerToken());
    await tick(env, Date.now() + 11 * 60_000);
    const row = await env.DB.prepare("SELECT id, debit_tx_hash FROM thoughts WHERE kind = 'advice'")
      .first<{ id: string; debit_tx_hash: string }>();
    const outcome = h.net().contract.outcomes.get(row!.debit_tx_hash) as { receipts_outcome: { outcome: { logs: string[] } }[] };
    outcome.receipts_outcome[0]!.outcome.logs = outcome.receipts_outcome[0]!.outcome.logs.filter((log) => !log.includes('"event":"hire"'));
    await env.DB.prepare('DELETE FROM hires WHERE answer_thought_id = ?').bind(row!.id).run();
    const path = `/api/verification/pets/${WORKER}/thoughts/${row!.id}/links`;
    expect((await api(path, { token: await payerToken(), body: { operationId: OPERATION } })).status).toBe(200);
  });

  // spec: add-verification › Receipt link data › ownership unavailable
  it('times out a stalled receipt transaction read with a connection error', async () => {
    const { id } = await billed();
    h.net().contract.meanwhile.tx = () => new Promise<void>(() => {});
    expect(await publish(id)).toEqual({ status: 503, body: { code: 'chain_unreachable' } });
  }, 12_000);
});
