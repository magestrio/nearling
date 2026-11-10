import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { finishBirth, releaseFailedBirth } from '../src/pet/birth';
import { settleItemSends } from '../src/pet/itemTx';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const PLAYER = NEAR_ACCOUNT(10);
const session = () => token('did:privy:repeat', PLAYER);
const hatch = async () => api('/api/hatch', { token: await session(), body: { name: 'Nova' } });
const flight = () => env.DB.prepare('SELECT tx_hash, prior_token_id FROM births_in_flight WHERE account = ?')
  .bind(PLAYER).first<{ tx_hash: string; prior_token_id: string | null }>();

describe('repeat birth recovery', () => {
  // spec: add-hatch-again › Repeat birth spend data › birth stop reached
  it('backfills legacy first-birth costs and permits a second token while keeping each kind unique', async () => {
    await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, 1, ?)')
      .bind('7', PLAYER, 'legacy-hash').run();
    await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros, birth_account) VALUES (1, 'starter_food', 9, ?), (1, 'storage', 90, ?)")
      .bind(PLAYER, PLAYER).run();
    const migration = env.TEST_DB_MIGRATIONS.find((entry) => entry.name.includes('0038_hatch_again'));
    const backfill = migration?.queries.find((query) => query.includes('UPDATE project_spend'));
    expect(backfill).toBeDefined();
    await env.DB.prepare(backfill!).run();
    expect((await env.DB.prepare('SELECT DISTINCT birth_token_id FROM project_spend').all()).results).toEqual([{ birth_token_id: '7' }]);
    await env.DB.prepare("INSERT OR IGNORE INTO project_spend (at, kind, usd_micros, birth_account, birth_token_id) VALUES (2, 'starter_food', 9, ?, '7')")
      .bind(PLAYER).run();
    await env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros, birth_token_id) VALUES (2, 'starter_food', 9, '8'), (2, 'storage', 90, '8')").run();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM project_spend').first())).toEqual({ n: 4 });
    // A rolled-back Worker still writes by account, without birth_token_id. Its duplicate
    // retry must remain suppressed after migration 0039 restores the old guard.
    await env.DB.prepare("INSERT OR IGNORE INTO project_spend (at, kind, usd_micros, birth_account) VALUES (3, 'starter_food', 9, ?)")
      .bind(PLAYER).run();
    await env.DB.prepare("INSERT OR IGNORE INTO project_spend (at, kind, usd_micros, birth_account) VALUES (4, 'starter_food', 9, ?)")
      .bind(PLAYER).run();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM project_spend WHERE birth_account = ? AND kind = 'starter_food'").bind(PLAYER).first())).toEqual({ n: 1 });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM project_spend').first())).toEqual({ n: 4 });
  });

  // spec: add-hatch-again › Repeat birth recovery data › old birth exists during pending repeat
  // spec: add-hatch-again › Repeat birth flow › unknown outcome
  it('keeps the old birth as history while the original repeat hash is unknown, including duplicate POST', async () => {
    h.net().contract.addPet('0', NEAR_ACCOUNT(20));
    h.net().contract.hatchedBy.set(PLAYER, '0');
    h.net().contract.nextId = 1;
    h.net().contract.mode = 'lost';
    expect(await hatch()).toMatchObject({ status: 202, body: { pending: true } });
    const original = await flight();
    expect(original).toMatchObject({ prior_token_id: '0' });
    expect(await hatch()).toMatchObject({ status: 202, body: { pending: true } });
    expect(await flight()).toEqual(original);
    expect((await api('/api/hatch', { token: await session() })).body).toMatchObject({ pending: true });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pets').first()).toEqual({ n: 0 });
  });

  // spec: add-hatch-again › Repeat birth recovery data › repeat confirmed after lost response
  it('rebroadcasts the saved repeat signature and finalizes only its new token', async () => {
    h.net().contract.addPet('0', NEAR_ACCOUNT(20));
    h.net().contract.hatchedBy.set(PLAYER, '0');
    h.net().contract.nextId = 1;
    h.net().contract.mode = 'lost';
    expect((await hatch()).status).toBe(202);
    const original = await flight();
    expect((await env.DB.prepare('SELECT birth_rate_usd_micros FROM births_in_flight WHERE account = ?').bind(PLAYER).first())).toEqual({ birth_rate_usd_micros: 4_590_000 });
    await env.DB.prepare('UPDATE births_in_flight SET birth_rate_usd_micros = 5000000 WHERE account = ?').bind(PLAYER).run();
    h.net().contract.mode = 'normal';
    await settleItemSends(env, Date.now() + 61_000);
    expect((await env.DB.prepare("SELECT token_id, birth_tx FROM pets WHERE hatched_by = ?").bind(PLAYER).first())).toEqual({ token_id: '1', birth_tx: original!.tx_hash });
    expect(h.net().contract.pets.get('0')?.owner_id).toBe(NEAR_ACCOUNT(20));
    expect(await flight()).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM project_spend WHERE birth_token_id = ?').bind('1').first())).toEqual({ n: 3 });
    expect((await env.DB.prepare("SELECT usd_micros FROM project_spend WHERE birth_token_id = '1' AND kind = 'storage'").first())).toEqual({ usd_micros: 88_950 });
  });

  // spec: add-hatch-again › Repeat birth recovery data › old birth exists during pending repeat
  it('refuses to finalize when the status response names a different mint receiver', async () => {
    h.net().contract.meanwhile.tx = async () => {
      const row = await flight();
      const raw = h.net().contract.outcomes.get(row!.tx_hash) as {
        transaction: { actions: Array<{ FunctionCall: { args: string } }> };
      };
      raw.transaction.actions[0]!.FunctionCall.args = btoa(JSON.stringify({ receiver: NEAR_ACCOUNT(20) }));
    };
    expect((await hatch()).status).toBe(503);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pets').first()).toEqual({ n: 0 });
    expect(await flight()).not.toBeNull();
  });

  // spec: add-hatch-again › Repeat birth recovery data › repeat confirmed failed after lost response
  // spec: add-hatch-again › Repeat birth flow › confirmed failure
  it('releases a final failed repeat without treating its old token as success', async () => {
    h.net().contract.addPet('0', NEAR_ACCOUNT(20));
    h.net().contract.hatchedBy.set(PLAYER, '0');
    h.net().contract.nextId = 1;
    h.net().contract.burnt = '3000000000000000000000';
    h.net().contract.mintFails = 'pool_empty';
    h.net().contract.mode = 'executed-but-silent';
    expect((await hatch()).status).toBe(202);
    expect((await api('/api/hatch', { token: await session() })).body).toMatchObject({ failed: true });
    expect((await env.DB.prepare('SELECT reserved_usd_micros FROM births_in_flight WHERE account = ?').bind(PLAYER).first())).toEqual({ reserved_usd_micros: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pets').first()).toEqual({ n: 0 });
    expect((await env.DB.prepare('SELECT birth_tx_hash, kind, usd_micros FROM project_spend WHERE birth_tx_hash IS NOT NULL').all()).results).toMatchObject([{ kind: 'gas', usd_micros: expect.any(Number) }]);
    const failedHash = (await flight())!.tx_hash;
    expect((await env.DB.prepare('SELECT birth_tx_hash FROM project_spend WHERE birth_tx_hash IS NOT NULL').first())).toEqual({ birth_tx_hash: failedHash });
    expect((await api('/api/hatch', { token: await session() })).body).toMatchObject({ failed: true });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM project_spend WHERE birth_tx_hash = ?').bind(failedHash).first())).toEqual({ n: 1 });
    h.net().contract.mode = 'normal';
    h.net().contract.mintFails = null;
    expect(await hatch()).toMatchObject({ status: 200, body: { tokenId: '1' } });
  });

  // spec: add-hatch-again › Repeat birth flow › confirmed failure
  it('releases a node-refused mint immediately so a corrected attempt can hatch', async () => {
    h.net().contract.mode = 'invalid-nonce';
    expect(await hatch()).toMatchObject({ status: 502, body: { code: 'not_hatched' } });
    expect((await env.DB.prepare('SELECT failed, reserved_usd_micros FROM births_in_flight WHERE account = ?').bind(PLAYER).first())).toEqual({ failed: 1, reserved_usd_micros: 0 });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM project_spend WHERE birth_tx_hash IS NOT NULL').first())).toEqual({ n: 0 });
    h.net().contract.mode = 'normal';
    expect(await hatch()).toMatchObject({ status: 200, body: { tokenId: '0' } });
  });

  // spec: add-hatch-again › Repeat birth recovery data › repeat confirmed failed after lost response
  it('keeps a newer birth journal when stale cleanup releases an older failed attempt', async () => {
    h.net().contract.mode = 'invalid-nonce';
    expect((await hatch()).status).toBe(502);
    const old = await env.DB.prepare('SELECT started_at, tx_hash FROM births_in_flight WHERE account = ?')
      .bind(PLAYER).first<{ started_at: number; tx_hash: string }>();
    expect(old?.tx_hash).toBeTruthy();

    h.net().contract.mode = 'lost';
    expect((await hatch()).status).toBe(202);
    const newer = await flight();
    expect(newer?.tx_hash).toBeTruthy();
    expect(newer?.tx_hash).not.toBe(old!.tx_hash);
    // The older request had read its failed flight, but had not yet deleted its journal.
    await env.DB.prepare("INSERT INTO item_sends (tx_hash, token_id, item, sent_at, kind) VALUES (?, ?, 'birth', ?, 'birth')")
      .bind(old!.tx_hash, PLAYER, Date.now()).run();

    await releaseFailedBirth(env, PLAYER, old!.started_at, old!.tx_hash);
    expect(await env.DB.prepare('SELECT tx_hash FROM item_sends WHERE tx_hash = ?').bind(old!.tx_hash).first()).toBeNull();
    expect(await env.DB.prepare('SELECT tx_hash FROM item_sends WHERE tx_hash = ?').bind(newer!.tx_hash).first())
      .toEqual({ tx_hash: newer!.tx_hash });
    expect((await flight())?.tx_hash).toBe(newer!.tx_hash);

    h.net().contract.mode = 'normal';
    await settleItemSends(env, Date.now() + 61_000);
    expect((await env.DB.prepare('SELECT birth_tx FROM pets WHERE token_id = ?').bind('0').first())).toEqual({ birth_tx: newer!.tx_hash });
  });

  // spec: add-hatch-again › Repeat birth spend data › birth stop reached
  it('records food, measured storage and actual gas once for each token, including a repeat', async () => {
    h.net().contract.burnt = '3000000000000000000000';
    expect((await hatch()).body).toEqual({ tokenId: '0' });
    h.net().contract.pets.get('0')!.owner_id = NEAR_ACCOUNT(20);
    expect((await hatch()).body).toEqual({ tokenId: '1' });
    const rows = (await env.DB.prepare('SELECT birth_token_id, kind FROM project_spend WHERE birth_token_id IS NOT NULL ORDER BY birth_token_id, kind').all()).results;
    expect(rows).toEqual(['0', '1'].flatMap((birth_token_id) => ['gas', 'starter_food', 'storage'].map((kind) => ({ birth_token_id, kind }))));
    expect((await env.DB.prepare("SELECT usd_micros FROM project_spend WHERE birth_token_id = '1' AND kind = 'gas'").first())).toEqual({ usd_micros: 13_770 });
    await finishBirth(env, PLAYER, '1', 'duplicate-hash', h.net().contract.burnt, '0');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM project_spend WHERE birth_token_id IS NOT NULL').first())).toEqual({ n: 6 });
  });
});
