// `POST /api/pets/:id/snack`: the free snack, sent by the server with its own key. The kind comes from
// the network, the account from the session; a friend's reservation is written before the send and
// removed on a failure (`Snack rule`, `Pet snack contract`, §8 › Перекусы друзей).
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { settleStaleFeedings } from '../src/cron';
import { setPause } from '../src/servicePause';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(71);
const FRIEND = NEAR_ACCOUNT(72);
const SNACK = BigInt(env.SNACK_AMOUNT);

async function pet(id = '7', owner = OWNER, patch = {}, asleep = true) {
  const p = h.net().contract.addPet(id, owner, asleep ? { project_food: '0', ...patch } : patch);
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at) VALUES (?, ?, 1, ?, ?)').bind(id, owner, '', asleep ? 1 : null).run();
  return p;
}
const as = async (account: string, name: string | null = 'Maya') => {
  const tk = await token(`did:privy:${account}`, account);
  if (name !== null) await env.DB.prepare('UPDATE players SET first_name = ? WHERE account_id = ?').bind(name, account).run();
  return tk;
};
const snack = (tk: string, id = '7') => api(`/api/pets/${id}/snack`, { token: tk, method: 'POST' });
const rows = async (sql: string) => (await env.DB.prepare(sql).all<any>()).results;
const today = () => Math.floor(Date.now() / 86_400_000);
const snackSends = () => h.net().contract.sends.filter((s) => s.method === 'pet_snack');

describe('a friend\'s snack', () => {
  // spec: add-feeding › Feed by link flow › даёт перекус
  it('is sent by the server with the friend\'s account as the feeder, and everything after it runs once', async () => {
    await pet();
    const tk = await as(FRIEND);
    h.net().contract.burnt = '2000000000000000000000';
    const res = await snack(tk);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', friend: 'Maya', hatched: false });
    expect(snackSends()).toMatchObject([
      { signer: env.SERVER_ACCOUNT_ID, deposit: '0', gas: '5000000000000', args: { token_id: '7', feeder: FRIEND, kind: 'friend' } },
    ]);
    expect(h.net().contract.pets.get('7')!.project_food).toBe(SNACK.toString());
    expect(await rows('SELECT account, token_id, day FROM friend_snacks')).toEqual([{ account: FRIEND, token_id: '7', day: today() }]);
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT account FROM known_index')).toEqual([{ account: FRIEND }]);
    // the project paid the snack, the gas of its transaction and the new acquaintance's record
    expect((await rows('SELECT kind FROM project_spend ORDER BY kind')).map((r) => r.kind)).toEqual(['gas', 'snack', 'storage']);
    // the pet was asleep: the friend woke it by name
    expect((await rows("SELECT slept_at, wake_by, wake_seq FROM pets WHERE token_id = '7'"))[0]).toEqual({ slept_at: null, wake_by: 'Maya', wake_seq: 1 });
    expect(h.events().filter((e) => e.name === 'pet_fed')).toEqual([{ name: 'pet_fed', props: { via: 'link', source: 'snack' } }]);
  });

  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня
  it('is given to a pet once a day by one friend: the second tap is 409 snack_gone with the sheet, nothing is sent', async () => {
    await pet();
    const tk = await as(FRIEND);
    await snack(tk);
    const again = await snack(tk);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('snack_gone');
    expect(again.body.sheet.snack).toEqual({ state: 'given' });
    expect(snackSends()).toHaveLength(1);
  });

  // spec: add-feeding › Snack rule › друг сегодня уже кормил многих
  it('is given to three different pets a day by one friend, and the fourth is turned away', async () => {
    for (const id of ['1', '2', '3', '4']) await pet(id);
    const tk = await as(FRIEND);
    for (const id of ['1', '2', '3']) expect((await snack(tk, id)).body.status).toBe('ok');
    const fourth = await snack(tk, '4');
    expect(fourth.status).toBe(409);
    expect(fourth.body.sheet.snack.state).toBe('shared_all');
    expect(snackSends()).toHaveLength(3);
    expect(await rows('SELECT * FROM friend_snacks')).toHaveLength(3);
  });

  // spec: add-feeding › Snack rule › три перекуса за сутки
  it('is refused by the sheet when friends already gave the pet three today', async () => {
    await pet('7', OWNER, { friend_snack_day: Math.floor(Date.now() / 86_400_000), friend_snacks: 3 });
    const res = await snack(await as(FRIEND));
    expect(res.body.code).toBe('snack_gone');
    expect(res.body.sheet.snack.state).toBe('pet_full');
    expect(snackSends()).toEqual([]);
  });

  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня × a failed send
  it('gives the snack back to the friend when the send fails: the reservation is removed and the sheet is redrawn', async () => {
    await pet();
    const tk = await as(FRIEND);
    // the third snack of the day arrives from other friends while this one is on its way
    h.net().contract.meanwhile.send_tx = async () => {
      const p = h.net().contract.pets.get('7')!;
      p.friend_snack_day = Math.floor(Date.now() / 86_400_000);
      p.friend_snacks = 3;
    };
    const res = await snack(tk);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'snack_gone', sheet: { snack: { state: 'pet_full' } } });
    expect(await rows('SELECT * FROM friend_snacks')).toEqual([]);
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT * FROM known_index')).toEqual([]);
    expect(h.logs()).toContain('snack_failed:snacks_today');
    // and a failure that has no line of the sheet is a plain failed outcome, the snack theirs again
    h.net().contract.pets.get('7')!.friend_snacks = 0;
    h.net().contract.meanwhile.send_tx = async () => {
      h.net().contract.pets.delete('7');
    };
    const lost = await snack(tk);
    expect(lost.body).toMatchObject({ status: 'failed' });
    expect(await rows('SELECT * FROM friend_snacks')).toEqual([]);
  });

  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня × a failed send
  it('gives the snack back at once when the node refuses the server\'s transaction: nothing was included', async () => {
    await pet();
    const tk = await as(FRIEND);
    h.net().contract.mode = 'not-enough-balance';
    const res = await snack(tk);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'failed' });
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT * FROM friend_snacks')).toEqual([]);
    expect(h.logs()).toContain('snack_failed:not_enough_balance');
    // «Try again» works: no `409 pending`, no 24 hours
    h.net().contract.mode = 'normal';
    expect((await snack(tk)).body.status).toBe('ok');
  });

  // spec: add-feeding › Feed by link flow › даёт перекус × the network unread after the snack
  it('answers ok for a snack the chain recorded when the pet cannot be read after it', async () => {
    await pet();
    const tk = await as(FRIEND);
    h.net().contract.meanwhile.send_tx = async () => {
      h.net().contract.failingViews.add('pet_view');
    };
    const res = await snack(tk);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', friend: 'Maya' });
    expect(await rows('SELECT tx_hash FROM feedings')).toEqual([{ tx_hash: expect.any(String) }]);
    expect(await rows("SELECT kind, name FROM memory_notes")).toEqual([]);
    h.net().contract.failingViews.clear();
    await settleStaleFeedings(env, Date.now() + 90_000);
    await settleStaleFeedings(env, Date.now() + 90_000);
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows("SELECT kind, name FROM memory_notes")).toEqual([{ kind: 'fed_by', name: 'Maya' }]);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toHaveLength(1);
  });

  // spec: add-feeding › Feeding outcome rule › reopened on its way × 00:00 UTC
  it('is told as landed when its outcome is asked after 00:00 UTC, until the cleaning takes yesterday away', async () => {
    await pet();
    const tk = await as(FRIEND);
    expect((await snack(tk)).body.status).toBe('ok');
    vi.setSystemTime(new Date((today() + 1) * 86_400_000 + 1_000));
    const fresh = await as(FRIEND); // the session of the day before has run out
    const ask = () => api('/api/pets/7/feed/outcome', { token: fresh, body: { id: 'a'.repeat(24), source: 'snack' } });
    expect((await ask()).body).toMatchObject({ status: 'ok', friend: 'Maya' });
    // the cleaning took it: nothing of it is left to read
    await env.DB.exec('DELETE FROM friend_snacks');
    expect((await ask()).body).toMatchObject({ status: 'failed' });
  });

  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня × a second tab
  it('is one reservation and one call when two tabs tap at the same moment', async () => {
    await pet();
    const tk = await as(FRIEND);
    const [a, b] = await Promise.all([snack(tk), snack(tk)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(snackSends()).toHaveLength(1);
    expect(await rows('SELECT * FROM friend_snacks')).toHaveLength(1);
    expect(['pending', 'snack_gone']).toContain([a, b].find((r) => r.status === 409)!.body.code);
  });

  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня × an unknown outcome
  it('keeps its reservation and its row while the outcome is unknown, and the cron settles it from the chain', async () => {
    await pet();
    const tk = await as(FRIEND);
    h.net().contract.mode = 'executed-but-silent';
    const res = await snack(tk);
    expect(res.body).toMatchObject({ status: 'unknown' });
    h.net().contract.mode = 'normal';
    expect(await rows('SELECT source, tx_hash FROM feedings')).toMatchObject([{ source: 'snack' }]);
    expect((await rows('SELECT tx_hash FROM feedings'))[0].tx_hash).toBeTruthy();
    expect(await rows('SELECT * FROM friend_snacks')).toHaveLength(1);
    // the sheet shows the snack as given and the meal as pending
    const sheet = (await api('/api/pets/7/feed', { token: tk })).body;
    expect(sheet.snack).toEqual({ state: 'given' });
    expect(sheet.pending).toBeNull();
    // that read already asked the chain (the fake has the snack): it settled
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT * FROM friend_snacks')).toHaveLength(1);
    expect(await rows('SELECT account FROM known_index')).toEqual([{ account: FRIEND }]);
    expect(snackSends()).toHaveLength(1);
  });

  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня × a failed send
  it('gives the snack back when the cron finds that it never landed, and when it was never sent at all', async () => {
    await pet();
    await pet('8');
    const tk = await as(FRIEND);
    h.net().contract.mode = 'lost';
    expect((await snack(tk)).body.status).toBe('unknown');
    await settleStaleFeedings(env, Date.now() + 25 * 3_600_000);
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT * FROM friend_snacks')).toEqual([]);
    // a row that never got its hash: the Worker died between the row and the send
    await env.DB.batch([
      env.DB.prepare("INSERT INTO feedings (id, sub, account, token_id, source, via, created_at) VALUES ('abc', 's', ?, '8', 'snack', 'link', ?)").bind(FRIEND, Date.now()),
      env.DB.prepare('INSERT INTO friend_snacks (account, token_id, day) VALUES (?, ?, ?)').bind(FRIEND, '8', today()),
    ]);
    await settleStaleFeedings(env, Date.now() + 2 * 60_000);
    expect(await rows('SELECT * FROM feedings')).toHaveLength(1);
    await settleStaleFeedings(env, Date.now() + 6 * 60_000);
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT * FROM friend_snacks')).toEqual([]);
  });

  // spec: add-feeding › Feeding outcome rule › reopened on its way
  it('answers the outcome route of a snack: the reservation of today says it landed, none says it did not', async () => {
    await pet();
    const tk = await as(FRIEND);
    const ask = () => api('/api/pets/7/feed/outcome', { token: tk, body: { id: 'a'.repeat(24), source: 'snack' } });
    expect((await ask()).body).toMatchObject({ status: 'failed' });
    await snack(tk);
    expect((await ask()).body).toMatchObject({ status: 'ok', friend: 'Maya' });
  });

  // spec: add-feeding › Feeding outcome rule › reopened on its way
  it('is answered by the outcome route while its row stands: unknown until the network answers, then ok, once', async () => {
    await pet();
    const tk = await as(FRIEND);
    h.net().contract.mode = 'executed-but-silent';
    await snack(tk);
    h.net().contract.mode = 'normal';
    // a reloaded tab learns the flight from the pet, then asks after it
    const mine = (await api('/api/pets/7', { token: tk })).body.myFeed;
    expect(mine).toMatchObject({ source: 'snack' });
    const ask = () => api('/api/pets/7/feed/outcome', { token: tk, body: mine });
    h.net().contract.txBlind = true;
    expect((await ask()).body).toMatchObject({ status: 'unknown' });
    h.net().contract.txBlind = false;
    expect((await ask()).body).toMatchObject({ status: 'ok', friend: 'Maya' });
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT account FROM known_index')).toEqual([{ account: FRIEND }]);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toHaveLength(1);
  });

  // spec: add-feeding › Feeding connection rule › перекусы на паузе
  it('is not given on a pause of the services, a low gas balance of the server, or a pool under the amount of a snack', async () => {
    await pet();
    const tk = await as(FRIEND);
    await setPause(env.DB, 'ai', Date.now());
    const paused = await snack(tk);
    expect(paused.body).toMatchObject({ code: 'snack_gone', sheet: { snack: { state: 'paused' } } });
    await env.DB.exec('UPDATE service_pause SET reason = NULL, since = NULL');
    h.net().contract.pool = SNACK - 1n;
    expect((await snack(tk)).body.sheet.snack.state).toBe('paused');
    h.net().contract.pool = SNACK;
    h.net().contract.serverBalance = 0n;
    expect((await snack(tk)).body.sheet.snack.state).toBe('paused');
    expect(snackSends()).toEqual([]);
    expect(await rows('SELECT * FROM friend_snacks')).toEqual([]);
  });

  // spec: add-feeding › Feeding connection rule › сеть NEAR недоступна
  it('is refused as unreachable when the network does not answer, and a visitor and a missing pet are turned away', async () => {
    await pet();
    const tk = await as(FRIEND);
    expect((await api('/api/pets/7/snack', { method: 'POST' })).status).toBe(401);
    expect((await snack(tk, '99')).body).toEqual({ code: 'no_pet' });
    h.net().contract.down = true;
    expect((await snack(tk)).body).toEqual({ code: 'chain_unreachable' });
  });

  // spec: add-feeding › Feeding outcome rule › отправлено
  it('takes no second meal or snack while the player has one on its way', async () => {
    await pet();
    await pet('8');
    const tk = await as(FRIEND);
    h.net().contract.mode = 'executed-but-silent';
    await snack(tk);
    h.net().contract.mode = 'normal';
    h.net().contract.txBlind = true;
    expect(await snack(tk, '8')).toEqual({ status: 409, body: { code: 'pending' } });
    expect(snackSends()).toHaveLength(1);
  });
});

describe('the owner\'s snack', () => {
  // spec: add-feeding › Owner snack flow › даёт перекус
  it('is given to a sleeping pet by the server for the owner, wakes it, and costs the project the snack and its gas', async () => {
    await pet();
    const tk = await as(OWNER, null);
    const res = await snack(tk);
    expect(res.body).toMatchObject({ status: 'ok', hatched: false });
    expect(res.body.friend).toBeUndefined();
    expect(snackSends()).toMatchObject([{ args: { token_id: '7', feeder: OWNER, kind: 'owner' } }]);
    expect(h.net().contract.pets.get('7')!.owner_snack_at).not.toBe('0');
    expect(await rows('SELECT * FROM friend_snacks')).toEqual([]);
    expect(await rows('SELECT * FROM known_index')).toEqual([]);
    expect((await rows('SELECT kind FROM project_spend')).map((r) => r.kind)).toEqual(['snack']);
    expect((await rows("SELECT slept_at, wake_by FROM pets WHERE token_id = '7'"))[0]).toEqual({ slept_at: null, wake_by: null });
    expect(h.events().filter((e) => e.name === 'pet_fed')).toEqual([{ name: 'pet_fed', props: { via: 'owner', source: 'snack' } }]);
  });

  // spec: add-feeding › Snack rule › питомец владельца не спит
  it('is refused for a pet that is awake: the server checks it, the contract does not see it', async () => {
    await pet('7', OWNER, {}, false);
    const res = await snack(await as(OWNER, null));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'snack_gone', sheet: { snack: { state: 'none' } } });
    expect(snackSends()).toEqual([]);
  });

  // spec: add-feeding › Snack rule › перекус владельцу ещё не готов
  it('is refused before 72 hours, and the chain\'s refusal in the same moment is the same line', async () => {
    await pet('7', OWNER, { owner_snack_at: (BigInt(Date.now() - 3_600_000) * 1_000_000n).toString() });
    const res = await snack(await as(OWNER, null));
    expect(res.body).toMatchObject({ code: 'snack_gone', sheet: { snack: { state: 'not_ready' } } });
    expect(snackSends()).toEqual([]);
    // the contract's own check: the last snack lands while this one is on its way
    h.net().contract.pets.get('7')!.owner_snack_at = '0';
    h.net().contract.meanwhile.send_tx = async () => {
      h.net().contract.pets.get('7')!.owner_snack_at = (BigInt(Date.now()) * 1_000_000n).toString();
    };
    const raced = await snack(await as(OWNER, null));
    expect(raced.body).toMatchObject({ code: 'snack_gone', sheet: { snack: { state: 'not_ready' } } });
    expect(h.logs()).toContain('snack_failed:snack_too_soon');
  });

  // spec: add-feeding › Feeding outcome rule › reopened on its way
  it('is answered by the outcome route from the pet: within the last day the snack landed', async () => {
    await pet();
    const tk = await as(OWNER, null);
    const ask = () => api('/api/pets/7/feed/outcome', { token: tk, body: { id: 'b'.repeat(24), source: 'snack' } });
    expect((await ask()).body).toMatchObject({ status: 'failed' });
    await snack(tk);
    expect((await ask()).body).toMatchObject({ status: 'ok' });
  });
});
