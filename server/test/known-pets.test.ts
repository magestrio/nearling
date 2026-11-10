import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { settleFeeding } from '../src/pet/settle';
import { api, harness } from './helpers/api';
import { keyedPlayer, NEAR_ACCOUNT, token } from './helpers/network';
import { addPets, advise, payerToken, WORKER } from './helpers/work';

const h = harness();
const GIVER = NEAR_ACCOUNT(51);
const RECEIVER = NEAR_ACCOUNT(52);

describe('private known-pet navigation', () => {
  // spec: add-hatch-again › Petless discovery flow › known pet visited
  // spec: add-hatch-again › Repeat birth flow › no owned pet after gift
  it('keeps a confirmed given-away pet on the giver’s private Hatch and Home links', async () => {
    const signer = keyedPlayer();
    h.net().contract.addPet('94', signer.account, { name: 'Pixel' });
    h.net().contract.balances.set(signer.account, 10n ** 24n);
    const giver = await token('did:privy:known-giver', signer.account);
    const receiver = await token('did:privy:known-receiver', RECEIVER);
    const code = (await api('/api/pets/94/gift', { token: giver, method: 'POST' })).body.code;
    expect((await api(`/api/gifts/${code}/accept`, { token: receiver, method: 'POST' })).status).toBe(200);
    const ready = await api('/api/pets/94/gift/prepare', { token: giver, method: 'POST' });
    expect(ready.body.status).toBe('ready');
    expect((await api('/api/pets/94/gift/send', { token: giver, body: await signer.sign(ready.body.tx) })).body.status).toBe('ok');
    expect((await api('/api/hatch', { token: giver })).body).toMatchObject({ ownedCount: 0, knownPets: [{ tokenId: '94', name: 'Pixel' }] });
    expect((await api('/api/me', { token: giver })).body).toMatchObject({ ownedCount: 0, knownPets: [{ tokenId: '94', name: 'Pixel' }] });
    expect((await api('/api/hatch')).body).not.toHaveProperty('knownPets');
    expect((await api('/api/me', { token: receiver })).body.knownPets).toEqual([]);
    expect((await api('/api/pets/94', { token: giver })).body.viewer).toBe('guest');
    expect((await api('/api/pets/94/conversation', { token: giver })).status).toBe(403);
    expect((await api('/api/session/end', { token: giver, method: 'POST' })).status).toBe(204);
    expect((await api('/api/me', { token: giver })).status).toBe(401);
  });

  // spec: add-hatch-again › Repeat ownership data › known link disclosure
  it('adds a fed pet only after confirmed settlement and retains it through a new session', async () => {
    h.net().contract.addPet('95', GIVER, { name: 'Moss' });
    const feeder = await token('did:privy:known-feed', RECEIVER);
    await env.DB.prepare("INSERT INTO feedings (id, sub, account, token_id, source, via, tx_hash, created_at) VALUES ('feeding', 'did:privy:known-feed', ?, '95', 'near', 'link', 'hash', ?)")
      .bind(RECEIVER, Date.now()).run();
    expect((await api('/api/me', { token: feeder })).body.knownPets).toEqual([]);
    const row = await env.DB.prepare('SELECT * FROM feedings WHERE id = ?').bind('feeding').first<any>();
    expect(await settleFeeding(env, row!, { status: 'ok' })).toBe(true);
    expect((await api('/api/me', { token: feeder })).body.knownPets).toMatchObject([{ tokenId: '95', name: 'Moss' }]);
    const renewed = await token('did:privy:known-feed', RECEIVER);
    expect((await api('/api/hatch', { token: renewed })).body.knownPets).toMatchObject([{ tokenId: '95' }]);
    await env.DB.prepare('INSERT INTO births_in_flight (account, started_at) VALUES (?, ?)').bind(RECEIVER, Date.now()).run();
    expect((await api('/api/hatch', { token: renewed })).body).toMatchObject({ pending: true, knownPets: [{ tokenId: '95' }] });
  });

  // spec: add-hatch-again › Repeat ownership data › known link disclosure
  it('adds an answered paid-advice worker to only the paying player’s links', async () => {
    addPets(h);
    const payer = await payerToken();
    h.net().ai.push({ content: 'Plant radishes.' });
    expect((await advise(payer, { text: 'What should I plant?' })).thought).toBeTruthy();
    expect((await api('/api/me', { token: payer })).body.knownPets).toMatchObject([{ tokenId: WORKER, name: 'Biscuit' }]);
    const stranger = await token('did:privy:known-stranger', NEAR_ACCOUNT(60));
    expect((await api('/api/me', { token: stranger })).body.knownPets).toEqual([]);
    expect((await api('/api/pets/5/conversation', { token: stranger })).status).toBe(403);
  });
});
