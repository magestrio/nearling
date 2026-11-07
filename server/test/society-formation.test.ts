import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { settleFeeding, type FeedingRow } from '../src/pet/settle';
import { applySettledReaction, relation } from '../src/society/relations';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const owner = NEAR_ACCOUNT(701);
const friend = NEAR_ACCOUNT(702);

describe('private relationship formation', () => {
  // spec: add-pet-society › Society formation flow › feeding introduces
  it('introduces both directed sides only after a confirmed friend snack', async () => {
    h.net().contract.addPet('701', owner);
    h.net().contract.addPet('702', friend);
    await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, 1, ?)')
      .bind('701', owner, '').run();
    const tk = await token('did:privy:society-friend', friend);
    const response = await api('/api/pets/701/snack', { token: tk, method: 'POST' });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect((await relation(env.DB, '701', '702'))?.stance).toBe('neutral');
    expect((await relation(env.DB, '702', '701'))?.stance).toBe('neutral');
    expect((await relation(env.DB, '701', '702'))?.good_days).toBe(0);
  });

  // spec: add-pet-society › Society formation flow › respectful work
  it('moves each directed side once on a settled respectful hire', async () => {
    const at = Date.UTC(2026, 10, 6);
    expect(await applySettledReaction(env.DB, 'hire-good-1', '71', '72', 'respectful', at))
      .toEqual({ processed: true, moved: ['71', '72'] });
    expect((await relation(env.DB, '71', '72'))?.stance).toBe('neutral');
    expect((await relation(env.DB, '72', '71'))?.good_days).toBe(1);
    expect(await applySettledReaction(env.DB, 'hire-good-2', '71', '72', 'respectful', at + 86_400_000))
      .toEqual({ processed: true, moved: ['71', '72'] });
    expect((await relation(env.DB, '71', '72'))?.stance).toBe('liked');
    expect((await relation(env.DB, '72', '71'))?.stance).toBe('liked');
    expect(await applySettledReaction(env.DB, 'hire-good-2', '71', '72', 'respectful', at + 86_400_000))
      .toEqual({ processed: false, moved: [] });
  });

  // spec: add-pet-society › Society formation flow › rude work
  it('moves only the worker side toward strained', async () => {
    const at = Date.UTC(2026, 10, 6);
    expect(await applySettledReaction(env.DB, 'hire-rude-1', '81', '82', 'rude', at))
      .toEqual({ processed: true, moved: ['82'] });
    expect(await relation(env.DB, '81', '82')).toBeNull();
    expect((await relation(env.DB, '82', '81'))?.stance).toBe('strained');
  });

  // spec: add-pet-society › Society formation flow › feeding introduces × failed feed
  it('does not create an acquaintance when a feed fails', async () => {
    h.net().contract.addPet('703', owner);
    h.net().contract.addPet('704', friend);
    const row: FeedingRow = {
      id: 'failed-feed-703', sub: 'did:privy:failed-feed', account: friend, token_id: '703',
      source: 'snack', via: 'link', deposit_yocto: null, tx_hash: null, created_at: Date.now(),
    };
    await env.DB.prepare(
      `INSERT INTO feedings (id, sub, account, token_id, source, via, deposit_yocto, tx_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.id, row.sub, row.account, row.token_id, row.source, row.via, null, null, row.created_at).run();
    expect(await settleFeeding(env, row, { status: 'failed', code: 'not_enough_balance' })).toBe(true);
    expect(await relation(env.DB, '703', '704')).toBeNull();
  });
});
