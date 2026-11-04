import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { run } from '../src/spend';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { addPets, advise, payerToken, workerToken, WORKER } from './helpers/work';
import { errand, owner as errandOwner, richPet } from './helpers/errands';

const h = harness();
const PET = '5';
const OWNER = NEAR_ACCOUNT(1);
const STRANGER = NEAR_ACCOUNT(2);

async function thought() {
  h.net().contract.addPet(PET, OWNER);
  await run(env, PET, { kind: 'reply', mode: 'chat', text: 'private question' });
  const row = await env.DB.prepare('SELECT id FROM thoughts WHERE token_id = ?').bind(PET).first<{ id: string }>();
  return row!.id;
}

describe('verification reads', () => {
  // spec: add-verification › Receipt index data › мысль не этого питомца
  it('pairs the selected thought with the exact receipt token', async () => {
    const id = await thought();
    expect((await api(`/api/verification/pets/6/thoughts/${id}`)).status).toBe(404);
    expect((await api(`/api/verification/pets/${PET}/thoughts/${id}`)).status).toBe(200);
  });

  // spec: add-verification › Verification flow › подаренный питомец
  it('gives words only to the paying pet current owner', async () => {
    const id = await thought();
    const old = await token('did:privy:verify-old', OWNER);
    const next = await token('did:privy:verify-new', STRANGER);
    const path = `/api/verification/pets/${PET}/thoughts/${id}`;
    expect((await api(path, { token: old })).body).toMatchObject({ viewer: 'owner', playerText: 'private question' });
    expect((await api(path)).body).toMatchObject({ viewer: 'visitor' });
    h.net().contract.pets.get(PET)!.owner_id = STRANGER;
    const former = (await api(path, { token: old })).body;
    expect(former.viewer).toBe('guest');
    expect(JSON.stringify(former)).not.toContain('private question');
    expect((await api(path, { token: next })).body).toMatchObject({ viewer: 'owner', playerText: 'private question' });
  });

  // spec: add-verification › Verification reads data › сервер не прочитал сеть
  it('fails closed when ownership cannot be read', async () => {
    const id = await thought();
    const owner = await token('did:privy:verify-down', OWNER);
    h.net().contract.down = true;
    const answer = await api(`/api/verification/pets/${PET}/thoughts/${id}`, { token: owner });
    expect(answer).toEqual({ status: 503, body: { code: 'chain_unreachable' } });
  });

  // spec: add-verification › Receipt index data › байты стёрты
  it('returns the public pointer without erased words or bytes to the owner', async () => {
    const id = await thought();
    await env.DB.prepare('UPDATE thoughts SET erased_at = ?, player_text = NULL, reply_text = NULL WHERE id = ?')
      .bind(Date.now(), id).run();
    const owner = await token('did:privy:verify-erased', OWNER);
    const answer = (await api(`/api/verification/pets/${PET}/thoughts/${id}`, { token: owner })).body;
    expect(answer).toMatchObject({ viewer: 'owner', erased: true });
    expect(answer).not.toHaveProperty('privateCalls');
    expect(answer).not.toHaveProperty('playerText');
  });

  // spec: add-verification › Verification record rule › вещи
  it('lists transaction pointers by kind and reference without guessing an absent hash', async () => {
    h.net().contract.addPet(PET, OWNER);
    await env.DB.prepare("INSERT INTO pet_transactions (token_id, kind, ref, tx_hash, at) VALUES (?, 'item', 'thinking-cap', 'knownhash', 1)")
      .bind(PET).run();
    const answer = await api(`/api/verification/pets/${PET}`);
    expect(answer.body.transactions).toEqual([{ kind: 'item', ref: 'thinking-cap', txHash: 'knownhash', at: 1 }]);
  });

  // spec: add-verification › Receipt index data › пачка отклонена
  it('never exposes signature or hashes for a project-paid pointer', async () => {
    const id = await thought();
    await env.DB.prepare("UPDATE thoughts SET status = 'project', debit_tx_hash = NULL WHERE id = ?").bind(id).run();
    const answer = (await api(`/api/verification/pets/${PET}/thoughts/${id}`)).body;
    expect(answer).toMatchObject({ status: 'project', debitTxHash: null, calls: [] });
  });

  // spec: add-verification › Receipt index data › ещё не списана
  // spec: add-verification › Receipt index data › пачка отклонена
  it('reserves model and price for the current owner until a receipt is recorded', async () => {
    const id = await thought();
    const owner = await token('did:privy:verify-private-pointer', OWNER);
    const stranger = await token('did:privy:verify-public-pointer', STRANGER);
    for (const status of ['unbilled', 'project']) {
      await env.DB.prepare('UPDATE thoughts SET status = ? WHERE id = ?').bind(status, id).run();
      const list = (await api(`/api/verification/pets/${PET}`)).body.thoughts[0];
      const strangerList = (await api(`/api/verification/pets/${PET}`, { token: stranger })).body.thoughts[0];
      const publicRead = (await api(`/api/verification/pets/${PET}/thoughts/${id}`)).body;
      const strangerRead = (await api(`/api/verification/pets/${PET}/thoughts/${id}`, { token: stranger })).body;
      for (const item of [list, strangerList, publicRead, strangerRead]) {
        expect(item.model).toBe('');
        expect(item.priceYocto).toBe('');
        expect(item.nearUsdRate).toBeNull();
      }
      const own = (await api(`/api/verification/pets/${PET}/thoughts/${id}`, { token: owner })).body;
      expect(own.model).toBe('Qwen/Qwen3.8-27B');
      expect(own.priceYocto).toMatch(/^[0-9]+$/);
      const ownList = (await api(`/api/verification/pets/${PET}`, { token: owner })).body.thoughts[0];
      expect(ownList.model).toBe(own.model);
      expect(ownList.priceYocto).toBe(own.priceYocto);
    }
    h.net().contract.down = true;
    expect((await api(`/api/verification/pets/${PET}`, { token: owner })).status).toBe(503);
    h.net().contract.down = false;
    await env.DB.prepare("UPDATE thoughts SET status = 'billed', debit_tx_hash = NULL WHERE id = ?").bind(id).run();
    const unrecorded = (await api(`/api/verification/pets/${PET}/thoughts/${id}`)).body;
    expect(unrecorded.model).toBe('');
    expect(unrecorded.priceYocto).toBe('');
    expect(unrecorded.calls).toEqual([]);
  });

  // spec: add-verification › Verification screen › success
  it('returns only the last 20 pointers, newest first and stable at the same time', async () => {
    h.net().contract.addPet(PET, OWNER);
    const at = Date.now();
    for (let n = 0; n < 22; n += 1) {
      const id = n.toString(16).padStart(24, '0');
      await env.DB.prepare("INSERT INTO thoughts (id, token_id, receipt_token_id, created_at, kind, model, price_yocto, price_usd_micros, payer, status) VALUES (?, ?, ?, ?, 'reply', 'm', '1', 1, 'pet', 'unbilled')")
        .bind(id, PET, PET, at).run();
    }
    const list = (await api(`/api/verification/pets/${PET}`)).body.thoughts as { id: string }[];
    expect(list).toHaveLength(20);
    expect(list[0]!.id).toBe((21).toString(16).padStart(24, '0'));
    expect(list.at(-1)!.id).toBe((2).toString(16).padStart(24, '0'));
  });

  // spec: add-verification › Receipt index data › мысль не этого питомца
  it('omits a growth line with no receipt from the public thought list', async () => {
    h.net().contract.addPet(PET, OWNER);
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, receipt_token_id, created_at, kind, model, price_yocto, price_usd_micros, payer, status) VALUES (?, ?, ?, ?, 'growth', '', '0', 0, 'project', 'project')")
      .bind('a'.repeat(24), PET, PET, Date.now()).run();
    const list = (await api(`/api/verification/pets/${PET}`)).body.thoughts;
    expect(list).toEqual([]);
  });

  // spec: add-verification › Receipt index data › ответ с навыком
  it('shows a worker receipt at the worker token but gives words only to the payer owner', async () => {
    addPets(h);
    const payingOwner = await payerToken();
    const workerOwner = await workerToken();
    await advise(payingOwner);
    const row = await env.DB.prepare("SELECT id FROM thoughts WHERE kind = 'advice'").first<{ id: string }>();
    const path = `/api/verification/pets/${WORKER}/thoughts/${row!.id}`;
    const publicRead = (await api(path)).body;
    expect(publicRead).toMatchObject({ tokenId: WORKER, payingTokenId: PET, viewer: 'visitor' });
    expect(JSON.stringify(publicRead)).not.toContain('What should I plant?');
    const workerRead = (await api(path, { token: workerOwner })).body;
    expect(workerRead.viewer).toBe('guest');
    expect(workerRead).not.toHaveProperty('privateCalls');
    const ownerRead = (await api(path, { token: payingOwner })).body;
    expect(ownerRead.viewer).toBe('owner');
    expect(ownerRead.privateCalls[0].replyBase64).toBeTruthy();
  });

  // spec: add-verification › Receipt index data › поручение
  it('keeps a private errand job out of the public receipt', async () => {
    richPet(h);
    const owner = await errandOwner();
    await errand(owner, 'read', 'A private errand job');
    const row = await env.DB.prepare("SELECT id FROM thoughts WHERE kind = 'errand'").first<{ id: string }>();
    const path = `/api/verification/pets/${PET}/thoughts/${row!.id}`;
    const publicRead = (await api(path)).body;
    expect(publicRead).toMatchObject({ form: 'read', searches: 0, viewer: 'visitor' });
    expect(JSON.stringify(publicRead)).not.toContain('A private errand job');
    expect((await api(path, { token: owner })).body.playerText).toBe('A private errand job');
  });
});
