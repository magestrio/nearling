import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { foodState, fullnessOf } from '../src/pet/view';
import { petView } from '../src/chain';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { errand, richPet, owner } from './helpers/errands';

const h = harness();
const OWNER = NEAR_ACCOUNT(701);
const S = BigInt(env.STARTER_FOOD);

describe('reserved food remains separate', () => {
  // spec: add-pet-will › Wish sheet screen › success
  it('shows the public reserve while using only ordinary food for fullness and spendable room', async () => {
    h.net().contract.addPet('701', OWNER, { project_food: '0', given_food: '0', wish_reserve: (5n * S).toString(), wish_active: true });
    const pet = (await petView(env, '701'))!;
    const food = await foodState(env.DB, '701', pet, Date.now());
    expect(food).toMatchObject({ eff: 0n, room: 0n, reserved: 5n * S });
    expect((await fullnessOf(env.DB, '701', pet)).state).toBe('asleep');
    const view = await api('/api/pets/701', { token: await token('did:privy:will-food', OWNER) });
    expect(view.body).toMatchObject({ wishReserveYocto: (5n * S).toString(), wishActive: true, fullness: { state: 'asleep' } });
    const visitor = await api('/api/pets/701');
    expect(visitor.body).toMatchObject({ fullness: { state: 'asleep' } });
    expect(visitor.body).not.toHaveProperty('wishReserveYocto');
    h.net().contract.pets.get('701')!.given_food = S.toString();
    const fed = (await petView(env, '701'))!;
    expect((await fullnessOf(env.DB, '701', fed)).state).not.toBe('asleep');
    expect((await foodState(env.DB, '701', fed, Date.now())).reserved).toBe(5n * S);
  });

  // spec: add-pet-will › Wish sheet screen › success
  it('does not use reserve for Wardrobe affordability or ordinary owner errands', async () => {
    h.net().contract.addPet('701', OWNER, { project_food: '0', given_food: '0', wish_reserve: (5n * S).toString(), wish_active: true });
    const tk = await token('did:privy:will-food', OWNER);
    expect((await api('/api/pets/701/wardrobe', { token: tk })).body.short).toBe(true);
    const job = await api('/api/pets/701/errand?form=read', { token: tk });
    expect(job.body).not.toHaveProperty('wishReserveYocto');
    expect(h.net().ai.calls).toHaveLength(0);
  });

  // spec: add-pet-will › Wish pursuit flow › earned food settles
  it('subtracts linked food and held owner debits from spendable room without touching reserve', async () => {
    h.net().contract.addPet('701', OWNER, { project_food: S.toString(), given_food: S.toString(), wish_reserve: S.toString(), wish_active: true });
    await env.DB.prepare("INSERT INTO outfit_buys (id, token_id, item, status, price_yocto, created_at) VALUES ('held', '701', 'smart-glasses', 'unknown', ?, ?)")
      .bind((S / 4n).toString(), Date.now()).run();
    const pet = (await petView(env, '701'))!;
    const food = await foodState(env.DB, '701', pet, Date.now());
    expect(food.eff).toBe(2n * S);
    expect(food.held).toBe(S / 4n);
    expect(food.room).toBe(2n * S - S / 4n);
    expect(food.reserved).toBe(S);
  });

  // spec: add-pet-will › Wish pursuit flow › earned food settles
  it('keeps linked food separate from both ordinary room and wish reserve', async () => {
    h.net().contract.addPet('701', OWNER, { project_food: S.toString(), given_food: S.toString(), wish_reserve: S.toString(), wish_active: true,
      shared_job: { hash: 'linked', state: 'Running', allowance: S.toString(), linked_near: (S / 2n).toString(), linked_snack: '0' } });
    const pet = (await petView(env, '701'))!;
    const ordinary = await foodState(env.DB, '701', pet, Date.now());
    const linked = await foodState(env.DB, '701', pet, Date.now(), 'linked');
    expect(ordinary.room).toBe(2n * S - S / 2n);
    expect(linked.room).toBe(2n * S);
    expect(linked.reserved).toBe(S);
  });

  // spec: add-pet-will › Character refusal flow › society refusal first
  it('runs the owner’s ordinary errand without a character screening claim', async () => {
    richPet(h, { wish_reserve: S.toString(), wish_active: true });
    h.net().ai.push({ content: 'I read it.' });
    const result = await errand(await owner(), 'read', 'Read this short note.');
    expect(result).not.toMatchObject({ code: 'asleep' });
    expect((await env.DB.prepare('SELECT * FROM will_screenings').all()).results).toHaveLength(0);
  });
});
