// The purchase of an outfit on the server (`add-wardrobe` › groups 5.1–5.3): the route, the pet's desk, the
// server's own `outfit_buy`, what the food and the cap hold while it is on its way, and the cron that finds
// out what a send with no answer did. The client's side is `web/e2e/wardrobe-buy.spec.ts`.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { OUTFIT_BUY_TGAS, petView } from '../src/chain';
import { clean, settleBuys, tick } from '../src/cron';
import { desk } from '../src/pet/desk';
import { finishBuy, queueBuy, type BuyRow } from '../src/pet/buy';
import { foodState } from '../src/pet/view';
import { ceilingPrice, DAILY_CAP_YOCTO, nearUsdRate, yoctoToUsdMicros } from '../src/pricing';
import { clearPause, setPause } from '../src/servicePause';
import { api, harness, learnBound, say, settle } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const OTHER = NEAR_ACCOUNT(2);
const owner = () => token('did:privy:owner', OWNER);
const STARTER = BigInt(env.STARTER_FOOD);
const PRICE = BigInt(env.OUTFIT_PRICE);
/** One NEAR of given food: the pet stays «Full» after any price here. */
const BIG = (10n ** 24n).toString();
/** The most food a pet can have and not be «Full» (`Pet condition rule`: 24 x food > 23 x starter). */
const EDGE = (23n * STARTER) / 24n;
const DAY_MS = 86_400_000;

const well = (patch: Record<string, unknown> = {}) => h.net().contract.addPet('5', OWNER, { given_food: BIG, ...patch });
const buy = async (item: unknown = 'smart-glasses', tk?: string) => api('/api/pets/5/wardrobe/buy', { token: tk ?? (await owner()), body: { item } });
const view = async (tk?: string) => api('/api/pets/5/wardrobe', { token: tk ?? (await owner()) });
/** The desk has run everything queued for the pet (a caller waits behind the one running). */
const done = () => desk(env, '5').process('5');
const rows = () => env.DB.prepare('SELECT * FROM outfit_buys ORDER BY created_at, rowid').all<any>().then((r) => r.results);
const row = async () => (await rows()).at(-1)!;
const worn = async () => (await env.DB.prepare("SELECT worn FROM wardrobe WHERE token_id = '5'").first<{ worn: string | null }>())?.worn ?? null;
const buySends = () => h.net().contract.sends.filter((s) => s.method === 'outfit_buy');
/** Holds the next transaction at the network until `release()`: a send that takes its time. */
function holdSends(): () => void {
  let release!: () => void;
  h.net().contract.sendGate = new Promise<void>((resolve) => (release = resolve));
  return release;
}
const usd = (yocto: bigint) => yoctoToUsdMicros(yocto, nearUsdRate(env.NEAR_USD_RATE)!) / 1_000_000;

describe('Outfit purchase flow: the route', () => {
  // spec: add-wardrobe › Outfit purchase flow › покупает
  it('takes only one of the four bought items from the owner, and answers 202 with the row', async () => {
    well();
    expect(await buy('thinking-cap')).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await buy('daisy-crown')).toMatchObject({ status: 400 });
    expect(await buy('a-hat')).toMatchObject({ status: 400 });
    expect(await buy(3)).toMatchObject({ status: 400 });
    expect(await api('/api/pets/5/wardrobe/buy', { token: await owner(), body: {} })).toMatchObject({ status: 400 });
    expect(await buy('bow-tie', await token('did:privy:other', OTHER))).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await api('/api/pets/5/wardrobe/buy', { body: { item: 'bow-tie' } })).toMatchObject({ status: 401, body: { code: 'signed_out' } });
    expect(await rows()).toEqual([]);

    const res = await buy('bow-tie');
    expect(res.status).toBe(202);
    expect(res.body.id).toMatch(/^[0-9a-f]{32}$/);
    await done();
    expect(await row()).toMatchObject({ id: res.body.id, item: 'bow-tie', status: 'bought' });
  });

  // spec: add-wardrobe › Outfit purchase contract › вещь уже куплена
  it('refuses an item the chain already holds with 409 owned, before any row', async () => {
    well({ outfits: [3] });
    expect(await buy('smart-glasses')).toMatchObject({ status: 409, body: { code: 'owned' } });
    expect(await rows()).toEqual([]);
    expect(buySends()).toEqual([]);
  });
});

describe('Outfit purchase flow: bought', () => {
  // spec: add-wardrobe › Outfit purchase flow › куплено × the server's end
  it('sends outfit_buy with the server key, puts the item on the pet and fires outfit_bought with what the given food paid', async () => {
    well({ project_food: '0' });
    const res = await buy('smart-glasses');
    await done();

    expect(buySends()).toHaveLength(1);
    expect(buySends()[0]).toMatchObject({ args: { token_id: '5', item: 3 }, gas: (OUTFIT_BUY_TGAS * 10n ** 12n).toString(), deposit: '0', signer: env.SERVER_ACCOUNT_ID });
    expect(h.net().contract.buys).toEqual([{ token_id: '5', item: 3, price: PRICE.toString() }]);
    expect(await row()).toMatchObject({ id: res.body.id, status: 'bought', code: null, given_yocto: PRICE.toString() });
    expect((await row()).tx_hash).toMatch(/\S/);
    // the pet is in it at once (`Outfit rule` › «надел»), the tab closed or not
    expect(await worn()).toBe('smart-glasses');
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toEqual([{ name: 'outfit_bought', props: { item: 'smart_glasses', price_usd: usd(PRICE), given_usd: usd(PRICE) } }]);
    // the read says it: nothing in flight, the outcome of the id the tab watched
    expect((await view()).body).toMatchObject({
      owned: ['smart-glasses'],
      worn: 'smart-glasses',
      buying: null,
      outcome: { id: res.body.id, item: 'smart-glasses', status: 'bought', code: null },
    });
    expect(h.logs()).toContain('outfit_bought');
  });

  // spec: add-wardrobe › Outfit purchase flow › куплено × the server's end
  it('fires given_usd 0 when the project food paid the whole price, and adds the gas to the project spend', async () => {
    well();
    h.net().contract.burnt = '1000000000000000000000';
    await buy('headphones');
    await done();
    expect(h.events().find((e) => e.name === 'outfit_bought')!.props).toMatchObject({ item: 'headphones', given_usd: 0 });
    const spend = await env.DB.prepare("SELECT usd_micros FROM project_spend WHERE kind = 'gas'").all<any>();
    expect(spend.results).toHaveLength(1);
    expect(spend.results[0].usd_micros).toBeGreaterThan(0);
  });

  // spec: add-wardrobe › Outfit purchase flow › куплено × the server's end
  it('shows the outcome for ten minutes and no longer', async () => {
    well();
    const res = await buy('party-hat');
    await done();
    expect((await view()).body.outcome).toMatchObject({ id: res.body.id, status: 'bought' });
    vi.setSystemTime(Date.now() + 9 * 60_000);
    expect((await view()).body.outcome).toMatchObject({ id: res.body.id });
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect((await view()).body.outcome).toBeNull();
  });
});

describe('Outfit purchase flow: the refusals', () => {
  // spec: add-wardrobe › Outfit purchase flow › не прошло × the server's refusals
  it('fails a row with no transaction when the item arrived since, the pet is short of food, or the gas pause began', async () => {
    well();
    // the item is on the chain by the time the desk looks
    let id = await queueBuy(env.DB, '5', 'smart-glasses');
    h.net().contract.pets.get('5')!.outfits = [3];
    await done();
    expect(await row()).toMatchObject({ id, status: 'failed', code: 'owned' });

    // starter food alone is not enough: the pet would not stay «Full» (`Outfit purchase flow` › «мало еды»)
    h.net().contract.addPet('5', OWNER);
    id = await queueBuy(env.DB, '5', 'bow-tie');
    await done();
    expect(await row()).toMatchObject({ id, status: 'failed', code: 'short' });

    // the gas pause began after the tap
    well();
    id = await queueBuy(env.DB, '5', 'party-hat');
    await setPause(env.DB, 'gas', Date.now());
    await done();
    expect(await row()).toMatchObject({ id, status: 'failed', code: 'paused' });

    expect(buySends()).toEqual([]);
    expect(h.net().contract.buys).toEqual([]);
    expect(await worn()).toBeNull();
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toEqual([]);
    expect(h.logs()).toEqual(expect.arrayContaining(['outfit_buy_failed:owned', 'outfit_buy_failed:short', 'outfit_buy_failed:paused']));
  });

  // spec: add-wardrobe › Outfit purchase flow › не прошло × the server's refusals
  it('fails a row with the chain\'s refusal and nothing worn, and a new tap is a new row', async () => {
    well();
    h.net().contract.buyFails = 'over_food';
    const first = await buy('smart-glasses');
    await done();
    expect(await row()).toMatchObject({ id: first.body.id, status: 'failed', code: 'short' });
    expect(buySends()).toHaveLength(1);
    expect(await worn()).toBeNull();
    expect((await view()).body).toMatchObject({ owned: [], buying: null, outcome: { id: first.body.id, status: 'failed', code: 'short' } });

    h.net().contract.buyFails = null;
    const again = await buy('smart-glasses');
    expect(again.body.id).not.toBe(first.body.id);
    await done();
    expect((await rows()).map((r) => r.status)).toEqual(['failed', 'bought']);
    expect(await worn()).toBe('smart-glasses');
  });

  // spec: add-wardrobe › Outfit purchase flow › не прошло × over the daily cap with unbilled thoughts
  it('refuses with no transaction when the price and the thoughts the network has not seen go over the cap, and passes at the cap exactly', async () => {
    well();
    const unbilled = (price: bigint) =>
      env.DB.prepare(
        "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES (?, '5', 1, 'reply', 'Hi', 'Hello', 'm', ?, 0, 'pet', 'unbilled')",
      )
        .bind(crypto.randomUUID(), price.toString())
        .run();
    await unbilled(DAILY_CAP_YOCTO - PRICE + 1n);
    const id = await queueBuy(env.DB, '5', 'smart-glasses');
    await done();
    expect(await row()).toMatchObject({ id, status: 'failed', code: 'cap' });
    expect(buySends()).toEqual([]);

    // a yocto less of the thoughts: the cap passes
    await env.DB.exec(`UPDATE thoughts SET price_yocto = '${(DAILY_CAP_YOCTO - PRICE).toString()}'`);
    await buy('smart-glasses');
    await done();
    expect((await row()).status).toBe('bought');
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × 00:00 UTC
  it('leaves the day\'s cap to the chain: a purchase that lands in the old day is refused there, in the new one it goes through', async () => {
    const today = Math.floor(Date.now() / DAY_MS);
    well({ debit_day: today, debited_today: DAILY_CAP_YOCTO.toString() });
    // 00:00:30 of the next day for the Worker, the chain still on the old day
    vi.setSystemTime((today + 1) * DAY_MS + 30_000);
    h.net().contract.dayOverride = today;
    await buy('smart-glasses');
    await done();
    expect(await row()).toMatchObject({ status: 'failed', code: 'cap' });
    expect(buySends()).toHaveLength(1);

    // the chain's block is in the new day: the cap is fresh
    h.net().contract.dayOverride = null;
    await buy('smart-glasses');
    await done();
    expect((await row()).status).toBe('bought');
    expect(await petView(env, '5')).toMatchObject({ debit_day: today + 1, debited_today: PRICE.toString() });
  });

  // spec: add-wardrobe › Outfit purchase flow › покупки на паузе × the server refuses
  it('takes no tap on the gas pause: 409 paused, no row, nothing spent; a low balance pauses it now', async () => {
    well();
    await setPause(env.DB, 'gas', Date.now());
    expect(await buy('smart-glasses')).toMatchObject({ status: 409, body: { code: 'paused' } });
    expect(await rows()).toEqual([]);

    await clearPause(env.DB);
    h.net().contract.serverBalance = 1n;
    expect(await buy('smart-glasses')).toMatchObject({ status: 409, body: { code: 'paused' } });
    expect(await rows()).toEqual([]);
    expect((await env.DB.prepare('SELECT reason FROM service_pause WHERE id = 1').first<any>()).reason).toBe('gas');
    expect(buySends()).toEqual([]);
    expect(h.net().contract.buys).toEqual([]);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупки на паузе × the AI pause lets it through
  it('goes through on the pause of NEAR AI', async () => {
    well();
    await setPause(env.DB, 'ai', Date.now());
    expect((await buy('smart-glasses')).status).toBe(202);
    await done();
    expect((await row()).status).toBe('bought');
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × the pause starts
  it('fails a purchase on the way when the gas pause starts before the desk takes it, and spends nothing', async () => {
    well();
    const id = await queueBuy(env.DB, '5', 'smart-glasses');
    await setPause(env.DB, 'gas', Date.now());
    await done();
    expect(await row()).toMatchObject({ id, status: 'failed', code: 'paused' });
    expect(buySends()).toEqual([]);
    expect(h.net().contract.buys).toEqual([]);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × the pet falls asleep
  it('fails a purchase on the way when the pet fell asleep first', async () => {
    well();
    const id = await queueBuy(env.DB, '5', 'smart-glasses');
    h.net().contract.pets.get('5')!.given_food = '0';
    h.net().contract.pets.get('5')!.project_food = (STARTER / 20n).toString();
    await done();
    expect(await row()).toMatchObject({ id, status: 'failed', code: 'short' });
    expect(buySends()).toEqual([]);
  });

  // spec: add-wardrobe › Outfit purchase flow › мало еды × the boundary of Full
  it('buys with a yocto of food over the edge of Full after the price, and refuses at the edge', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: '0', given_food: (EDGE + PRICE).toString() });
    const id = await queueBuy(env.DB, '5', 'smart-glasses');
    await done();
    expect(await row()).toMatchObject({ id, status: 'failed', code: 'short' });
    expect(buySends()).toEqual([]);

    h.net().contract.pets.get('5')!.given_food = (EDGE + 1n + PRICE).toString();
    await buy('smart-glasses');
    await done();
    expect((await row()).status).toBe('bought');
    // the chain took the price and the pet is still «Full»
    expect((await api('/api/pets/5', { token: await owner() })).body.fullness.state).toBe('full');
  });
});

describe('Outfit purchase flow: on its way', () => {
  // spec: add-wardrobe › Outfit purchase flow › покупает × a second tab, the same item
  it('makes one row for two taps of one item, from any tab, and the read says what is on its way', async () => {
    well();
    const release = holdSends();
    const a = await buy('smart-glasses');
    const b = await buy('smart-glasses', await token('did:privy:owner', OWNER, { sid: 'tab-b' }));
    expect(a.status).toBe(202);
    expect(b.body.id).toBe(a.body.id);
    expect(await rows()).toHaveLength(1);
    expect((await view()).body).toMatchObject({ buying: { id: a.body.id, item: 'smart-glasses' }, outcome: null, owned: [] });

    release();
    await done();
    expect(buySends()).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    expect((await row()).status).toBe('bought');
    // and a tap after it landed is the chain's 409
    expect((await buy('smart-glasses')).status).toBe(409);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × a second tab, another item
  it('queues another item behind the one on its way, and checks it with the first one in', async () => {
    well();
    const release = holdSends();
    const first = await buy('smart-glasses');
    const second = await buy('bow-tie');
    expect(second.body.id).not.toBe(first.body.id);
    expect((await rows()).map((r) => r.status)).toEqual(['sending', 'queued']);
    // the oldest open row is what the read calls buying
    expect((await view()).body.buying).toEqual({ id: first.body.id, item: 'smart-glasses' });

    release();
    await done();
    expect(h.net().contract.buys.map((b) => b.item)).toEqual([3, 4]);
    expect((await rows()).map((r) => r.status)).toEqual(['bought', 'bought']);
    // the last to land is on the pet
    expect(await worn()).toBe('bow-tie');
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × sign-out and the session expiring
  it('goes on when the owner signs out, and the result stands at the next visit', async () => {
    well();
    const tab = await token('did:privy:owner', OWNER, { sid: 'sid-1' });
    const release = holdSends();
    const res = await buy('smart-glasses', tab);
    expect((await api('/api/session/end', { method: 'POST', token: tab })).status).toBe(204);
    expect(await view(tab)).toMatchObject({ status: 401, body: { code: 'signed_out' } });
    release();
    await done();
    expect((await row()).status).toBe('bought');
    const next = await token('did:privy:owner', OWNER, { sid: 'sid-2' });
    expect((await view(next)).body).toMatchObject({ owned: ['smart-glasses'], worn: 'smart-glasses', outcome: { id: res.body.id, status: 'bought' } });
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × the pet given away
  it('lands for the pet when it was given away on the way: the new owner has it, the old one gets 403', async () => {
    well();
    const release = holdSends();
    await buy('smart-glasses');
    h.net().contract.pets.get('5')!.owner_id = OTHER;
    release();
    await done();
    expect(h.net().contract.buys).toEqual([{ token_id: '5', item: 3, price: PRICE.toString() }]);
    const newOwner = await token('did:privy:other', OTHER);
    expect((await view(newOwner)).body).toMatchObject({ owned: ['smart-glasses'], worn: 'smart-glasses' });
    expect(await view()).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await buy('bow-tie')).toMatchObject({ status: 403, body: { code: 'not_owner' } });
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × Wear of another item
  it('lets the owner wear another item meanwhile, and a landing purchase wears its own', async () => {
    well({ outfits: [0] });
    const release = holdSends();
    await buy('smart-glasses');
    expect((await api('/api/pets/5/wardrobe/wear', { token: await owner(), body: { item: 'daisy-crown' } })).body).toEqual({ worn: 'daisy-crown' });
    expect(await worn()).toBe('daisy-crown');
    release();
    await done();
    expect(await worn()).toBe('smart-glasses');
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × a clear of the memory
  it('goes on through a clear of the memory: it is not a row of jobs', async () => {
    well();
    const release = holdSends();
    await buy('smart-glasses');
    expect((await api('/api/pets/5/memory/clear', { token: await owner(), body: {} })).status).toBe(200);
    expect((await rows()).map((r) => r.status)).toEqual(['sending']);
    release();
    await done();
    expect((await rows()).map((r) => r.status)).toEqual(['bought']);
    expect(await worn()).toBe('smart-glasses');
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × a thought queued behind it
  it('runs the purchase before a thought queued behind it, and the thought is checked with the item in', async () => {
    well();
    const tk = await owner();
    const release = holdSends();
    await buy('smart-glasses');
    const sent = await api('/api/pets/5/thoughts', { token: tk, body: { text: 'Hello there', mode: 'chat' } });
    expect(sent.status).toBe(202);
    // the line waits for the send: no call to NEAR AI while the purchase is out
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.net().ai.calls).toHaveLength(0);

    release();
    const out = await settle(tk, '5', sent.body.job);
    expect(out.thought.text).toMatch(/\S/);
    expect((await row()).status).toBe('bought');
    // the request already carried the new manner: the item was on the pet before the thought was built
    expect(h.net().ai.calls.at(-1)!.body.messages[0]!.content).toContain('You wear smart glasses.');
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × a debit lands
  it('counts the food and the cap that a debit takes while the price is held', async () => {
    const pet = well({ project_food: '0', given_food: (10n * PRICE).toString() });
    await env.DB.prepare("INSERT INTO outfit_buys (id, token_id, item, status, price_yocto, created_at) VALUES ('a', '5', 'smart-glasses', 'unknown', ?, 1)").bind(PRICE.toString()).run();
    const day = Math.floor(Date.now() / DAY_MS);
    const before = await foodState(env.DB, '5', (await petView(env, '5'))!, Date.now());
    expect(before).toMatchObject({ held: PRICE, eff: 10n * PRICE, room: 9n * PRICE, capLeft: DAILY_CAP_YOCTO - PRICE });

    // a debit lands: the food on the chain falls and the day's counter rises, the held price stays
    const taken = 3n * PRICE;
    pet.given_food = (10n * PRICE - taken).toString();
    pet.debit_day = day;
    pet.debited_today = taken.toString();
    const after = await foodState(env.DB, '5', (await petView(env, '5'))!, Date.now());
    expect(after).toMatchObject({ held: PRICE, eff: 7n * PRICE, room: 6n * PRICE, capLeft: DAILY_CAP_YOCTO - taken - PRICE });
  });
});

describe('Outfit purchase flow: an outcome that is not known', () => {
  /** A send the network executed and whose answer was lost: `unknown` with its hash. */
  async function lostAnswer(item = 'smart-glasses') {
    h.net().contract.mode = 'executed-but-silent';
    const res = await buy(item);
    await done();
    h.net().contract.mode = 'normal';
    return res.body.id as string;
  }

  // spec: add-wardrobe › Outfit purchase flow › покупает × outcome unknown
  it('keeps «Buying…» when the answer is lost, and the cron finds the item on the chain: bought, once', async () => {
    well({ project_food: '0' });
    const id = await lostAnswer();
    expect(await row()).toMatchObject({ id, status: 'unknown' });
    expect((await row()).tx_hash).toMatch(/\S/);
    expect(await worn()).toBeNull();
    // no outcome, the purchase still on its way
    expect((await view()).body).toMatchObject({ buying: { id, item: 'smart-glasses' }, outcome: null });
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toEqual([]);

    await settleBuys(env, Date.now() + 60_000);
    expect(await row()).toMatchObject({ id, status: 'bought', code: null });
    expect(await worn()).toBe('smart-glasses');
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toHaveLength(1);
    expect((await view()).body).toMatchObject({ buying: null, outcome: { id, status: 'bought' } });

    // the next minute finds nothing to do
    await settleBuys(env, Date.now() + 120_000);
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toHaveLength(1);
    expect(buySends()).toHaveLength(1);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × outcome unknown
  it('asks the network by the hash when the chain does not show the item: a refusal it gave is failed, nothing worn', async () => {
    well();
    h.net().contract.buyFails = 'over_food';
    const id = await lostAnswer();
    expect((await row()).status).toBe('unknown');
    await settleBuys(env, Date.now() + 60_000);
    expect(await row()).toMatchObject({ id, status: 'failed', code: 'short' });
    expect(await worn()).toBeNull();
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toEqual([]);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × 24 hours unknown
  it('waits for a hash the network has never seen, and fails the row only at 24 hours', async () => {
    well();
    h.net().contract.mode = 'lost';
    const res = await buy('smart-glasses');
    await done();
    h.net().contract.mode = 'normal';
    expect(await row()).toMatchObject({ id: res.body.id, status: 'unknown' });

    const created = (await row()).created_at as number;
    await settleBuys(env, created + 23 * 3_600_000);
    expect((await row()).status).toBe('unknown');
    await settleBuys(env, created + 24 * 3_600_000);
    expect(await row()).toMatchObject({ status: 'failed', code: 'expired' });
    expect(await worn()).toBeNull();
    // the owner can try again: a new row
    expect((await buy('smart-glasses')).body.id).not.toBe(res.body.id);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × outcome unknown
  it('runs a row nobody ran after a minute, and leaves a younger one alone', async () => {
    well();
    const id = await queueBuy(env.DB, '5', 'smart-glasses');
    const created = (await row()).created_at as number;
    await settleBuys(env, created + 59_000);
    expect(await row()).toMatchObject({ id, status: 'queued' });
    await settleBuys(env, created + 61_000);
    expect(await row()).toMatchObject({ id, status: 'bought' });
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × outcome unknown and a thought
  it('lets the pet answer while the outcome is unknown, from the food that is left after the held price', async () => {
    const bound = await learnBound(h, 'Hello there');
    // the food above the held price covers a 60-token call and not more
    const room = ceilingPrice(env, bound, 60);
    h.net().contract.addPet('5', OWNER, { project_food: '0', given_food: (PRICE + room).toString() });
    const tk = await owner();
    await env.DB.prepare("INSERT INTO outfit_buys (id, token_id, item, status, price_yocto, tx_hash, created_at) VALUES ('a', '5', 'smart-glasses', 'unknown', ?, 'h', 1)").bind(PRICE.toString()).run();

    const out = await say(tk, '5', 'Hello there');
    expect(out.thought.text).toMatch(/\S/);
    const held = h.net().ai.calls.at(-1)!.body.max_tokens as number;
    const price = BigInt((await env.DB.prepare("SELECT price_yocto FROM thoughts WHERE token_id = '5'").first<any>()).price_yocto);
    expect(price).toBeLessThanOrEqual(room);
    expect(held).toBeLessThanOrEqual(60);

    // the same pet with nothing held plans a larger call
    await env.DB.exec('DELETE FROM outfit_buys');
    await env.DB.exec("DELETE FROM thoughts WHERE token_id = '5'");
    await say(tk, '5', 'Hello there');
    expect(h.net().ai.calls.at(-1)!.body.max_tokens).toBeGreaterThan(held);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × nothing in the fullness until it lands
  it('keeps the pet\'s fullness on the food it has, and only the next price in the read is short', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: '0', given_food: (EDGE + 1n + PRICE).toString() });
    const tk = await owner();
    const fullness = async () => (await api('/api/pets/5', { token: tk })).body.fullness;
    const level = await fullness();
    expect(level.state).toBe('full');
    expect((await view(tk)).body.short).toBe(false);

    await env.DB.prepare("INSERT INTO outfit_buys (id, token_id, item, status, price_yocto, tx_hash, created_at) VALUES ('a', '5', 'smart-glasses', 'unknown', ?, 'h', 1)").bind(PRICE.toString()).run();
    expect(await fullness()).toEqual(level);
    // the price is held: another would leave the pet below Full
    expect((await view(tk)).body.short).toBe(true);
  });
});

describe('Outfit purchase flow: the cron', () => {
  // spec: add-wardrobe › Outfit purchase flow › покупает × outcome unknown
  it('runs in the minute tick, after the riddle: a row nobody ran is run and a lost answer is found', async () => {
    well();
    await queueBuy(env.DB, '5', 'smart-glasses');
    const created = (await row()).created_at as number;
    vi.setSystemTime(created + 61_000);
    await tick(env, Date.now());
    expect((await row()).status).toBe('bought');
    expect(h.logs()).not.toContain('tick_failed:outfits');
  });

  // spec: add-wardrobe › Outfit purchase flow › куплено × the server's end
  it('cleans the rows that are over a day old and keeps the open ones and the young ones', async () => {
    const insert = (id: string, status: string, settled: number | null) =>
      env.DB.prepare("INSERT INTO outfit_buys (id, token_id, item, status, price_yocto, created_at, settled_at) VALUES (?, '5', 'bow-tie', ?, ?, 1, ?)")
        .bind(id, status, PRICE.toString(), settled)
        .run();
    const now = Date.now();
    await insert('old-bought', 'bought', now - DAY_MS - 1);
    await insert('old-failed', 'failed', now - DAY_MS - 1);
    await insert('young', 'bought', now - DAY_MS + 60_000);
    await insert('open', 'unknown', null);
    await clean(env, now);
    expect((await rows()).map((r) => r.id).sort()).toEqual(['open', 'young']);
  });
});

describe('Outfit purchase flow: two writers', () => {
  // spec: add-wardrobe › Outfit purchase flow › покупает × outcome unknown
  it('settles a row once: the writer that comes second changes nothing and fires nothing', async () => {
    well({ outfits: [0] });
    await buy('smart-glasses');
    await done();
    const settled = (await row()) as BuyRow;
    expect(await worn()).toBe('smart-glasses');
    await api('/api/pets/5/wardrobe/wear', { token: await owner(), body: { item: 'daisy-crown' } });

    expect(await finishBuy(env, settled, { status: 'bought', burnt: '1' })).toBe(false);
    expect(await finishBuy(env, settled, { status: 'failed', code: 'expired' })).toBe(false);
    expect(await worn()).toBe('daisy-crown');
    expect((await row()).status).toBe('bought');
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM project_spend WHERE kind = 'gas'").first()).toEqual({ n: 0 });
  });
});
