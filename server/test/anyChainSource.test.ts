import { describe, expect, it } from 'vitest';
import { harness } from './helpers/api';
import { observedSource, verifiedSource } from '../src/any-chain/source';

const h = harness();
const deposit = `0x${'a'.repeat(40)}`;
const payer = `0x${'b'.repeat(40)}`;
const hash = `0x${'c'.repeat(64)}`;
const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function network(asset = usdc, amount = '150000', to = deposit) {
  h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
    const request = JSON.parse(body) as { method: string; params: string[] };
    if (request.method === 'eth_getBlockByNumber') return Response.json({ result: {
      number: '0x10', timestamp: '0x65000000',
    } });
    if (request.method === 'eth_getTransactionReceipt') return Response.json({ result: {
      status: '0x1', blockNumber: '0x10', logs: [{ address: asset, topics: [transfer,
        `0x${'0'.repeat(24)}${payer.slice(2)}`, `0x${'0'.repeat(24)}${to.slice(2)}`],
        data: `0x${BigInt(amount).toString(16).padStart(64, '0')}` }],
    } });
    return Response.json({ result: null });
  });
}

describe('Base source evidence', () => {
  // spec: add-any-chain-feed › Held delivery refund data › source verified
  it('uses finalized USDC Transfer logs and its token sender as the verified recipient', async () => {
    network();
    expect(await verifiedSource('base', hash, deposit, '150000')).toMatchObject({ sender: payer, recipient: deposit, amount: '150000' });
    expect((await observedSource('base', hash, deposit))?.asset).toBe('usdc');
  });

  // spec: add-any-chain-feed › Held delivery refund data › source unverified
  it('rejects wrong token, destination, and amount despite a successful transaction', async () => {
    network(`0x${'d'.repeat(40)}`);
    expect(await verifiedSource('base', hash, deposit, '1')).toBeNull();
    network(usdc, '150000', `0x${'e'.repeat(40)}`);
    expect(await verifiedSource('base', hash, deposit, '1')).toBeNull();
    network(usdc, '149999');
    expect(await verifiedSource('base', hash, deposit, '150000')).toBeNull();
  });
});
