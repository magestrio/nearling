import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';
import { ONE_CLICK, ORIGINS } from '../src/any-chain/quote';
import fixture from './fixtures/one-click-quote.json';
import { encodePetAddress } from '../src/any-chain/addresses';

const h = harness();
const tokens = Object.entries(ORIGINS).map(([chain, assetId]) => ({ assetId, blockchain: chain === 'solana' ? 'sol' : chain,
  symbol: 'USDC', decimals: 6, price: 1, contractAddress: chain === 'base'
    ? '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }));

function setup() {
  h.net().contract.addPet('1', NEAR_ACCOUNT(1));
  h.net().web.handlers.set(`${ONE_CLICK}/tokens`, () => Response.json(tokens));
  h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
    const request = JSON.parse(body) as Record<string, unknown>;
    const amount = BigInt(String(request.amount));
    return Response.json({ ...fixture, quoteRequest: request, quote: { ...fixture.quote,
      amountIn: String(request.amount), timeEstimate: 120,
      amountOut: (amount * 280_000_000_000_000_000n).toString(),
      minAmountOut: (amount * 277_200_000_000_000_000n).toString(),
    } }, { status: 201 });
  });
}

describe('pet address derivation', () => {
  // spec: add-any-chain-feed › Pet address view contract › existing pet
  it('encodes the public keys returned by the live testnet signer view', () => {
    expect(encodePetAddress('base',
      'secp256k1:TutXaGm1dh15RguBPwhnsR4gxE34SVCrAxCfBvN3hLjEuWCcn2U5rTYwkZqV3kGNuKsu9hyZim781N2W7qdtg3k'))
      .toBe('0x4fe2c8acb2d1b6cd73c0550415d991dc4cc26ae8');
    expect(encodePetAddress('solana', 'ed25519:7MFe2FzkDz1NvTW2vdHXc2kCTfRC34H3QUPgivZpMoah'))
      .toBe('7MFe2FzkDz1NvTW2vdHXc2kCTfRC34H3QUPgivZpMoah');
  });
  // spec: add-any-chain-feed › Pet address deposit flow › address entry
  it('reads testnet receiver registration from wrap.testnet with the recorded null response shape', async () => {
    setup();
    h.net().contract.crossChainRegistered = false;
    const response = await api('/api/any-chain/pets/1/addresses');
    expect(response).toMatchObject({ status: 409, body: { code: 'receiver_unregistered' } });
    expect(h.net().contract.crossChainExternalViews).toContainEqual({ account: 'wrap.testnet',
      method: 'storage_balance_of', args: { account_id: env.CONTRACT_ID } });
  });
  // spec: add-any-chain-feed › Pet address view contract › existing pet
  // spec: add-any-chain-feed › Pet address data › public address read
  it('uses both pinned signer domains and stores the first public key and encoded addresses', async () => {
    setup();
    const first = await api('/api/any-chain/pets/1/addresses');
    expect(first.status).toBe(200);
    expect(first.body.addresses).toEqual([
      { chain: 'base', address: '0xd93d657e6bf835557c083eb9df3a959cc92df71d', path: 'base:1', asset: ORIGINS.base,
        amountUsdc: '0.04', waitSeconds: 120, contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
      { chain: 'solana', address: '2FrmSGkiwSzA3qdvf5jvN3ac2yTYacR1fbrGNe8bkExL', path: 'solana:1', asset: ORIGINS.solana,
        amountUsdc: '0.04', waitSeconds: 120, contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    ]);
    expect(h.net().contract.crossChainExternalViews.filter((item) => item.method === 'derived_public_key')).toEqual(
      expect.arrayContaining([
        { account: 'v1.signer-prod.testnet', method: 'derived_public_key',
          args: { path: 'base:1', predecessor: env.CONTRACT_ID, domain_id: 0 } },
        { account: 'v1.signer-prod.testnet', method: 'derived_public_key',
          args: { path: 'solana:1', predecessor: env.CONTRACT_ID, domain_id: 1 } },
      ]));
    expect((await api('/api/any-chain/pets/1/addresses')).body.addresses).toEqual(first.body.addresses);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM any_chain_addresses').first<{ n: number }>())?.n).toBe(2);
  });

  // spec: add-any-chain-feed › Pet address deposit flow › address entry
  it('keeps both addresses through a gift, and rejects a changed stored signer key', async () => {
    setup();
    const before = await api('/api/any-chain/pets/1/addresses');
    h.net().contract.pets.get('1')!.owner_id = NEAR_ACCOUNT(2);
    expect((await api('/api/any-chain/pets/1/addresses')).body.addresses).toEqual(before.body.addresses);
    await env.DB.prepare("UPDATE any_chain_addresses SET public_key = 'ed25519:drift' WHERE token_id = '1' AND chain = 'solana'").run();
    expect((await api('/api/any-chain/pets/1/addresses')).body.code).toBe('signer_unavailable');
  });

  // spec: add-any-chain-feed › Pet address view contract › unknown pet
  // spec: add-any-chain-feed › Pet address data › public address read
  it('does not offer an unknown pet or an address when either signer domain is unavailable', async () => {
    setup();
    expect((await api('/api/any-chain/pets/9/addresses')).status).toBe(404);
    h.net().contract.crossChainSignerAvailable = false;
    const unavailable = await api('/api/any-chain/pets/1/addresses');
    expect(unavailable.body.code).toBe('signer_unavailable');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM any_chain_addresses').first<{ n: number }>())?.n).toBe(0);
  });
});
