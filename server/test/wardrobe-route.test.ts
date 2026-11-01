// The routes of the wardrobe (`add-wardrobe` › group 3.3): the read of the screen, «Wear» and
// «Take off», a notice shown. Each takes the owner from the contract on the request, uncached.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const OTHER = NEAR_ACCOUNT(2);
const owner = () => token('did:privy:owner', OWNER);
const other = () => token('did:privy:other', OTHER);
const STARTER = BigInt(env.STARTER_FOOD);
const PRICE = BigInt(env.OUTFIT_PRICE);

const wardrobe = async (tk?: string) => api('/api/pets/5/wardrobe', tk === undefined ? {} : { token: tk });
const wear = async (item: unknown, tk?: string) => api('/api/pets/5/wardrobe/wear', { token: tk ?? (await owner()), body: { item } });
const seen = async (item: unknown, tk?: string) => api('/api/pets/5/wardrobe/seen', { token: tk ?? (await owner()), body: { item } });
const row = () => env.DB.prepare('SELECT worn, seen FROM wardrobe WHERE token_id = ?').bind('5').first<{ worn: string | null; seen: number }>();

describe('Wardrobe screen', () => {
  // spec: add-wardrobe › Wardrobe screen › success × the view of the owner
  it('answers the owner with the items, the worn one, the price and nothing in flight', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0, 2, 6] });
    await wear('thinking-cap');
    const res = await wardrobe(await owner());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      owned: ['daisy-crown', 'thinking-cap', 'party-hat'],
      worn: 'thinking-cap',
      price: { cents: 0.76, yocto: env.OUTFIT_PRICE },
      short: true,
      shopPaused: false,
      buying: null,
      outcome: null,
    });
  });

  // spec: add-wardrobe › Wardrobe screen › error × the read refused
  it('says 503 chain_unreachable when the owner cannot be read, and 403 not_owner to a guest, before anything is read', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().contract.down = true;
    expect(await wardrobe(tk)).toMatchObject({ status: 503, body: { code: 'chain_unreachable' } });
    h.net().contract.down = false;
    expect(await wardrobe(await other())).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    h.net().contract.pets.delete('5');
    expect(await wardrobe(tk)).toMatchObject({ status: 404, body: { code: 'no_pet' } });
  });

  // spec: add-wardrobe › Wardrobe screen › signed-out × no session at the routes
  it('turns away a call with no session, and writes nothing', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0] });
    expect(await wardrobe()).toMatchObject({ status: 401, body: { code: 'signed_out' } });
    expect(await api('/api/pets/5/wardrobe/wear', { body: { item: 'daisy-crown' } })).toMatchObject({ status: 401 });
    expect(await api('/api/pets/5/wardrobe/seen', { body: { item: 'daisy-crown' } })).toMatchObject({ status: 401 });
    // a bad body without a session is still the missing session
    expect(await api('/api/pets/5/wardrobe/wear', { body: { item: 7 } })).toMatchObject({ status: 401 });
    expect(await row()).toBeNull();
  });

  // spec: add-wardrobe › Wardrobe screen › success × the view of the owner
  it('reads a pet that has not been touched: nothing owned, nothing worn', async () => {
    h.net().contract.addPet('5', OWNER);
    expect((await wardrobe(await owner())).body).toMatchObject({ owned: [], worn: null });
  });
});

describe('Outfit purchase flow', () => {
  // spec: add-wardrobe › Outfit purchase flow › мало еды
  it('says short on the starter food and with the food at the edge of Full after the price, and not short above it', async () => {
    const pet = h.net().contract.addPet('5', OWNER, { project_food: STARTER.toString() });
    const tk = await owner();
    expect((await wardrobe(tk)).body.short).toBe(true);

    // After the price the pet must stay above 23/24 of the starter food (`Pet condition rule`: «Full»).
    const edge = (23n * STARTER) / 24n; // floor: 24 x edge < 23 x starter, not Full
    pet.project_food = '0';
    pet.given_food = (edge + PRICE).toString();
    expect((await wardrobe(tk)).body.short).toBe(true);
    pet.given_food = (edge + 1n + PRICE).toString();
    expect((await wardrobe(tk)).body.short).toBe(false);
  });

  // spec: add-wardrobe › Outfit purchase flow › мало еды
  it('counts a thought answered and not yet debited against the food', async () => {
    h.net().contract.addPet('5', OWNER, { given_food: (10n ** 24n).toString() });
    const tk = await owner();
    expect((await wardrobe(tk)).body.short).toBe(false);
    await env.DB.prepare(
      "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES ('t', '5', 1, 'reply', 'Hi', 'Hello', 'm', ?, 0, 'pet', 'unbilled')",
    )
      .bind((10n ** 24n).toString())
      .run();
    expect((await wardrobe(tk)).body.short).toBe(true);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупки на паузе × the AI pause lets it through
  it('says shopPaused on the gas pause only', async () => {
    h.net().contract.addPet('5', OWNER, { given_food: (10n ** 24n).toString() });
    const tk = await owner();
    await env.DB.exec("INSERT INTO service_pause (id, reason, since) VALUES (1, 'ai', 1) ON CONFLICT (id) DO UPDATE SET reason = 'ai'");
    expect((await wardrobe(tk)).body.shopPaused).toBe(false);
    await env.DB.exec("UPDATE service_pause SET reason = 'gas' WHERE id = 1");
    expect((await wardrobe(tk)).body.shopPaused).toBe(true);
  });
});

describe('Outfit rule', () => {
  // spec: add-wardrobe › Outfit rule › надел × the server's end
  it('wears an item the pet has on the chain, and a second item takes the first one off', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0, 2] });
    expect(await wear('daisy-crown')).toMatchObject({ status: 200, body: { worn: 'daisy-crown' } });
    expect(await row()).toEqual({ worn: 'daisy-crown', seen: 0 });
    expect(await wear('thinking-cap')).toMatchObject({ status: 200, body: { worn: 'thinking-cap' } });
    expect(await row()).toEqual({ worn: 'thinking-cap', seen: 0 });
    // the read says it, and the owner's view with it
    expect((await wardrobe(await owner())).body.worn).toBe('thinking-cap');
    expect((await api('/api/pets/5', { token: await owner() })).body.worn).toBe('thinking-cap');
    // nothing left the Worker for it but the owner's read
    expect(h.net().contract.sends).toEqual([]);
  });

  // spec: add-wardrobe › Outfit rule › надел × an item it does not have
  it('refuses an item the pet does not hold on the chain, and an unknown or malformed one', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0] });
    expect(await wear('smart-glasses')).toMatchObject({ status: 409, body: { code: 'not_owned' } });
    expect(await wear('a-hat')).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await wear(7)).toMatchObject({ status: 400 });
    expect(await api('/api/pets/5/wardrobe/wear', { token: await owner(), body: {} })).toMatchObject({ status: 400 });
    expect(await row()).toBeNull();
  });

  // spec: add-wardrobe › Outfit rule › надел × the chain does not read
  it('puts nothing on when the owner cannot be read', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0] });
    const tk = await owner();
    h.net().contract.down = true;
    expect(await wear('daisy-crown', tk)).toMatchObject({ status: 503, body: { code: 'chain_unreachable' } });
    expect(await row()).toBeNull();
  });

  // spec: add-wardrobe › Outfit rule › снял × the server's end
  it('takes the item off with null, and nothing worn is a pet with no outfit', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0] });
    await wear('daisy-crown');
    expect(await wear(null)).toMatchObject({ status: 200, body: { worn: null } });
    expect(await row()).toEqual({ worn: null, seen: 0 });
    expect((await wardrobe(await owner())).body.worn).toBeNull();
    // taking off with nothing on is harmless
    expect(await wear(null)).toMatchObject({ status: 200 });
  });

  // spec: add-wardrobe › Outfit rule › надел × the pet asleep and a new streak
  it('works on an asleep pet, and a streak that lands later keeps the worn item', async () => {
    const pet = h.net().contract.addPet('5', OWNER, { project_food: '0', outfits: [0] });
    expect(await wear('daisy-crown')).toMatchObject({ status: 200 });
    expect(await wear(null)).toMatchObject({ status: 200 });
    expect(await wear('daisy-crown')).toMatchObject({ status: 200 });
    // a mark on the chain: the streak grows and the scarf may come, the worn item stays
    pet.last_streak_day = h.net().contract.day - 1;
    pet.streak = 2;
    expect(h.net().contract.mark(env.SERVER_ACCOUNT_ID, '5', h.net().contract.day, 0)).toEqual({ spent: 0 });
    expect(pet.outfits).toEqual([0, 1]);
    expect((await wardrobe(await owner())).body).toMatchObject({ worn: 'daisy-crown', owned: ['daisy-crown', 'cozy-scarf'] });
  });
});

describe('New outfit notice screen', () => {
  // spec: add-wardrobe › New outfit notice screen › success × seen marks it once
  it('marks an earned item\'s notice shown, once, and not due again', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0, 1] });
    const tk = await owner();
    expect((await api('/api/pets/5', { token: tk })).body.notices).toEqual(['daisy-crown', 'cozy-scarf']);
    expect(await seen('daisy-crown')).toMatchObject({ status: 200, body: { ok: true } });
    expect(await row()).toEqual({ worn: null, seen: 1 });
    // the same again, and the other: bits add, none is lost
    expect(await seen('daisy-crown')).toMatchObject({ status: 200 });
    expect(await row()).toEqual({ worn: null, seen: 1 });
    expect((await api('/api/pets/5', { token: tk })).body.notices).toEqual(['cozy-scarf']);
    expect(await seen('cozy-scarf')).toMatchObject({ status: 200 });
    expect(await row()).toEqual({ worn: null, seen: 3 });
    expect((await api('/api/pets/5', { token: tk })).body.notices).toEqual([]);
  });

  // spec: add-wardrobe › New outfit notice screen › success × seen marks it once
  it('keeps the worn item when a notice is marked, and the notice when an item is worn', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0, 2] });
    await wear('thinking-cap');
    await seen('daisy-crown');
    expect(await row()).toEqual({ worn: 'thinking-cap', seen: 1 });
    await wear('daisy-crown');
    expect(await row()).toEqual({ worn: 'daisy-crown', seen: 1 });
    expect((await api('/api/pets/5', { token: await owner() })).body.notices).toEqual(['thinking-cap']);
  });

  // spec: add-wardrobe › New outfit notice screen › success × seen marks it once
  it('takes only the name of an earned item, and leaves a notice that is not due yet unmarked', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0] });
    expect(await seen('smart-glasses')).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await seen('moon')).toMatchObject({ status: 400 });
    expect(await seen(null)).toMatchObject({ status: 400 });
    // the Thinking cap is not on the chain yet: its notice must still come when it is
    expect(await seen('thinking-cap')).toMatchObject({ status: 200 });
    expect(await row()).toBeNull();
    h.net().contract.pets.get('5')!.outfits = [0, 2];
    expect((await api('/api/pets/5', { token: await owner() })).body.notices).toEqual(['daisy-crown', 'thinking-cap']);
  });
});

describe('Wardrobe data', () => {
  // spec: add-wardrobe › Wardrobe data › после подарка
  it('does not take Wear, Take off or a notice from the old owner, and writes nothing', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0] });
    const old = await owner();
    await wear('daisy-crown', old);
    h.net().contract.pets.get('5')!.owner_id = OTHER;
    expect(await wear(null, old)).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await seen('daisy-crown', old)).toMatchObject({ status: 403 });
    expect(await wardrobe(old)).toMatchObject({ status: 403 });
    expect(await row()).toEqual({ worn: 'daisy-crown', seen: 0 });
    // the new owner has the worn item and can take it off
    const now = await other();
    expect((await wardrobe(now)).body.worn).toBe('daisy-crown');
    expect(await wear(null, now)).toMatchObject({ status: 200 });
  });
});
