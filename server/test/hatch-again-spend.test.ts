import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PET_MINT_TGAS } from '../src/chain';
import { MAX_BIRTH_COST_YOCTO, nearUsdRate, yoctoToUsdMicros } from '../src/pricing';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const PLAYER = NEAR_ACCOUNT(10);
const hatch = async () => api('/api/hatch', { token: await token('did:privy:spend', PLAYER), body: { name: 'Nova' } });
const spend = (micros: number) => env.DB.prepare("INSERT INTO project_spend (at, kind, usd_micros) VALUES (1, 'gas', ?)").bind(micros).run();

describe('birth spend guards', () => {
  // spec: add-hatch-again › Repeat birth spend data › birth stop reached
  it('allows one micro-dollar below $100 and closes at $100 before signing', async () => {
    await spend(99_999_999);
    expect((await hatch()).status).toBe(200);
    h.net().contract.pets.get('0')!.owner_id = NEAR_ACCOUNT(20);
    await env.DB.prepare('DELETE FROM project_spend').run();
    await spend(100_000_000);
    expect(await hatch()).toMatchObject({ status: 409, body: { code: 'closed', reason: 'budget' } });
    await spend(1);
    expect(await hatch()).toMatchObject({ status: 409, body: { code: 'closed', reason: 'budget' } });
    expect(h.net().contract.sends.filter((s) => s.method === 'pet_mint')).toHaveLength(1);
  });

  // spec: add-hatch-again › Repeat birth spend data › total ceiling would be crossed
  it('accepts the exact $120 worst-case remainder and refuses one micro-dollar over', async () => {
    h.net().contract.gasPrice = 300_000_000_000n;
    const rate = nearUsdRate(env.NEAR_USD_RATE)!;
    const projected = yoctoToUsdMicros(MAX_BIRTH_COST_YOCTO + PET_MINT_TGAS * 1_000_000_000_000n * h.net().contract.gasPrice, rate);
    const boundary = 120_000_000 - projected;
    expect(boundary).toBeLessThan(100_000_000);
    await spend(boundary);
    expect((await hatch()).status).toBe(200);
    h.net().contract.pets.get('0')!.owner_id = NEAR_ACCOUNT(20);
    await env.DB.prepare('DELETE FROM project_spend').run();
    await spend(boundary + 1);
    expect(await hatch()).toMatchObject({ status: 409, body: { code: 'closed', reason: 'budget' } });
    expect(h.net().contract.sends.filter((s) => s.method === 'pet_mint')).toHaveLength(1);
  });

  // spec: add-hatch-again › Repeat birth spend data › total ceiling would be crossed
  it('counts another signed birth reservation before this account signs', async () => {
    h.net().contract.gasPrice = 300_000_000_000n;
    const projected = yoctoToUsdMicros(
      MAX_BIRTH_COST_YOCTO + PET_MINT_TGAS * 1_000_000_000_000n * h.net().contract.gasPrice,
      nearUsdRate(env.NEAR_USD_RATE)!,
    );
    await spend(120_000_000 - projected);
    await env.DB.prepare('INSERT INTO births_in_flight (account, started_at, reserved_usd_micros) VALUES (?, ?, 1)')
      .bind(NEAR_ACCOUNT(20), Date.now()).run();
    expect(await hatch()).toMatchObject({ status: 409, body: { code: 'closed', reason: 'budget' } });
    expect(h.net().contract.sends.filter((s) => s.method === 'pet_mint')).toHaveLength(0);
    await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ?').bind(NEAR_ACCOUNT(20)).run();
    expect((await hatch()).status).toBe(200);
  });

  // spec: add-hatch-again › Repeat birth spend data › total ceiling would be crossed
  it('uses the fresh gas quote and pool read for a new attempt', async () => {
    h.net().contract.gasPrice = 300_000_000_000n;
    const projected = yoctoToUsdMicros(
      MAX_BIRTH_COST_YOCTO + PET_MINT_TGAS * 1_000_000_000_000n * h.net().contract.gasPrice,
      nearUsdRate(env.NEAR_USD_RATE)!,
    );
    await spend(120_000_000 - projected);
    h.net().contract.gasPrice += 1n;
    expect((await hatch()).status).toBe(409);
    h.net().contract.gasPrice = 100_000_000n;
    h.net().contract.pool = MAX_BIRTH_COST_YOCTO - 1n;
    expect(await hatch()).toMatchObject({ status: 409, body: { code: 'closed', reason: 'pool' } });
  });

  // spec: add-hatch-again › Repeat pet mint contract › birth above pool ceiling
  it('maps a confirmed contract pool-ceiling refusal to closed without a birth row', async () => {
    h.net().contract.mintFails = 'birth_cost_limit';
    expect(await hatch()).toMatchObject({ status: 409, body: { code: 'closed', reason: 'pool' } });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM pets').first())).toEqual({ n: 0 });
    expect((await env.DB.prepare('SELECT failed, reserved_usd_micros FROM births_in_flight WHERE account = ?').bind(PLAYER).first())).toEqual({ failed: 1, reserved_usd_micros: 0 });
  });
});
