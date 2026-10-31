// `GET /api/pets/:id/feed` and `GET /api/wallet`.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { clean } from '../src/cron';
import { GAS_TOPUP_YOCTO } from '../src/pricing';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const NEAR = 10n ** 24n;
const MILLI = 10n ** 21n;
const OWNER = NEAR_ACCOUNT(71);
const FRIEND = NEAR_ACCOUNT(72);
/** The UTC day of the test's clock (the harness fakes `Date`, so it is read inside a test). */
const today = () => Math.floor(Date.now() / 86_400_000);

const as = (account: string, name: string | null = 'Maya Chen') => token(`did:privy:${account}`, account, { name });
const sheet = async (account: string, tokenId = '7') => (await api(`/api/pets/${tokenId}/feed`, { token: await as(account) })).body;
const withPet = (patch = {}) => h.net().contract.addPet('7', OWNER, patch);
const setPlayer = (account: string, set: string) => env.DB.prepare(`UPDATE players SET ${set} WHERE account_id = ?`).bind(account).run();

describe('who may open the sheet', () => {
  // spec: add-feeding › Feed sheet screen › error
  it('turns a visitor away: no session, no sheet, and nothing read from the network', async () => {
    withPet();
    const res = await api('/api/pets/7/feed');
    expect(res).toEqual({ status: 401, body: { code: 'signed_out' } });
    expect(h.net().contract.reads).toEqual([]);
    expect(await api('/api/wallet')).toEqual({ status: 401, body: { code: 'signed_out' } });
  });

  // spec: add-feeding › Feed sheet screen › error
  it('answers 404 for a token that is not an id, and for a pet that does not exist', async () => {
    withPet();
    const tk = await as(FRIEND);
    expect((await api('/api/pets/abc/feed', { token: tk })).status).toBe(404);
    expect((await api('/api/pets/99/feed', { token: tk })).status).toBe(404);
    expect((await api('/api/pets/99/feed', { token: tk })).body).toEqual({ code: 'no_pet' });
  });

  // spec: add-feeding › Feed sheet screen › success (владелец)
  it('gives the owner the owner\'s sheet: portions, the balance and no friend', async () => {
    withPet();
    h.net().contract.balances.set(OWNER, 310n * MILLI);
    const body = await sheet(OWNER);
    expect(body).toMatchObject({
      chain: true,
      viewer: 'owner',
      name: 'Pixel',
      fullness: { state: 'full', level: 1 },
      wallet: { state: 'some', balance: (310n * MILLI).toString() },
      snack: { state: 'none' },
      friend: null,
    });
    expect(body.portions.map((p: { cents: number; missing: string | null }) => [p.cents, p.missing])).toEqual([[5, null], [23, null], [92, null]]);
  });

  // spec: add-feeding › Feed sheet screen › success (гость)
  it('gives a signed-in stranger the guest\'s sheet with their own first name and whether they hatched a pet', async () => {
    withPet();
    h.net().contract.balances.set(FRIEND, 310n * MILLI);
    // the first name is the exchange's to write; the sheet only reads it
    await api('/api/session', { token: await token('did:privy:friend', FRIEND, { name: 'Maya Chen', noPlayer: true }), body: { fresh: true } });
    const body = (await api('/api/pets/7/feed', { token: await token('did:privy:friend', FRIEND, { name: 'Maya Chen' }) })).body;
    expect(body).toMatchObject({ chain: true, viewer: 'guest', friend: 'Maya', hatched: false, snack: { state: 'ready' } });
    h.net().contract.hatchedBy.set(FRIEND, '3');
    expect((await sheet(FRIEND)).hatched).toBe(true);
  });

  // spec: add-feeding › Feed sheet screen › лист обновляется сам
  it('reads the owner from the network every time: a pet given away turns the old owner\'s sheet into a guest\'s', async () => {
    const pet = withPet();
    expect((await sheet(OWNER)).viewer).toBe('owner');
    pet.owner_id = FRIEND;
    expect((await sheet(OWNER)).viewer).toBe('guest');
    expect((await sheet(FRIEND)).viewer).toBe('owner');
  });

  // spec: add-feeding › Feed sheet screen › лист обновляется сам
  it('follows the pet\'s food: another feeder\'s meal wakes it and the owner\'s snack is gone', async () => {
    withPet({ project_food: '0' });
    expect((await sheet(OWNER)).snack).toEqual({ state: 'ready' });
    h.net().contract.pets.get('7')!.given_food = MILLI.toString();
    const woken = await sheet(OWNER);
    expect(woken.snack).toEqual({ state: 'none' });
    expect(woken.fullness.state).toBe('hungry');
  });
});

describe('the wallet on the sheet', () => {
  // spec: add-feeding › Feed sheet screen › без NEAR
  it('is «none» for a wallet the network has no record of, with the whole 0.01 missing, and the gas account untouched', async () => {
    withPet();
    const body = await sheet(FRIEND);
    expect(body.wallet).toEqual({ state: 'none' });
    expect(body.portions.map((p: { missing: string }) => p.missing)).toEqual(['0.01', '0.05', '0.20']);
    expect(h.net().contract.viewed).not.toContain(env.GAS_ACCOUNT_ID);
  });

  // spec: add-feeding › Player wallet data › в кошельке только газ проекта
  it('is «none» for a wallet that holds only the project\'s gas, and the balance is not sent', async () => {
    withPet();
    h.net().contract.balances.set(FRIEND, 4n * MILLI);
    await as(FRIEND);
    await setPlayer(FRIEND, "gas_added_yocto = '5000000000000000000000', gas_topup_at = NULL");
    const body = await sheet(FRIEND);
    expect(body.wallet).toEqual({ state: 'none' });
    expect(body.portions[0].missing).toBe('0.01');
    expect(JSON.stringify(body)).not.toContain((4n * MILLI).toString());
  });

  // spec: add-feeding › Player wallet data › запас газа потрачен
  it('is «none» with the gas in the missing once the top-up was given and spent: 0.02', async () => {
    withPet();
    h.net().contract.balances.set(FRIEND, 2n * MILLI);
    await as(FRIEND);
    await setPlayer(FRIEND, "gas_added_yocto = '5000000000000000000000', gas_topup_at = 1, wallet_seen_yocto = '5000000000000000000000'");
    const body = await sheet(FRIEND);
    expect(body.wallet).toEqual({ state: 'none' });
    expect(body.portions[0].missing).toBe('0.02');
  });

  // spec: add-feeding › Feed sheet screen › мало NEAR
  it('shows what the player is short of for the rows that do not fit: 0.08 NEAR and the 0.2 portion short 0.12', async () => {
    withPet();
    h.net().contract.balances.set(OWNER, 80n * MILLI);
    const body = await sheet(OWNER);
    expect(body.wallet).toEqual({ state: 'some', balance: (80n * MILLI).toString() });
    // the top-up is still due and the gas account holds it: the portion alone is the need
    expect(body.portions.map((p: { missing: string | null }) => p.missing)).toEqual([null, null, '0.12']);
    expect(h.net().contract.viewed).toContain(env.GAS_ACCOUNT_ID);
  });

  // spec: add-feeding › Feeding gas data › газ доложить нечем
  it('counts the gas in what is missing when the gas account cannot give the top-up', async () => {
    withPet();
    const chain = h.net().contract;
    chain.balances.set(OWNER, 80n * MILLI);
    chain.balances.set(env.GAS_ACCOUNT_ID, 4n * MILLI);
    expect((await sheet(OWNER)).portions.map((p: { missing: string | null }) => p.missing)).toEqual([null, null, '0.13']);
    // exactly the top-up is enough
    chain.balances.set(env.GAS_ACCOUNT_ID, GAS_TOPUP_YOCTO);
    expect((await sheet(OWNER)).portions[2].missing).toBe('0.12');
  });

  // spec: add-feeding › Feeding gas data › запас газа уже доливали
  it('does not read the gas account when the answer does not depend on it', async () => {
    withPet();
    const chain = h.net().contract;
    chain.balances.set(OWNER, 300n * MILLI); // every portion fits with its gas
    await sheet(OWNER);
    chain.balances.set(FRIEND, 80n * MILLI);
    await as(FRIEND);
    await setPlayer(FRIEND, "gas_added_yocto = '5000000000000000000000', gas_topup_at = 1"); // the top-up was given
    await sheet(FRIEND);
    expect(chain.viewed).not.toContain(env.GAS_ACCOUNT_ID);
  });

  // spec: add-feeding › Add NEAR sheet screen › NEAR пришёл
  it('counts NEAR that arrived with the sheet closed once, at the next opening', async () => {
    withPet();
    await sheet(FRIEND);
    h.net().contract.balances.set(FRIEND, NEAR);
    await sheet(FRIEND);
    expect(h.events().filter((e) => e.name === 'wallet_funded')).toHaveLength(1);
    await sheet(FRIEND);
    expect(h.events().filter((e) => e.name === 'wallet_funded')).toHaveLength(1);
  });
});

describe('the snacks of a friend, from D1', () => {
  const give = (account: string, tokenId: string, day = today()) =>
    env.DB.prepare('INSERT INTO friend_snacks (account, token_id, day) VALUES (?, ?, ?)').bind(account, tokenId, day).run();

  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня
  it('says «given» for the pet the friend already gave a snack today, and only for today', async () => {
    withPet();
    await give(FRIEND, '7');
    expect((await sheet(FRIEND)).snack).toEqual({ state: 'given' });
    await env.DB.exec('DELETE FROM friend_snacks');
    await give(FRIEND, '7', today() - 1);
    expect((await sheet(FRIEND)).snack).toEqual({ state: 'ready' });
    // another friend's snack is nothing of this one's
    await env.DB.exec('DELETE FROM friend_snacks');
    await give(NEAR_ACCOUNT(99), '7');
    expect((await sheet(FRIEND)).snack).toEqual({ state: 'ready' });
  });

  // spec: add-feeding › Snack rule › друг сегодня уже кормил многих
  it('says «shared_all» for a friend who gave three other pets a snack today, with the next 00:00 UTC', async () => {
    withPet();
    for (const id of ['11', '12']) await give(FRIEND, id);
    expect((await sheet(FRIEND)).snack).toEqual({ state: 'ready' });
    await give(FRIEND, '13');
    expect((await sheet(FRIEND)).snack).toEqual({ state: 'shared_all', until: new Date((today() + 1) * 86_400_000).toISOString() });
  });

  // spec: add-feeding › Snack rule › три перекуса за сутки
  it('says «pet_full» when the pet had three from friends today', async () => {
    withPet({ friend_snack_day: today(), friend_snacks: 3 });
    expect((await sheet(FRIEND)).snack).toMatchObject({ state: 'pet_full' });
    h.net().contract.pets.get('7')!.friend_snack_day = today() - 1;
    expect((await sheet(FRIEND)).snack).toEqual({ state: 'ready' });
  });

  // spec: add-feeding › Snack rule › перекус владельцу ещё не готов
  it('says «not_ready» to the owner of a sleeping pet with the time of the next, read from the chain\'s U64 text', async () => {
    const last = BigInt(Date.now() - 3_600_000) * 1_000_000n;
    withPet({ project_food: '0', owner_snack_at: last.toString() });
    expect((await sheet(OWNER)).snack).toEqual({ state: 'not_ready', at: new Date(Date.now() - 3_600_000 + 72 * 3_600_000).toISOString() });
  });

  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня
  it('is cleaned by the cron at the end of the UTC day: earlier days go, today stays', async () => {
    await give(FRIEND, '7', today() - 1);
    await give(FRIEND, '8', today());
    await clean(env, Date.now());
    const rows = await env.DB.prepare('SELECT token_id FROM friend_snacks').all<{ token_id: string }>();
    expect(rows.results.map((r) => r.token_id)).toEqual(['8']);
  });
});

describe('when the network does not answer', () => {
  // spec: add-feeding › Feeding connection rule › сеть NEAR недоступна
  it('answers `chain: false` and nothing else, for the pet, the pool, and the wallet alike', async () => {
    withPet();
    const chain = h.net().contract;
    const tk = await as(FRIEND);
    chain.down = true;
    expect(await api('/api/pets/7/feed', { token: tk })).toEqual({ status: 200, body: { chain: false } });
    chain.down = false;
    chain.failingViews.add('hatch_view');
    expect((await api('/api/pets/7/feed', { token: tk })).body).toEqual({ chain: false });
    chain.failingViews.delete('hatch_view');
    chain.failingViews.add('pet_view');
    expect((await api('/api/pets/7/feed', { token: tk })).body).toEqual({ chain: false });
    chain.failingViews.delete('pet_view');
    expect((await api('/api/pets/7/feed', { token: tk })).body.chain).toBe(true);
  });

  // spec: add-feeding › Feeding connection rule › сеть NEAR недоступна
  it('says 503 to the wallet read, and an unreadable wallet is never an empty one', async () => {
    withPet();
    h.net().contract.down = true;
    expect(await api('/api/wallet', { token: await as(FRIEND) })).toEqual({ status: 503, body: { code: 'chain_unreachable' } });
  });

  // spec: add-feeding › Feed sheet screen › error
  it('is the sheet\'s error state when the rate of NEAR is not set: prices are never guessed', async () => {
    withPet();
    const tk = await as(FRIEND);
    const vars = env as { NEAR_USD_RATE: string };
    const rate = vars.NEAR_USD_RATE;
    vars.NEAR_USD_RATE = '';
    try {
      expect(await api('/api/pets/7/feed', { token: tk })).toEqual({ status: 500, body: { code: 'rate_missing' } });
    } finally {
      vars.NEAR_USD_RATE = rate;
    }
  });
});

describe('the wallet route', () => {
  // spec: add-feeding › Add NEAR sheet screen › success
  it('gives the session\'s own address and balance, and nothing of anyone else', async () => {
    withPet();
    const chain = h.net().contract;
    chain.balances.set(OWNER, 3n * NEAR);
    chain.balances.set(FRIEND, NEAR);
    const mine = await api('/api/wallet', { token: await as(OWNER) });
    expect(mine.body).toEqual({ address: OWNER, balance: (3n * NEAR).toString(), funded: true });
    const theirs = await api('/api/wallet', { token: await as(FRIEND) });
    expect(theirs.body).toMatchObject({ address: FRIEND, balance: NEAR.toString() });
    // the address is nowhere on a sheet: not the guest's own, not the owner's
    expect(JSON.stringify(await sheet(FRIEND))).not.toContain(OWNER);
    expect(JSON.stringify(await sheet(OWNER))).not.toContain(FRIEND);
  });

  // spec: add-feeding › Add NEAR sheet screen › NEAR пришёл
  it('says `funded` once, when NEAR arrives while the sheet is open, and a wallet that does not exist is empty', async () => {
    const tk = await as(FRIEND);
    expect((await api('/api/wallet', { token: tk })).body).toEqual({ address: FRIEND, balance: '0', funded: false });
    h.net().contract.balances.set(FRIEND, 2n * NEAR);
    expect((await api('/api/wallet', { token: tk })).body).toMatchObject({ funded: true });
    expect((await api('/api/wallet', { token: tk })).body).toMatchObject({ funded: false });
  });

  // spec: add-feeding › Add NEAR sheet screen › error
  it('logs no address, name or balance', async () => {
    withPet();
    h.net().contract.balances.set(OWNER, 3n * NEAR);
    await api('/api/wallet', { token: await as(OWNER) });
    await sheet(OWNER);
    const logs = h.logs().join('\n');
    expect(logs).not.toContain(OWNER);
    expect(logs).not.toContain('Maya');
    expect(logs).not.toContain((3n * NEAR).toString());
  });
});
