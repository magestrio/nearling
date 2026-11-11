import { env } from 'cloudflare:workers';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it, vi } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { petAddresses } from '../src/any-chain/addresses';
import { ONE_CLICK, ORIGINS } from '../src/any-chain/quote';
import { associatedTokenAccount, SOLANA_USDC } from '../src/any-chain/sweepPayload';
import { bytesHex } from '../src/any-chain/sweepPayload';
import { baseEncode } from 'near-api-js';
import { gasWallet } from '../src/any-chain/gasWallet';
import { advanceSweep, reconcileSweepProvider } from '../src/any-chain/sweepBroadcast';
import { solanaSweepMessage } from '../src/any-chain/sweepPayload';
import { baseSweepPayload } from '../src/any-chain/sweepPayload';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const h = harness();
const baseUsdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const tokens = [
  { assetId: ORIGINS.base, blockchain: 'base', symbol: 'USDC', decimals: 6, price: 1, contractAddress: baseUsdc },
  { assetId: ORIGINS.solana, blockchain: 'sol', symbol: 'USDC', decimals: 6, price: 1, contractAddress: SOLANA_USDC },
  { assetId: 'nep141:base-eth.omft.near', blockchain: 'base', symbol: 'ETH', decimals: 18, price: 2500 },
  { assetId: 'nep141:sol.omft.near', blockchain: 'sol', symbol: 'SOL', decimals: 9, price: 120 },
];

async function setup(chain: 'base' | 'solana', amount = '1500000', owner = NEAR_ACCOUNT(1)) {
  h.net().contract.addPet('1', owner, { name: 'Pixel' });
  const addresses = await petAddresses(env, '1');
  const address = addresses!.find((item) => item.chain === chain)!.address;
  const id = chain === 'base' ? 'b'.repeat(32) : 'c'.repeat(32);
  await env.DB.prepare(`INSERT INTO any_chain_deposits
    (id, token_id, chain, source_tx_hash, transfer_index, sender, address, asset, amount_units, state,
     source_explorer, observed_at) VALUES (?, '1', ?, ?, 0, ?, ?, 'usdc', ?, 'waiting', ?, ?)`)
    .bind(id, chain, chain === 'base' ? `0x${'c'.repeat(64)}` : 'S'.repeat(88),
      chain === 'base' ? `0x${'d'.repeat(40)}` : 'D'.repeat(44), address, amount,
      'https://example.invalid/source', Date.now()).run();
  h.net().web.handlers.set(`${ONE_CLICK}/tokens`, () => Response.json(tokens));
  h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
    const request = JSON.parse(body) as Record<string, unknown>;
    return Response.json({ quoteRequest: request, signature: 'ed25519:test', correlationId: 'reference',
      quote: { amountIn: request.amount, amountInUsd: '0.999', amountOut: '40000000000000000000000',
        amountOutUsd: '0.15', minAmountOut: '39600000000000000000000', refundFee: '10000',
        withdrawFee: '0', timeEstimate: 19, depositAddress: chain === 'base'
          ? `0x${'e'.repeat(40)}` : 'CchuwvvDXAgj8VRwwEUSxVwzttP9wMrY6Hz8mbnoNcAx',
        deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
        timeWhenInactive: new Date(Date.now() + 60 * 60_000).toISOString() } });
  });
  const ownerToken = await token('sweep-owner', owner);
  return { id, address, ownerToken };
}

describe('pet-address sweep quote', () => {
  it('derives the recorded USDC token account for the paid 1-Click Solana probe wallet', () => {
    expect(associatedTokenAccount('CchuwvvDXAgj8VRwwEUSxVwzttP9wMrY6Hz8mbnoNcAx'))
      .toBe('2mBSewey2SUhdeZkLz2JgGwty3tPczxx4WnWodr2LXnE');
  });
  // spec: add-any-chain-feed › Pet address deposit flow › owner authorization pending
  // spec: add-any-chain-feed › Pet address deposit flow › deposit exceeds one sweep
  // spec: add-any-chain-feed › Pet address data › pet-address refund routing
  it('binds a live Base portion, actual destination and pet refund to the owner hash', async () => {
    const { id, address, ownerToken } = await setup('base');
    const sourceRequests: string[] = [];
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const request = JSON.parse(body) as { method: string };
      sourceRequests.push(request.method);
      const value: Record<string, string> = { eth_call: '0x16e360', eth_getTransactionCount: '0x0',
        eth_estimateGas: '0x9c40', eth_gasPrice: '0x2faf080' };
      return Response.json({ result: value[request.method] });
    });
    const quoted = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} });
    expect(quoted.status).toBe(200);
    expect(quoted.body.amountUnits).toBe('1000000');
    expect(quoted.body.remainderUnits).toBe('500000');
    expect(quoted.body.destination).toBe(`0x${'e'.repeat(40)}`);
    expect(quoted.body.refundTo).toBe(address);
    expect(quoted.body.approvalHash).toBe('a'.repeat(64));
    const ownerRead = await api(`/api/any-chain/deposits/${id}/owner`, { token: ownerToken });
    expect(ownerRead.body).toMatchObject({ convertedUnits: '0', sweep: {
      routeId: quoted.body.routeId, amountUnits: '1000000', destination: quoted.body.destination,
      refundTo: address, approvalHash: quoted.body.approvalHash, state: 'quoted' } });
    expect(ownerRead.body.sweep.quote.quote.minAmountOut).toBe(quoted.body.quote.minAmountOut);
    expect(sourceRequests).toEqual(expect.arrayContaining(['eth_call', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_gasPrice']));
    const envelope = h.net().contract.reads.find((item) => item.method === 'sweep_approval_hash_view')!.args.envelope as Record<string, unknown>;
    expect(envelope).toMatchObject({ contract_id: env.CONTRACT_ID, token_id: '1', chain: 'base',
      path: 'base:1', amount_base_units: 1_000_000, destination: quoted.body.destination,
      refund_recipient: address, route_id: quoted.body.routeId, sequence: 0 });
    expect(envelope.signing_payload_sha256).toHaveLength(32);
    expect((await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} })).status).toBe(409);
  });

  // spec: add-any-chain-feed › Pet address deposit flow › deposit exceeds one sweep
  it('reduces a portion when the live food quote exceeds the per-sweep ceiling', async () => {
    const { id, ownerToken } = await setup('base');
    const requested: { amount: string; dry: boolean }[] = [];
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
      const request = JSON.parse(body) as Record<string, unknown>;
      requested.push({ amount: request.amount as string, dry: request.dry as boolean });
      const tooLarge = BigInt(request.amount as string) > 500_000n;
      const amountOut = tooLarge ? '300000000000000000000000' : '150000000000000000000000';
      const minimum = tooLarge ? '297000000000000000000000' : '148500000000000000000000';
      return Response.json({ quoteRequest: request, signature: 'ed25519:test', correlationId: 'reference',
        quote: { amountIn: request.amount, amountInUsd: '0.5', amountOut,
          amountOutUsd: '0.15', minAmountOut: minimum, refundFee: '10000', withdrawFee: '0',
          timeEstimate: 19, depositAddress: `0x${'e'.repeat(40)}`,
          deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
          timeWhenInactive: new Date(Date.now() + 60 * 60_000).toISOString() } });
    });
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const method = (JSON.parse(body) as { method: string }).method;
      const value: Record<string, string> = { eth_call: '0x16e360', eth_getTransactionCount: '0x0',
        eth_estimateGas: '0x9c40', eth_gasPrice: '0x2faf080' };
      return Response.json({ result: value[method] });
    });
    const quoted = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} });
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(200);
    expect(quoted.body.amountUnits).toBe('500000');
    expect(quoted.body.remainderUnits).toBe('1000000');
    expect(requested).toEqual([{ amount: '1000000', dry: true },
      { amount: '500000', dry: true }, { amount: '500000', dry: false }]);
  });

  // spec: add-any-chain-feed › Pet address deposit flow › remainder after sweep
  it('waits one hour and offers only the remaining deposit under a new approval', async () => {
    const { id, ownerToken } = await setup('base');
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const method = (JSON.parse(body) as { method: string }).method;
      const value: Record<string, string> = { eth_call: '0x16e360', eth_getTransactionCount: '0x0',
        eth_estimateGas: '0x9c40', eth_gasPrice: '0x2faf080' };
      return Response.json({ result: value[method] });
    });
    const first = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} });
    expect(first.status).toBe(200);
    await env.DB.prepare("UPDATE any_chain_sweeps SET state = 'food', signed_at_ms = ? WHERE route_id = ?")
      .bind(Date.now(), first.body.routeId).run();
    await env.DB.prepare("UPDATE any_chain_deposits SET state = 'food', near_credit_tx = ? WHERE id = ?")
      .bind('N'.repeat(44), id).run();
    // spec: add-any-chain-feed › Pet address deposit flow › remainder after sweep
    const sender = await api(`/api/any-chain/deposits/${id}/status`);
    expect(sender.body).toMatchObject({ state: 'became_food', settledUnits: '1000000',
      remainingUnits: '500000' });
    expect((await api(`/api/any-chain/deposits/${id}/sweep/quote`,
      { token: ownerToken, body: {} })).body.code).toBe('sweep_already_active');
    vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
    const freshOwnerToken = await token('sweep-owner-after-window', NEAR_ACCOUNT(1));
    const second = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: freshOwnerToken, body: {} });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.amountUnits).toBe('500000');
    expect(second.body.remainderUnits).toBe('0');
    expect(second.body.routeId).not.toBe(first.body.routeId);
    const envelope = h.net().contract.reads.filter((item) => item.method === 'sweep_approval_hash_view').at(-1)!.args.envelope as Record<string, unknown>;
    expect(envelope.sequence).toBe(1);
  });

  // spec: add-any-chain-feed › Pet sweep authorization contract › wrong refund recipient
  // spec: add-any-chain-feed › Pet address deposit flow › gift before settlement
  it('requires the current owner and the first offered derived address', async () => {
    const { id, ownerToken } = await setup('base');
    expect((await api(`/api/any-chain/deposits/${id}/sweep/quote`, { body: {} })).status).toBe(401);
    h.net().contract.pets.get('1')!.owner_id = NEAR_ACCOUNT(2);
    expect((await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} })).status).toBe(403);
    const newToken = await token('new-sweep-owner', NEAR_ACCOUNT(2));
    await env.DB.prepare("UPDATE any_chain_addresses SET address = 'changed' WHERE token_id = '1' AND chain = 'base'").run();
    expect((await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: newToken, body: {} })).status).toBe(503);
  });

  // spec: add-any-chain-feed › Pet address deposit flow › sweep gas exceeds sponsorship cap
  it('does not offer a quote when source gas exceeds ten percent of food', async () => {
    const { id, ownerToken } = await setup('base');
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const method = (JSON.parse(body) as { method: string }).method;
      return Response.json({ result: method === 'eth_call' ? '0x16e360' :
        method === 'eth_getTransactionCount' ? '0x0' : method === 'eth_estimateGas' ? '0x186a0' : '0x3b9aca00' });
    });
    const result = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} });
    expect(result).toEqual({ status: 409, body: { code: 'sweep_gas_cap' } });
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM any_chain_sweeps').first<{ count: number }>())?.count).toBe(0);
  });

  // spec: add-any-chain-feed › Pet address deposit flow › owner authorization pending
  it('binds Solana approval to the recipient token account and accounts for its separate rent', async () => {
    const { id, ownerToken, address } = await setup('solana');
    const destination = associatedTokenAccount('CchuwvvDXAgj8VRwwEUSxVwzttP9wMrY6Hz8mbnoNcAx');
    h.net().web.handlers.set('https://api.mainnet-beta.solana.com', ({ body }) => {
      const request = JSON.parse(body) as { method: string; params: string[] };
      const method = request.method;
      if (method === 'getAccountInfo') return Response.json({ result: { value:
        request.params[0] === associatedTokenAccount(address) ? { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', space: 165 } : null } });
      if (method === 'getTokenAccountBalance') return Response.json({ result: { value: { amount: '1500000' } } });
      if (method === 'getLatestBlockhash') return Response.json({ result: { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 10 } } });
      if (method === 'getFeeForMessage') return Response.json({ result: { value: 5000 } });
      if (method === 'getMinimumBalanceForRentExemption') return Response.json({ result: 1_488_440 });
      return Response.json({ error: { code: -1 } });
    });
    const quoted = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} });
    expect(quoted.status).toBe(200);
    expect(quoted.body.destination).toBe(destination);
    expect(quoted.body.providerWallet).not.toBe(destination);
    expect(quoted.body.tokenAccountCreationMicros).toBeGreaterThan(50_000);
    expect(quoted.body.sourceGasMicros).toBeLessThan(quoted.body.sponsorCapMicros);
    const envelope = h.net().contract.reads.find((item) => item.method === 'sweep_approval_hash_view')!.args.envelope as Record<string, unknown>;
    expect(envelope.destination).toBe(destination);
    expect(envelope.refund_recipient).toBe((await petAddresses(env, '1'))![1]!.address);
  });

  // spec: add-any-chain-feed › Pet address data › owner approval leaves browser
  // spec: add-any-chain-feed › Pet sweep authorization contract › wrong refund recipient
  it('returns the refund mismatch reason before sending a sweep', async () => {
    const { id, ownerToken } = await setup('base', '150000');
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const method = (JSON.parse(body) as { method: string }).method;
      return Response.json({ result: method === 'eth_call' ? '0x249f0' :
        method === 'eth_getTransactionCount' ? '0x0' : method === 'eth_estimateGas' ? '0x9c40' : '0x2faf080' });
    });
    const quote = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} });
    expect(quote.status).toBe(200);
    await env.DB.prepare('UPDATE any_chain_sweeps SET refund_recipient = ? WHERE route_id = ?')
      .bind(`0x${'f'.repeat(40)}`, quote.body.routeId).run();
    const rejected = await api(`/api/any-chain/sweeps/${quote.body.routeId}/approve`,
      { token: ownerToken, body: { signature: '0'.repeat(128) } });
    expect(rejected).toEqual({ status: 409, body: { code: 'wrong_refund_recipient' } });
    expect(h.net().contract.sends.filter((send) => send.method === 'sweep_sign')).toHaveLength(0);
  });

  // spec: add-any-chain-feed › Pet sweep authorization contract › wrong refund recipient
  it('preserves a real contract refusal for owner and sender status reads', async () => {
    const secret = new Uint8Array(32).fill(19);
    const owner = bytesHex(ed25519.getPublicKey(secret));
    const { id, ownerToken } = await setup('base', '150000', owner);
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const method = (JSON.parse(body) as { method: string }).method;
      return Response.json({ result: method === 'eth_call' ? '0x249f0' :
        method === 'eth_getTransactionCount' ? '0x0' : method === 'eth_estimateGas' ? '0x9c40' : '0x2faf080' });
    });
    const quote = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} });
    expect(quote.status).toBe(200);
    const signature = bytesHex(ed25519.sign(Uint8Array.from(quote.body.approvalHash.match(/../g),
      (part: string) => parseInt(part, 16)), secret));
    h.net().contract.sweepFails = 'bad_sweep_refund';
    const refusal = await api(`/api/any-chain/sweeps/${quote.body.routeId}/approve`,
      { token: ownerToken, body: { signature } });
    expect(refusal.body).toMatchObject({ state: 'sign_failed', reason: 'wrong_refund_recipient' });
    expect((await api(`/api/any-chain/deposits/${id}/status`)).body.reason).toBe('wrong_refund_recipient');
    expect((await api(`/api/any-chain/deposits/${id}/owner`, { token: ownerToken })).body.sweep.reason)
      .toBe('wrong_refund_recipient');
  });

  // spec: add-any-chain-feed › Pet address data › owner approval leaves browser
  // spec: add-any-chain-feed › Pet address deposit flow › approval submitted
  // spec: add-any-chain-feed › Pet address deposit flow › NEAR signing outcome unknown
  it('rechecks the owner, sends one signed envelope and retains the original NEAR hash on timeout', async () => {
    const secret = new Uint8Array(32).fill(7);
    const owner = bytesHex(ed25519.getPublicKey(secret));
    const { id, ownerToken } = await setup('base', '150000', owner);
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const method = (JSON.parse(body) as { method: string }).method;
      return Response.json({ result: method === 'eth_call' ? '0x249f0' :
        method === 'eth_getTransactionCount' ? '0x0' : method === 'eth_estimateGas' ? '0x9c40' : '0x2faf080' });
    });
    const quote = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} });
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    const signature = bytesHex(ed25519.sign(Uint8Array.from(quote.body.approvalHash.match(/../g),
      (part: string) => parseInt(part, 16)), secret));
    const wrong = await api(`/api/any-chain/sweeps/${quote.body.routeId}/approve`,
      { token: ownerToken, body: { signature: '0'.repeat(128) } });
    expect(wrong.status).toBe(409);
    expect(h.net().contract.sends.filter((send) => send.method === 'sweep_sign')).toHaveLength(0);
    h.net().contract.mode = 'lost';
    const unknown = await api(`/api/any-chain/sweeps/${quote.body.routeId}/approve`,
      { token: ownerToken, body: { signature } });
    expect(unknown.status).toBe(200);
    expect(unknown.body.state).toBe('sign_unknown');
    expect(unknown.body.nearTxHash).toBeTruthy();
    const repeat = await api(`/api/any-chain/sweeps/${quote.body.routeId}/approve`,
      { token: ownerToken, body: { signature } });
    expect(repeat.status).toBe(409);
    const stored = await env.DB.prepare('SELECT near_tx_hash, state FROM any_chain_sweeps WHERE route_id = ?')
      .bind(quote.body.routeId).first<{ near_tx_hash: string; state: string }>();
    expect(stored).toEqual({ near_tx_hash: unknown.body.nearTxHash, state: 'sign_unknown' });
  });

  // spec: add-any-chain-feed › Pet address deposit flow › approval submitted
  it('does not send an expired owner approval to NEAR or the source chain', async () => {
    const { id, ownerToken } = await setup('base', '150000');
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const method = (JSON.parse(body) as { method: string }).method;
      const value: Record<string, string> = { eth_call: '0x249f0', eth_getTransactionCount: '0x0',
        eth_estimateGas: '0x9c40', eth_gasPrice: '0x2faf080' };
      return Response.json({ result: value[method] });
    });
    const quote = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} });
    expect(quote.status).toBe(200);
    await env.DB.prepare('UPDATE any_chain_sweeps SET expiry_ms = ? WHERE route_id = ?')
      .bind(Date.now() - 1, quote.body.routeId).run();
    const approval = await api(`/api/any-chain/sweeps/${quote.body.routeId}/approve`,
      { token: ownerToken, body: { signature: '0'.repeat(128) } });
    expect(approval).toEqual({ status: 409, body: { code: 'quote_expired' } });
    expect(h.net().contract.sends.filter((send) => send.method === 'sweep_sign')).toHaveLength(0);
    expect((await env.DB.prepare('SELECT state, source_tx_hash FROM any_chain_sweeps WHERE route_id = ?')
      .bind(quote.body.routeId).first())!).toMatchObject({ state: 'quoted', source_tx_hash: null });
  });

  // spec: add-any-chain-feed › Pet address deposit flow › sweep awaiting gas
  // spec: add-any-chain-feed › Pet address deposit flow › sweep sent
  it('creates the Solana recipient token account from the project wallet, then funds and confirms the bounded sweep', async () => {
    const secret = new Uint8Array(32).fill(11);
    const petAddress = baseEncode(ed25519.getPublicKey(secret));
    const recipient = 'CchuwvvDXAgj8VRwwEUSxVwzttP9wMrY6Hz8mbnoNcAx';
    const destination = associatedTokenAccount(recipient);
    const gas = gasWallet(env, 'solana');
    const blockhash = '11111111111111111111111111111111';
    const message = solanaSweepMessage(petAddress, destination, blockhash, 150_000n);
    const signature = ed25519.sign(message, secret);
    const route = 'd'.repeat(32);
    const deposit = 'e'.repeat(32);
    await env.DB.prepare(`INSERT INTO any_chain_deposits
      (id, token_id, chain, source_tx_hash, transfer_index, sender, address, asset, amount_units, state,
       source_explorer, observed_at) VALUES (?, '1', 'solana', ?, 0, ?, ?, 'usdc', '150000', 'waiting', ?, ?)`)
      .bind(deposit, 'F'.repeat(88), 'G'.repeat(44), petAddress, 'https://example.invalid/source', Date.now()).run();
    await env.DB.prepare(`INSERT INTO any_chain_sweeps
      (route_id, deposit_id, token_id, chain, amount_units, provider_wallet, destination, refund_recipient,
       quote_json, payload_hex, approval_hash, sequence, expiry_ms, sponsor_cap_micros,
       estimated_gas_micros, estimated_rent_micros, native_funding_units, native_gas_units,
       native_rent_units, gas_wallet_address, source_meta_json, creation_message, state,
       mpc_response, created_at, updated_at)
       VALUES (?, ?, '1', 'solana', '150000', ?, ?, ?, '{}', ?, ?, 0, ?, 15000,
         1200, 180000, '5000', '10000', '1493440', ?, ?, 'required', 'signed', ?, ?, ?)`)
      .bind(route, deposit, recipient, destination, petAddress, bytesHex(message), 'a'.repeat(64),
        Date.now() + 45_000, gas.address, JSON.stringify({ blockhash }),
        JSON.stringify({ scheme: 'Ed25519', signature: Array.from(signature) }), Date.now(), Date.now()).run();
    let created = false;
    let funded = false;
    const sent: string[] = [];
    h.net().web.handlers.set(`${ONE_CLICK}/tokens`, () => Response.json(tokens));
    h.net().web.handlers.set('https://api.mainnet-beta.solana.com', ({ body }) => {
      const request = JSON.parse(body) as { method: string; params: unknown[] };
      switch (request.method) {
        case 'getAccountInfo': return Response.json({ result: { value:
          request.params[0] === destination && !created ? null :
            { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', space: 165, lamports: 1_488_440 } } });
        case 'getBalance': return Response.json({ result: { value: request.params[0] === gas.address ? 1_000_000_000 : funded ? 5000 : 0 } });
        case 'getLatestBlockhash': return Response.json({ result: { value: { blockhash, lastValidBlockHeight: 100 } } });
        case 'getMinimumBalanceForRentExemption': return Response.json({ result: 1_488_440 });
        case 'getFeeForMessage': return Response.json({ result: { value: 5000 } });
        case 'getTokenAccountBalance': return Response.json({ result: { value: { amount: '150000' } } });
        case 'isBlockhashValid': return Response.json({ result: { value: true } });
        case 'getSignatureStatuses': return Response.json({ result: { value: [{ confirmationStatus: 'finalized', err: null }] } });
        case 'getTransaction': return Response.json({ result: { meta: { fee: 5000,
          preBalances: [1_000_000_000], postBalances: [998_506_560] } } });
        case 'sendTransaction': {
          const raw = Uint8Array.from(atob(request.params[0] as string), (char) => char.charCodeAt(0));
          const hash = baseEncode(raw.slice(1, 65));
          sent.push(hash);
          if (sent.length === 1) created = true;
          if (sent.length === 2) funded = true;
          return Response.json({ result: hash });
        }
        default: return Response.json({ error: { code: -1 } });
      }
    });
    expect(await advanceSweep(env, route)).toBe('broadcasting');
    expect(await advanceSweep(env, route)).toBe('broadcasting');
    expect(await advanceSweep(env, route)).toBe('broadcasting');
    expect(await advanceSweep(env, route)).toBe('sent');
    expect(sent).toHaveLength(3);
    const cost = await env.DB.prepare("SELECT usd_micros FROM project_spend WHERE kind = 'source_account_rent'")
      .first<{ usd_micros: number }>();
    expect(cost!.usd_micros).toBeGreaterThan(50_000);
    expect((await env.DB.prepare('SELECT state FROM any_chain_deposits WHERE id = ?').bind(deposit)
      .first<{ state: string }>())?.state).toBe('converting');
    expect(await advanceSweep(env, route)).toBe('sent');
    expect(sent).toHaveLength(3);
  });

  // spec: add-any-chain-feed › Pet address deposit flow › sweep sent
  // spec: add-any-chain-feed › Pet address deposit flow › sweep failed
  // spec: add-any-chain-feed › Pet address deposit flow › conversion refund
  it('funds Base gas separately and broadcasts only the MPC signature of the pet address', async () => {
    const secret = new Uint8Array(32).fill(12);
    const petAddress = `0x${bytesHex(keccak_256(secp256k1.getPublicKey(secret, false).slice(1)).slice(-20))}`;
    const destination = `0x${'e'.repeat(40)}`;
    const payload = baseSweepPayload(destination, 150_000n, 0n, 5_000_000n, 50_000_000n, 40_000n);
    const signature = secp256k1.sign(keccak_256(payload), secret, { prehash: false, format: 'recovered' });
    const route = 'a'.repeat(32);
    const deposit = 'f'.repeat(32);
    const gas = gasWallet(env, 'base');
    await env.DB.prepare(`INSERT INTO any_chain_deposits
      (id, token_id, chain, source_tx_hash, transfer_index, sender, address, asset, amount_units, state,
       source_explorer, observed_at) VALUES (?, '1', 'base', ?, 0, ?, ?, 'usdc', '150000', 'waiting', ?, ?)`)
      .bind(deposit, `0x${'c'.repeat(64)}`, `0x${'d'.repeat(40)}`, petAddress,
        'https://example.invalid/source', Date.now()).run();
    await env.DB.prepare(`INSERT INTO any_chain_sweeps
      (route_id, deposit_id, token_id, chain, amount_units, provider_wallet, destination, refund_recipient,
       quote_json, payload_hex, approval_hash, sequence, expiry_ms, sponsor_cap_micros,
       estimated_gas_micros, estimated_rent_micros, native_funding_units, native_gas_units,
       native_rent_units, gas_wallet_address, source_meta_json, state,
       mpc_response, created_at, updated_at)
       VALUES (?, ?, '1', 'base', '150000', ?, ?, ?, '{}', ?, ?, 0, ?, 15000,
         8000, 0, '2000000000000', '3050000000000', '0', ?, ?, 'signed', ?, ?, ?)`)
      .bind(route, deposit, destination, destination, petAddress, bytesHex(payload), 'a'.repeat(64),
        Date.now() + 300_000, gas.address,
        JSON.stringify({ nonce: '0', priority: '5000000', maxFee: '50000000', gasLimit: '40000' }),
        JSON.stringify({ scheme: 'Secp256k1', big_r: { affine_point:
          bytesHex(Uint8Array.of(2 + signature[0]!, ...signature.slice(1, 33))) },
        s: { scalar: bytesHex(signature.slice(33)) }, recovery_id: signature[0] }), Date.now(), Date.now()).run();
    h.net().web.handlers.set(`${ONE_CLICK}/tokens`, () => Response.json(tokens));
    let funded = false;
    const sent: string[] = [];
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const request = JSON.parse(body) as { method: string; params: string[] };
      switch (request.method) {
        case 'eth_getBalance': return Response.json({ result: request.params[0] === gas.address ? '0xde0b6b3a7640000' : funded ? '0x1d1a94a2000' : '0x0' });
        case 'eth_getTransactionCount': return Response.json({ result: '0x0' });
        case 'eth_getTransactionReceipt': return Response.json({ result: { status: '0x1', blockNumber: '0x10',
          gasUsed: '0x5208', effectiveGasPrice: '0x2faf080' } });
        case 'eth_getBlockByNumber': return Response.json({ result: { number: '0x10' } });
        case 'eth_call': return Response.json({ result: '0x249f0' });
        case 'eth_sendRawTransaction': {
          const hash = `0x${bytesHex(keccak_256(Uint8Array.from(request.params[0]!.slice(2).match(/../g)!,
            (part) => parseInt(part, 16))))}`;
          sent.push(hash);
          if (sent.length === 1) funded = true;
          return Response.json({ result: hash });
        }
        default: return Response.json({ error: { code: -1 } });
      }
    });
    expect(await advanceSweep(env, route)).toBe('broadcasting');
    expect(await advanceSweep(env, route)).toBe('broadcasting');
    expect(await advanceSweep(env, route)).toBe('sent');
    expect(sent).toHaveLength(2);
    const row = await env.DB.prepare('SELECT source_tx_hash, state FROM any_chain_sweeps WHERE route_id = ?')
      .bind(route).first<{ source_tx_hash: string; state: string }>();
    expect(row?.source_tx_hash).toBe(sent[1]);
    expect(row?.state).toBe('sent');
    const refundHash = `0x${'f'.repeat(64)}`;
    h.net().web.handlers.set(`${ONE_CLICK}/status?depositAddress=${destination}`, () => Response.json({
      status: 'REFUNDED', quoteResponse: { quoteRequest: { originAsset: ORIGINS.base,
        destinationAsset: 'nep141:wrap.near', refundTo: petAddress, recipient: env.CONTRACT_ID,
        customRecipientMsg: JSON.stringify({ token_id: '1', route, kind: 'pet_address' }) } },
      swapDetails: { originChainTxHashes: [{ hash: row!.source_tx_hash }, { hash: refundHash }],
        refundedAmount: '120000' },
    }));
    const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const request = JSON.parse(body) as { method: string };
      if (request.method === 'eth_getBlockByNumber') return Response.json({ result: { number: '0x10' } });
      if (request.method === 'eth_getTransactionReceipt') return Response.json({ result: {
        status: '0x1', blockNumber: '0x10', logs: [{ address: baseUsdc,
          topics: [transfer, `0x${'0'.repeat(24)}${'d'.repeat(40)}`,
            `0x${'0'.repeat(24)}${petAddress.slice(2)}`],
          data: `0x${(120_000).toString(16).padStart(64, '0')}` }],
      } });
      return Response.json({ error: { code: -1 } });
    });
    expect(await reconcileSweepProvider(env, route)).toBe('refunded');
    expect((await env.DB.prepare('SELECT state, source_refund_tx FROM any_chain_deposits WHERE id = ?')
      .bind(deposit).first<{ state: string; source_refund_tx: string }>()))
      .toEqual({ state: 'refunded', source_refund_tx: refundHash });
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM any_chain_credit_evidence')
      .first<{ count: number }>())?.count).toBe(0);
  });

  // spec: add-any-chain-feed › Pet address deposit flow › sweep failed
  it('keeps the original signed source bytes after a broadcast error and records final failure', async () => {
    const { id, ownerToken } = await setup('base', '150000');
    const sourceHash = `0x${'a'.repeat(64)}`;
    const sourceBytes = '0x1234';
    let finalized = false;
    const attempted: string[] = [];
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const request = JSON.parse(body) as { method: string; params: string[] };
      switch (request.method) {
        case 'eth_call': return Response.json({ result: '0x249f0' });
        case 'eth_getTransactionCount': return Response.json({ result: '0x0' });
        case 'eth_estimateGas': return Response.json({ result: '0x9c40' });
        case 'eth_gasPrice': return Response.json({ result: '0x2faf080' });
        case 'eth_getTransactionReceipt': return Response.json({ result: finalized ? {
          status: '0x0', blockNumber: '0x10', gasUsed: '0x5208', effectiveGasPrice: '0x2faf080',
        } : null });
        case 'eth_getBlockByNumber': return Response.json({ result: { number: '0x10' } });
        case 'eth_sendRawTransaction': attempted.push(request.params[0]!);
          return Response.json({ error: { code: -32000, message: 'temporarily unavailable' } });
        default: return Response.json({ error: { code: -1 } });
      }
    });
    const quoted = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} });
    expect(quoted.status).toBe(200);
    await env.DB.prepare(`UPDATE any_chain_sweeps SET state = 'broadcasting', source_tx_hash = ?,
      source_signed_tx = ?, mpc_response = '{}' WHERE route_id = ?`)
      .bind(sourceHash, sourceBytes, quoted.body.routeId).run();
    expect(await advanceSweep(env, quoted.body.routeId)).toBe('broadcasting');
    expect(attempted).toEqual([sourceBytes]);
    finalized = true;
    expect(await advanceSweep(env, quoted.body.routeId)).toBe('failed');
    expect((await env.DB.prepare('SELECT state, source_tx_hash, source_signed_tx FROM any_chain_sweeps WHERE route_id = ?')
      .bind(quoted.body.routeId).first())!).toMatchObject({ state: 'failed', source_tx_hash: sourceHash,
        source_signed_tx: sourceBytes });
    expect(attempted).toEqual([sourceBytes]);
  });

  // spec: add-any-chain-feed › Pet address deposit flow › sweep awaiting gas
  it('keeps approved USDC at the pet address when the separate project gas wallet is empty', async () => {
    const { id, ownerToken } = await setup('base', '150000');
    h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
      const request = JSON.parse(body) as { method: string; params: string[] };
      const value: Record<string, string> = { eth_call: '0x249f0', eth_getTransactionCount: '0x0',
        eth_estimateGas: '0x9c40', eth_gasPrice: '0x2faf080', eth_getBalance: '0x0' };
      return Response.json({ result: value[request.method] });
    });
    const quote = await api(`/api/any-chain/deposits/${id}/sweep/quote`, { token: ownerToken, body: {} });
    expect(quote.status).toBe(200);
    await env.DB.prepare("UPDATE any_chain_sweeps SET state = 'signed', mpc_response = '{}' WHERE route_id = ?")
      .bind(quote.body.routeId).run();
    expect(await advanceSweep(env, quote.body.routeId)).toBe('awaiting_gas');
    expect((await env.DB.prepare('SELECT source_tx_hash FROM any_chain_sweeps WHERE route_id = ?')
      .bind(quote.body.routeId).first<{ source_tx_hash: string | null }>())?.source_tx_hash).toBeNull();
  });
});
