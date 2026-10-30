import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const S = BigInt(env.STARTER_FOOD);

const owner = async () => token('did:privy:owner', OWNER);

async function unbilled(tokenId: string, yocto: bigint, text: string | null = null) {
  await env.DB.prepare(
    "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES (?, ?, 1, 'reply', ?, 'hi', 'm', ?, 0, 'pet', 'unbilled')",
  )
    .bind(crypto.randomUUID(), tokenId, text, yocto.toString())
    .run();
}

describe('what the owner and everyone see of a pet', () => {
  // spec: add-pet › Pet food data › мысль ещё не списана
  it('takes the thoughts not yet debited off the food for the owner, a guest and a visitor alike', async () => {
    h.net().contract.addPet('21', OWNER);
    await unbilled('21', S / 12n); // one scale thought answered, not debited yet
    const expected = { state: 'hungry', level: 11 / 12 };
    const ownerView = await api('/api/pets/21', { token: await owner() });
    const guest = await api('/api/pets/21', { token: await token('did:privy:g', NEAR_ACCOUNT(2)) });
    const visitor = await api('/api/pets/21');
    for (const view of [ownerView, guest, visitor]) {
      expect(view.body.fullness.state).toBe(expected.state);
      expect(view.body.fullness.level).toBeCloseTo(expected.level, 6);
    }
    // the food in the contract did not change
    expect(h.net().contract.pets.get('21')!.project_food).toBe(env.STARTER_FOOD);
  });

  // spec: add-pet › Pet condition rule › Голоден
  it('is «Asleep» when the unbilled thoughts take the last of the food', async () => {
    h.net().contract.addPet('22', OWNER);
    await unbilled('22', S);
    const res = await api('/api/pets/22', { token: await owner() });
    expect(res.body.fullness).toEqual({ state: 'asleep', level: 0 });
  });

  // spec: add-pet › Pet screen › empty
  it('says «hello» until the owner has sent a line, and not after', async () => {
    h.net().contract.addPet('23', OWNER);
    expect((await api('/api/pets/23', { token: await owner() })).body.hello).toBe(true);
    await unbilled('23', 1n, null); // the greeting: no player line
    expect((await api('/api/pets/23', { token: await owner() })).body.hello).toBe(true);
    await unbilled('23', 1n, 'hi there');
    expect((await api('/api/pets/23', { token: await owner() })).body.hello).toBe(false);
  });

  // spec: add-pet › Daily cap rule › Устал
  it('says «tired» to the owner until the end of the UTC day the server wrote it', async () => {
    h.net().contract.addPet('24', OWNER);
    const today = Math.floor(Date.now() / 86_400_000);
    await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, tired_day) VALUES (?, ?, 1, ?, ?)').bind('24', OWNER, 'tx', today).run();
    expect((await api('/api/pets/24', { token: await owner() })).body.tired).toBe(true);
    await env.DB.prepare('UPDATE pets SET tired_day = ? WHERE token_id = ?').bind(today - 1, '24').run();
    expect((await api('/api/pets/24', { token: await owner() })).body.tired).toBe(false);
    // a guest is never told
    await env.DB.prepare('UPDATE pets SET tired_day = ? WHERE token_id = ?').bind(today, '24').run();
    expect(await api('/api/pets/24', { token: await token('did:privy:g', NEAR_ACCOUNT(2)) })).toMatchObject({ body: { viewer: 'guest' } });
  });

  // spec: add-pet › Service pause data › пауза снялась
  it('tells the owner the services are paused, and clears when the pause row is cleared', async () => {
    h.net().contract.addPet('25', OWNER);
    expect((await api('/api/pets/25', { token: await owner() })).body.paused).toBe(false);
    await env.DB.prepare("INSERT INTO service_pause (id, reason, since) VALUES (1, 'ai', 1)").run();
    expect((await api('/api/pets/25', { token: await owner() })).body.paused).toBe(true);
    await env.DB.prepare('UPDATE service_pause SET reason = NULL WHERE id = 1').run();
    expect((await api('/api/pets/25', { token: await owner() })).body.paused).toBe(false);
  });

  // spec: add-pet › Guest view data › предел на IP
  it('serves a visitor from a copy not older than 15 seconds, and reads again after', async () => {
    h.net().contract.addPet('26', OWNER);
    await api('/api/pets/26');
    const reads = () => h.net().contract.reads.filter((r) => r.method === 'pet_view').length;
    expect(reads()).toBe(1);
    await api('/api/pets/26');
    expect(reads()).toBe(1);
    const later = new Date(Date.now() + 16_000);
    vi.setSystemTime(later);
    await api('/api/pets/26');
    expect(reads()).toBe(2);
  });
});
