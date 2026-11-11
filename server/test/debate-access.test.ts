import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const FIRST = NEAR_ACCOUNT(91);
const SECOND = NEAR_ACCOUNT(92);
const NEW = NEAR_ACCOUNT(93);

async function prepared(): Promise<{ first: string; second: string; newcomer: string; id: string }> {
  h.net().contract.addPet('91', FIRST, { name: 'Pixel' });
  h.net().contract.addPet('92', SECOND, { name: 'Nori' });
  h.net().contract.known.add(`91:${SECOND}`);
  const first = await token('did:privy:debate-access-first', FIRST);
  const second = await token('did:privy:debate-access-second', SECOND);
  const newcomer = await token('did:privy:debate-access-new', NEW);
  const sent = await api('/api/debates', { token: first,
    body: { firstPet: '91', secondPet: '92', openerPet: '92', topic: 'Where is home?' } });
  expect(sent.status).toBe(201);
  return { first, second, newcomer, id: sent.body.id };
}

describe('debate private and link reads', () => {
  // spec: add-debates › Debate invitation card screen › success
  it('lists open incoming invitation ids only for the invited pet current owner', async () => {
    const { second, first, newcomer, id } = await prepared();
    const path = '/api/pets/92/debates/incoming';
    expect(await api(path, { token: second })).toMatchObject({ status: 200, body: { ids: [id] } });
    expect((await api(path)).status).toBe(401);
    expect((await api(path, { token: first })).status).toBe(403);
    h.net().contract.pets.get('92')!.owner_id = NEW;
    h.net().contract.pets.get('92')!.transfer_generation += 1;
    expect((await api(path, { token: second })).status).toBe(403);
    expect((await api(path, { token: newcomer })).body).toEqual({ ids: [] });
  });

  // spec: add-debates › Debate consent and access data › invitation read
  it('bounds incoming and owner record chain reads when many pairs target one pet', async () => {
    const { second, id: template } = await prepared();
    for (let i = 0; i < 55; i += 1) {
      const petId = String(1000 + i);
      const id = (1000 + i).toString(16).padStart(64, '0');
      h.net().contract.addPet(petId, FIRST, { name: `Other ${i}` });
      h.net().contract.known.add(`${petId}:${SECOND}`);
      await env.DB.prepare(`INSERT INTO debates
        (id, first_pet, second_pet, first_owner, second_owner, first_generation, second_generation,
          first_epoch, second_epoch, acquaintance, opener_pet, topic, created_at, expires_at, share_code, share_hash)
        SELECT ?, ?, second_pet, first_owner, second_owner, first_generation, second_generation,
          first_epoch, second_epoch, acquaintance, ?, topic, ?, expires_at, share_code, ?
        FROM debates WHERE id = ?`).bind(id, petId, petId, Date.now() + i + 1, id, template).run();
    }
    h.net().contract.reads.length = 0;
    const incoming = await api('/api/pets/92/debates/incoming', { token: second });
    expect(incoming.status).toBe(200);
    expect(incoming.body.ids).toHaveLength(50);
    expect(h.net().contract.reads.filter((read) => read.method === 'pet_view')).toHaveLength(52);
    h.net().contract.reads.length = 0;
    const records = await api('/api/pets/92/debates', { token: second });
    expect(records.status).toBe(200);
    expect(records.body.records).toHaveLength(50);
    expect(h.net().contract.reads.filter((read) => read.method === 'pet_view')).toHaveLength(52);
  });

  // spec: add-debates › Debate invitation flow › gift before start
  it('hides the incoming pointer when the proposing pet was gifted', async () => {
    const { second } = await prepared();
    h.net().contract.pets.get('91')!.owner_id = NEW;
    h.net().contract.pets.get('91')!.transfer_generation += 1;
    expect((await api('/api/pets/92/debates/incoming', { token: second })).body).toEqual({ ids: [] });
  });

  // spec: add-debates › Debate invitation flow › invited
  it('recovers an outgoing status pointer after reload for the current owner only', async () => {
    const { first, second, id } = await prepared();
    const path = '/api/pets/91/debates';
    expect((await api(path, { token: first })).body).toEqual({ records: [{ id, status: 'invited', side: 'proposer' }] });
    expect((await api(path, { token: second })).status).toBe(403);
    expect((await api(path)).status).toBe(401);
    h.net().contract.pets.get('91')!.owner_id = NEW;
    h.net().contract.pets.get('91')!.transfer_generation += 1;
    expect((await api(path, { token: first })).status).toBe(403);
  });

  // spec: add-debates › Debate invitation flow › declined
  it('recovers a declined invitation status after its private words were removed', async () => {
    const { first, second, id } = await prepared();
    expect((await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'decline' } })).status).toBe(200);
    expect((await api('/api/pets/91/debates', { token: first })).body).toEqual({
      records: [{ id, status: 'declined', side: 'proposer' }],
    });
    expect((await api('/api/debates/read', { token: first, body: { id } })).body).toEqual({ id, status: 'declined' });
  });

  // spec: add-debates › Debate invitation flow › settled-hire acquaintance
  it('lists a settled-hire partner even without a Society row, but hides a same-owner pair', async () => {
    h.net().contract.addPet('91', FIRST, { name: 'Pixel', work_known: ['92'] });
    h.net().contract.addPet('92', SECOND, { name: 'Nori' });
    const first = await token('did:privy:debate-partners-first', FIRST);
    const path = '/api/pets/91/debates/partners';
    expect((await api(path, { token: first })).body).toEqual({ partners: [{ tokenId: '92', name: 'Nori' }] });
    h.net().contract.pets.get('92')!.owner_id = FIRST;
    expect((await api(path, { token: first })).body).toEqual({ partners: [] });
    expect((await api(path)).status).toBe(401);
  });

  // spec: add-debates › Debate invitation screen › asleep
  it('names the selected sleeping pet so Feed opens for that pet', async () => {
    const { first } = await prepared();
    h.net().contract.pets.get('92')!.project_food = '0';
    const read = await api('/api/debates/eligibility', { token: first, body: { firstPet: '91', secondPet: '92' } });
    expect(read.body).toEqual({ code: 'asleep', name: 'Nori', petId: '92' });
  });
  // spec: add-debates › Debate receipt disclosure data › visitor checks line
  it('returns exact signed bytes to a code holder for a settled line after a gift', async () => {
    const { second, id } = await prepared();
    const code = (await env.DB.prepare('SELECT share_code FROM debates WHERE id = ?').bind(id).first<{ share_code: string }>())!.share_code;
    expect((await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } })).status).toBe(200);
    for (let i = 0; i < 200; i += 1) {
      const line = await env.DB.prepare('SELECT status FROM debate_lines WHERE debate_id = ? AND line_order = 1').bind(id).first<{ status: string }>();
      if (line?.status === 'settled') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const before = await api('/api/debates/line/bytes', { body: { code, order: 1 } });
    expect(before.status).toBe(200);
    const transcript = await api('/api/debates/read', { body: { code } });
    expect(transcript.body.lines[0]).toMatchObject({ status: 'settled', nearUsdRate: env.NEAR_USD_RATE });
    const signed = JSON.parse(before.body.signed_call) as { req_sha256: string; res_sha256: string; sig_kind: string };
    const sha = async (encoded: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
      Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0))))].map((n) => n.toString(16).padStart(2, '0')).join('');
    expect(await sha(before.body.request_bytes)).toBe(signed.req_sha256);
    expect(await sha(before.body.response_bytes)).toBe(signed.res_sha256);
    expect(signed.sig_kind).toBe('provider_tee');
    h.net().contract.pets.get('91')!.owner_id = NEW;
    h.net().contract.pets.get('91')!.transfer_generation += 1;
    expect((await api('/api/debates/line/bytes', { body: { code, order: 1 } })).status).toBe(200);
    expect((await api('/api/debates/line/bytes', { body: { code, order: 2 } })).status).toBe(404);
    await env.DB.prepare("UPDATE debate_lines SET request_bytes = 'dGFtcGVyZWQ=' WHERE debate_id = ? AND line_order = 1")
      .bind(id).run();
    expect((await api('/api/debates/line/bytes', { body: { code, order: 1 } })).body.code).toBe('receipt_unavailable');
  });
  // spec: add-debates › Debate consent and access data › invitation read
  it('shows either current owner the invitation, its order and both consent states', async () => {
    const { first, second, id } = await prepared();
    for (const tk of [first, second]) {
      const read = await api('/api/debates/read', { token: tk, body: { id } });
      expect(read.body).toMatchObject({ id, topic: 'Where is home?', openerPet: '92', maxPerPetNear: '0.01',
        consents: [{ petId: '91', decision: 'accepted' }] });
      expect(read.body).not.toHaveProperty('code');
      expect(JSON.stringify(read.body)).not.toContain(FIRST);
      expect(JSON.stringify(read.body)).not.toContain(SECOND);
    }
  });

  // spec: add-debates › Debate consent and access data › visitor reads published link
  it('reveals only published fields to a signed-out code holder after second consent', async () => {
    const { first, second, id } = await prepared();
    const secret = (await env.DB.prepare('SELECT share_code FROM debates WHERE id = ?').bind(id).first<{ share_code: string }>())!.share_code;
    expect((await api('/api/debates/read', { body: { code: secret } })).status).toBe(404);
    const accepted = await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    expect(accepted.status).toBe(200);
    const guest = await api('/api/debates/read', { body: { code: secret } });
    expect(guest.status).toBe(200);
    expect(guest.body).toMatchObject({ id, topic: 'Where is home?', lines: expect.any(Array) });
    for (const field of ['code', 'consents', 'firstOwner', 'secondOwner', 'shareHash', 'firstEpoch', 'secondEpoch'])
      expect(guest.body).not.toHaveProperty(field);
    expect((await api('/api/debates/read', { token: first, body: { id } })).body.code).toBe(secret);
    expect((await api('/api/debates/read', { token: second, body: { id } })).body.code).toBe(secret);
    expect(h.net().fetched.every((url) => !url.includes(secret) && !url.includes('Where is home?'))).toBe(true);
    expect(h.logs().every((line) => !line.includes(secret) && !line.includes('Where is home?'))).toBe(true);
  });

  // spec: add-debates › Debate consent and access data › former owner reads
  it('rejects the former owner after a gift, without returning private data', async () => {
    const { first, second, id } = await prepared();
    expect((await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } })).status).toBe(200);
    h.net().contract.pets.get('91')!.owner_id = NEW;
    h.net().contract.pets.get('91')!.transfer_generation += 1;
    const read = await api('/api/debates/read', { token: first, body: { id } });
    expect(read.status).toBe(403);
    expect(read.body).toEqual({ code: 'not_owner' });
  });

  // spec: add-debates › Debate transcript and deletion data › gift after paid line
  it('lets the new current owner read the retained record using its original chain acquaintance proof', async () => {
    const { second, newcomer, id } = await prepared();
    expect((await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } })).status).toBe(200);
    await env.DB.prepare(`INSERT INTO debate_lines (debate_id, line_order, speaker_pet, status, text, request_bytes,
      response_bytes, receipt_tx_hash, price_yocto, near_usd_rate, created_at, settled_at)
      VALUES (?, 1, '92', 'settled', 'A settled line.', 'request bytes', 'response bytes', 'tx-hash', '100', '2.5', ?, ?)`)
      .bind(id, Date.now(), Date.now()).run();
    h.net().contract.pets.get('91')!.owner_id = NEW;
    h.net().contract.pets.get('91')!.transfer_generation += 1;
    const read = await api('/api/debates/read', { token: newcomer, body: { id } });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id, topic: 'Where is home?', code: expect.stringMatching(/^[0-9a-f]{32}$/),
      lines: [{ text: 'A settled line.', requestBytes: 'request bytes', responseBytes: 'response bytes', receiptTxHash: 'tx-hash', nearUsdRate: '2.5' }] });
    expect((await api('/api/pets/91/debates', { token: newcomer })).body.records[0].retained).toBe(true);
    expect((await api('/api/debates/read', { body: { code: read.body.code } })).body.lines[0].text).toBe('A settled line.');
    expect(h.net().contract.known.has(`91:${NEW}`)).toBe(false);
  });

  // spec: add-debates › Debate invitation flow › gift before start
  it('ends an unaccepted invitation when the owner generation changes', async () => {
    const { newcomer, id } = await prepared();
    const secret = (await env.DB.prepare('SELECT share_code FROM debates WHERE id = ?').bind(id).first<{ share_code: string }>())!.share_code;
    h.net().contract.pets.get('91')!.owner_id = NEW;
    h.net().contract.pets.get('91')!.transfer_generation += 1;
    const read = await api('/api/debates/read', { token: newcomer, body: { id } });
    expect(read.body.status).toBe('gift');
    expect(read.body).not.toHaveProperty('code');
    expect((await api('/api/debates/read', { body: { code: secret } })).status).toBe(404);
    const deletedCode = (await api('/api/debates/read', { token: newcomer, body: { id } })).body;
    expect(deletedCode).toEqual({ id, status: 'gift' });
    expect((await env.DB.prepare('SELECT reason FROM debate_ended_invites WHERE id = ?').bind(id).first<{ reason: string }>())?.reason).toBe('gift');
  });

  // spec: add-debates › Debate transcript and deletion data › clear during a line
  it('does not return a saved topic when clear wins during a published read chain wait', async () => {
    const { first, id } = await prepared();
    await env.DB.prepare("UPDATE debates SET status = 'accepted' WHERE id = ?").bind(id).run();
    await env.DB.prepare("INSERT INTO debate_consents (debate_id, pet_id, owner_id, decision, decided_at) VALUES (?, ?, ?, 'accepted', ?)")
      .bind(id, '92', SECOND, Date.now()).run();
    const code = (await env.DB.prepare('SELECT share_code FROM debates WHERE id = ?').bind(id)
      .first<{ share_code: string }>())!.share_code;
    h.net().contract.meanwhile.pet_view = async () => {
      expect((await api('/api/pets/91/memory/clear', { token: first, method: 'POST' })).status).toBe(200);
    };
    const read = await api('/api/debates/read', { body: { code } });
    expect(read).toEqual({ status: 404, body: { code: 'no_debate' } });
  });

  // spec: add-debates › Debate consent and access data › former owner reads
  it('rechecks private ownership after the initial authorized pair read', async () => {
    const { first, id } = await prepared();
    let views = 0;
    const arm = () => {
      h.net().contract.meanwhile.pet_view = async () => {
        views += 1;
        if (views === 3) {
          h.net().contract.pets.get('91')!.owner_id = NEW;
          h.net().contract.pets.get('91')!.transfer_generation += 1;
        } else arm();
      };
    };
    arm();
    const read = await api('/api/debates/read', { token: first, body: { id } });
    expect(views).toBeGreaterThanOrEqual(3);
    expect(read).toEqual({ status: 403, body: { code: 'not_owner' } });
  });
});
