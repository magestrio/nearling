import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { writeDueGrowth } from '../src/pet/growth';
import { writeDueGrant } from '../src/pet/grant';
import { settleItemSends } from '../src/pet/itemTx';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(10);

describe('verification record transaction pointers', () => {
  // spec: add-hatch-again › Repeat birth recovery data › repeat confirmed after lost response
  it('keeps the original birth hash when FINAL confirms a send whose answer was lost', async () => {
    h.net().contract.mode = 'executed-but-silent';
    const tk = await token('did:privy:verification-birth', OWNER);
    const made = await api('/api/hatch', { token: tk, body: { name: 'Pixel' } });
    expect(made.status).toBe(200);
    const tokenId = made.body.tokenId as string;
    const original = (await env.DB.prepare('SELECT birth_tx FROM pets WHERE token_id = ?').bind(tokenId).first<{ birth_tx: string }>())?.birth_tx;
    expect(original).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,}$/);
    expect((await api(`/api/verification/pets/${tokenId}`)).body.transactions).toMatchObject([{ kind: 'birth', ref: 'birth', txHash: original }]);
    const pending = await env.DB.prepare("SELECT tx_hash FROM item_sends WHERE kind = 'birth' AND token_id = ?")
      .bind(OWNER).first<{ tx_hash: string }>();
    expect(pending).toBeNull();
    h.net().contract.mode = 'normal';
    await settleItemSends(env, Date.now() + 61_000);
    const record = await env.DB.prepare("SELECT tx_hash FROM pet_transactions WHERE token_id = ? AND kind = 'birth' AND ref = 'birth'")
      .bind(tokenId).first<{ tx_hash: string }>();
    expect(record?.tx_hash).toBe(original);
    expect((await api(`/api/verification/pets/${tokenId}`)).body.transactions).toMatchObject([{ kind: 'birth', ref: 'birth', txHash: original }]);
    expect((await env.DB.prepare('SELECT birth_tx FROM pets WHERE token_id = ?').bind(tokenId).first<{ birth_tx: string }>())?.birth_tx).toBe(record?.tx_hash);
  });

  // spec: add-verification › Verification record rule › рост и черты
  it('recovers the transition hash after a successful grow whose answer was lost', async () => {
    const today = Math.floor(Date.now() / 86_400_000);
    h.net().contract.addPet('5', OWNER, { stage_day: today - 1 });
    await env.DB.prepare('INSERT INTO pending_growth (token_id, stage, trait, created_at) VALUES (?, ?, ?, ?)')
      .bind('5', 'teen', 'clever', Date.now()).run();
    h.net().contract.mode = 'executed-but-silent';
    expect(await writeDueGrowth(env, '5')).toBe('failed');
    const pending = await env.DB.prepare("SELECT tx_hash FROM item_sends WHERE kind = 'growth' AND token_id = '5' AND item = 'teen'")
      .first<{ tx_hash: string }>();
    expect(pending?.tx_hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,}$/);
    h.net().contract.mode = 'normal';
    await settleItemSends(env, Date.now() + 61_000);
    expect(await env.DB.prepare("SELECT tx_hash FROM pet_transactions WHERE token_id = '5' AND kind = 'growth' AND ref = 'teen'")
      .first<{ tx_hash: string }>()).toEqual({ tx_hash: pending?.tx_hash });
  });

  // spec: add-verification › Verification record rule › вещи
  it('recovers an item hash from a send that landed without an answer', async () => {
    h.net().contract.addPet('5', OWNER);
    await env.DB.prepare('INSERT INTO outfit_grants (token_id, created_at) VALUES (?, ?)').bind('5', Date.now()).run();
    h.net().contract.mode = 'executed-but-silent';
    expect(await writeDueGrant(env, '5')).toBe('failed');
    const pending = await env.DB.prepare("SELECT tx_hash FROM item_sends WHERE token_id = '5' AND kind = 'item'")
      .first<{ tx_hash: string }>();
    expect(pending?.tx_hash).toBeTruthy();
    h.net().contract.mode = 'normal';
    await settleItemSends(env, Date.now() + 61_000);
    expect(await env.DB.prepare("SELECT tx_hash FROM pet_transactions WHERE token_id = '5' AND kind = 'item' AND ref = 'thinking-cap'")
      .first<{ tx_hash: string }>()).toEqual({ tx_hash: pending?.tx_hash });
  });

  // spec: add-verification › Verification record rule › рост и черты
  it('keeps the adult transition link when its trait repeats the teen trait', async () => {
    const today = Math.floor(Date.now() / 86_400_000);
    h.net().contract.addPet('5', OWNER, { stage: 'Teen', stage_day: today - 1, traits: ['clever'] });
    await env.DB.prepare('INSERT INTO pending_growth (token_id, stage, trait, created_at) VALUES (?, ?, ?, ?)')
      .bind('5', 'adult', 'clever', Date.now()).run();
    expect(await writeDueGrowth(env, '5')).toBe('written');
    expect(h.net().contract.pets.get('5')!.traits).toEqual(['clever', 'clever']);
    const record = (await api('/api/verification/pets/5')).body.transactions;
    expect(record).toMatchObject([{ kind: 'growth', ref: 'adult' }]);
  });
});
