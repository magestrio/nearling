import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { OUTFIT_PRICE_YOCTO, DAILY_CAP_YOCTO } from '../src/pricing';
import { noteWishSavings, processWishRelease, queueFundedWish } from '../src/will/purchase';
import { desk } from '../src/pet/desk';
import { api, harness, say } from './helpers/api';
import { addHirer, addWorker, PAYER, payerToken } from './helpers/work';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const PRICE = OUTFIT_PRICE_YOCTO;
const OWNER = NEAR_ACCOUNT(701);
const later = () => Date.now() + 11 * 60_000;

async function wish(tokenId = '701', item = 'smart-glasses', reserve = PRICE): Promise<void> {
  h.net().contract.addPet(tokenId, OWNER, { name: 'Pixel', wish_active: true,
    wish_reserve: reserve.toString(), given_food: (5n * BigInt(env.STARTER_FOOD)).toString() });
  await env.DB.prepare("INSERT INTO pet_wishes (token_id, item, reason, status, owner_generation, memory_epoch, diary_day, start_op, created_at, noted_reserve_yocto) VALUES (?, ?, 'I like it', 'active', 0, 0, 1, ?, ?, ?)")
    .bind(tokenId, item, `start-${tokenId}`, Date.now(), reserve.toString()).run();
}

describe('settled will savings', () => {
  // spec: add-pet-will › Wish pursuit flow › earned food settles
  it('records progress only after an accepted hire and never repeats it on a duplicate tick', async () => {
    addHirer(h, { project_food: (10n * BigInt(env.STARTER_FOOD)).toString() });
    await addWorker(h, '6', 2);
    const worker = h.net().contract.pets.get('6')!;
    worker.wish_active = true;
    worker.given_food = (5n * BigInt(env.STARTER_FOOD)).toString();
    await env.DB.prepare("INSERT INTO pet_wishes (token_id, item, reason, status, owner_generation, memory_epoch, diary_day, start_op, created_at) VALUES ('6', 'smart-glasses', 'I like it', 'active', 0, 0, 1, 'start-6', ?)")
      .bind(Date.now()).run();
    const tk = await payerToken();
    h.net().ai.push({ content: 'ASK 1: How?' }, { content: 'Try this.' }, { content: 'I heard it.' });
    await say(tk, PAYER, 'Please help');
    expect(worker.wish_reserve).toBe('0');
    await tick(env, later());
    expect(BigInt(worker.wish_reserve!)).toBeGreaterThan(0n);
    expect(h.events().filter((e) => e.name === 'pet_wish_saved')).toHaveLength(1);
    expect(h.events().find((e) => e.name === 'pet_wish_saved')?.props.saved_usd).toBeGreaterThan(0);
    const noted = await env.DB.prepare("SELECT noted_reserve_yocto FROM pet_wishes WHERE token_id = '6'").first<{ noted_reserve_yocto: string }>();
    expect(noted?.noted_reserve_yocto).toBe(worker.wish_reserve);
    await tick(env, later() + 60_000);
    expect(h.events().filter((e) => e.name === 'pet_wish_saved')).toHaveLength(1);
  });

  // spec: add-pet-will › Wish pursuit flow › earned food settles
  it('records no saving when the debit is rejected', async () => {
    addHirer(h, { project_food: (10n * BigInt(env.STARTER_FOOD)).toString() });
    await addWorker(h, '6', 2);
    h.net().contract.pets.get('6')!.wish_active = true;
    await env.DB.prepare("INSERT INTO pet_wishes (token_id, item, reason, status, owner_generation, memory_epoch, diary_day, start_op, created_at) VALUES ('6', 'smart-glasses', 'I like it', 'active', 0, 0, 1, 'start-6', ?)")
      .bind(Date.now()).run();
    h.net().ai.push({ content: 'ASK 1: How?' }, { content: 'Try this.' }, { content: 'I heard it.' });
    await say(await payerToken(), PAYER, 'Please help');
    h.net().contract.debitFails = 'over_food';
    await tick(env, later());
    expect(h.net().contract.pets.get('6')!.wish_reserve).toBe('0');
    expect(h.events().filter((e) => e.name === 'pet_wish_saved')).toHaveLength(0);
  });

  // spec: add-pet-will › Wish pursuit flow › earned food settles
  it('emits no extra progress when the public reserve is already at the price boundary', async () => {
    await wish();
    await env.DB.prepare("UPDATE pet_wishes SET noted_reserve_yocto = ? WHERE token_id = '701'").bind(PRICE.toString()).run();
    await noteWishSavings(env, ['701', '701']);
    expect(h.events().filter((e) => e.name === 'pet_wish_saved')).toHaveLength(0);
    expect((await env.DB.prepare("SELECT noted_reserve_yocto FROM pet_wishes WHERE token_id = '701'").first<{ noted_reserve_yocto: string }>())?.noted_reserve_yocto).toBe(PRICE.toString());
  });
});

describe('automatic wish purchase', () => {
  // spec: add-pet-will › Wish pursuit flow › automatic purchase
  it('uses only the reserve, confirms one outfit and one bought event', async () => {
    await wish();
    const pet = h.net().contract.pets.get('701')!;
    const ordinary = pet.given_food;
    await tick(env, Date.now());
    expect(h.net().contract.sends.filter((s) => s.method === 'outfit_buy')).toHaveLength(1);
    expect(h.net().contract.sends.find((s) => s.method === 'outfit_buy')?.args).toMatchObject({ token_id: '701', item: 3, via_wish: true });
    expect(pet.given_food).toBe(ordinary);
    expect(pet.wish_reserve).toBe('0');
    expect(pet.outfits).toContain(3);
    expect(h.events().filter((e) => e.name === 'outfit_bought' && e.props.via === 'pet_wish')).toHaveLength(1);
    expect((await api('/api/pets/701/wardrobe', { token: await token('did:privy:will-owner', OWNER) })).body.outcome.source).toBe('pet_wish');
    await tick(env, Date.now());
    expect(h.net().contract.sends.filter((s) => s.method === 'outfit_buy')).toHaveLength(1);
  });

  // spec: add-pet-will › Wish pursuit flow › purchase waits for daily reset
  // spec: add-pet-will › Wish pursuit flow › purchase after daily reset
  it('keeps the reserve at the cap and retries only after the UTC day changes', async () => {
    await wish();
    const pet = h.net().contract.pets.get('701')!;
    pet.debit_day = h.net().contract.day;
    pet.debited_today = DAILY_CAP_YOCTO.toString();
    await tick(env, Date.now());
    expect(pet.wish_reserve).toBe(PRICE.toString());
    expect((await env.DB.prepare("SELECT status FROM pet_wishes WHERE token_id = '701'").first<{ status: string }>())?.status).toBe('waiting_day');
    await tick(env, Date.now() + 60_000);
    expect(h.net().contract.sends.filter((s) => s.method === 'outfit_buy')).toHaveLength(0);
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    await tick(env, Date.now());
    expect(pet.outfits).toContain(3);
    expect(h.net().contract.sends.filter((s) => s.method === 'outfit_buy')).toHaveLength(1);
  });

  // spec: add-pet-will › Wish purchase contract › paused after gift
  it('does not queue a paused gift or an item outside the purchasable catalog', async () => {
    await wish();
    h.net().contract.pets.get('701')!.wish_active = false;
    expect(await queueFundedWish(env, '701', Date.now())).toBe(false);
    await env.DB.prepare("UPDATE pet_wishes SET item = 'thinking-cap'").run();
    h.net().contract.pets.get('701')!.wish_active = true;
    expect(await queueFundedWish(env, '701', Date.now())).toBe(false);
    expect(h.net().contract.sends.filter((s) => s.method === 'outfit_buy')).toHaveLength(0);
  });

  // spec: add-pet-will › Wish pursuit flow › automatic purchase
  it('reconciles a bought outfit whose RPC answer was lost without another purchase', async () => {
    await wish();
    h.net().contract.mode = 'executed-but-silent';
    await tick(env, Date.now());
    await tick(env, Date.now() + 60_000);
    expect(h.net().contract.pets.get('701')!.outfits).toContain(3);
    expect(h.net().contract.sends.filter((s) => s.method === 'outfit_buy')).toHaveLength(1);
    expect(h.events().filter((e) => e.name === 'outfit_bought' && e.props.via === 'pet_wish')).toHaveLength(1);
  });
});

describe('wish release', () => {
  // spec: add-pet-will › Wish pursuit flow › owner cancels
  it('returns the exact reserve once after cancellation and keeps the target on a failed send', async () => {
    await wish();
    const tk = await token('did:privy:will-owner', OWNER);
    h.net().contract.willReleaseFails = 'reserve_short';
    expect((await api('/api/pets/701/wish/cancel', { token: tk, method: 'POST' })).status).toBe(202);
    expect((await env.DB.prepare("SELECT item FROM pet_wishes WHERE token_id = '701'").first<{ item: string }>())?.item).toBe('smart-glasses');
    expect(h.net().contract.pets.get('701')!.wish_reserve).toBe(PRICE.toString());
    h.net().contract.willReleaseFails = null;
    expect((await api('/api/pets/701/wish/cancel', { token: tk, method: 'POST' })).status).toBe(200);
    expect(h.net().contract.pets.get('701')!.given_food).toBe((5n * BigInt(env.STARTER_FOOD) + PRICE).toString());
    expect((await env.DB.prepare("SELECT * FROM pet_wishes WHERE token_id = '701'").first())).toBeNull();
    await api('/api/pets/701/wish/cancel', { token: tk, method: 'POST' });
    expect(h.net().contract.sends.filter((s) => s.method === 'will_release')).toHaveLength(2);
  });

  // spec: add-pet-will › Wish pursuit flow › target bought by owner
  it('waits for a confirmed owner purchase before releasing the reserve', async () => {
    await wish();
    const tk = await token('did:privy:will-owner', OWNER);
    const bought = await api('/api/pets/701/wardrobe/buy', { token: tk, body: { item: 'smart-glasses' } });
    expect(bought.status).toBe(202);
    await desk(env, '701').process('701');
    expect(h.net().contract.pets.get('701')!.outfits).toContain(3);
    expect(h.net().contract.pets.get('701')!.wish_reserve).toBe('0');
    expect((await env.DB.prepare("SELECT * FROM pet_wishes WHERE token_id = '701'").first())).toBeNull();
    expect(h.net().contract.sends.filter((s) => s.method === 'will_release')).toHaveLength(1);
    expect(h.events().filter((e) => e.name === 'pet_wish_canceled')).toHaveLength(0);
  });

  // spec: add-pet-will › Wish pursuit flow › target bought by owner
  it('releases only after an uncertain owner buy is confirmed by the chain', async () => {
    await wish();
    const tk = await token('did:privy:will-owner', OWNER);
    h.net().contract.mode = 'executed-but-silent';
    const queued = await api('/api/pets/701/wardrobe/buy', { token: tk, body: { item: 'smart-glasses' } });
    expect(queued.status).toBe(202);
    await desk(env, '701').process('701');
    await tick(env, Date.now() + 60_000);
    expect(h.net().contract.pets.get('701')!.outfits).toContain(3);
    expect(h.net().contract.pets.get('701')!.wish_reserve).toBe('0');
    expect(h.net().contract.sends.filter((s) => s.method === 'outfit_buy')).toHaveLength(1);
    expect(h.net().contract.sends.filter((s) => s.method === 'will_release')).toHaveLength(1);
  });

  // spec: add-pet-will › Wish pursuit flow › owner cancels × Reload
  it('reconciles an executed release with a lost response without sending twice', async () => {
    await wish();
    const tk = await token('did:privy:will-owner', OWNER);
    h.net().contract.mode = 'executed-but-silent';
    expect((await api('/api/pets/701/wish/cancel', { token: tk, method: 'POST' })).status).toBe(202);
    expect(h.net().contract.pets.get('701')!.wish_reserve).toBe('0');
    await tick(env, Date.now() + 60_000);
    expect((await env.DB.prepare("SELECT * FROM pet_wishes WHERE token_id = '701'").first())).toBeNull();
    expect(h.net().contract.sends.filter((s) => s.method === 'will_release')).toHaveLength(1);
  });

  // spec: add-pet-will › Wish pursuit flow › owner cancels × Second tap
  it('does not send a second release while the first signed transaction is unknown', async () => {
    await wish();
    const tk = await token('did:privy:will-owner', OWNER);
    h.net().contract.mode = 'lost';
    expect((await api('/api/pets/701/wish/cancel', { token: tk, method: 'POST' })).status).toBe(202);
    const first = await env.DB.prepare("SELECT id, tx_hash FROM will_operations WHERE token_id = '701' AND kind = 'release'")
      .first<{ id: string; tx_hash: string }>();
    expect(first?.tx_hash).toBeTruthy();
    expect((await api('/api/pets/701/wish/cancel', { token: tk, method: 'POST' })).status).toBe(202);
    expect((await env.DB.prepare("SELECT id, tx_hash FROM will_operations WHERE token_id = '701' AND kind = 'release'")
      .first<{ id: string; tx_hash: string }>())).toEqual(first);
    expect(h.net().contract.pets.get('701')!.wish_reserve).toBe(PRICE.toString());
  });

  // spec: add-pet-will › Wish pursuit flow › owner cancels × Reload
  it('reconciles a hashed release left in sending after an interrupted Worker', async () => {
    await wish();
    const tk = await token('did:privy:will-owner', OWNER);
    h.net().contract.mode = 'lost';
    await api('/api/pets/701/wish/cancel', { token: tk, method: 'POST' });
    await env.DB.prepare("UPDATE will_operations SET status = 'sending' WHERE token_id = '701' AND kind = 'release'").run();
    h.net().contract.blockHeight = 90_000;
    h.net().contract.mode = 'normal';
    await processWishRelease(env, '701');
    expect((await env.DB.prepare("SELECT status FROM will_operations WHERE token_id = '701' AND kind = 'release'").first<{ status: string }>())?.status).toBe('confirmed');
    expect(h.net().contract.sends.filter((s) => s.method === 'will_release')).toHaveLength(1);
  });

  // spec: add-pet-will › Wish pursuit flow › owner cancels
  it('shows the current release outcome only to the owner on a fresh Wish read', async () => {
    await wish();
    const tk = await token('did:privy:will-owner', OWNER);
    h.net().contract.mode = 'lost';
    await api('/api/pets/701/wish/cancel', { token: tk, method: 'POST' });
    expect((await api('/api/pets/701/wish', { token: tk })).body.releaseStatus).toBe('unknown');
    await env.DB.prepare("UPDATE will_operations SET status = 'failed' WHERE token_id = '701' AND kind = 'release'").run();
    expect((await api('/api/pets/701/wish', { token: tk })).body.releaseStatus).toBe('failed');
    await env.DB.prepare("UPDATE will_operations SET status = 'confirmed' WHERE token_id = '701' AND kind = 'release'").run();
    expect((await api('/api/pets/701/wish', { token: tk })).body.releaseStatus).toBe('confirmed');
  });
});
