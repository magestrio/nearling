import { env } from 'cloudflare:workers';
import { decodeSignedTransaction, decodeTransaction } from 'near-api-js';
import { describe, expect, it, vi } from 'vitest';
import { GIFT_RESERVE_YOCTO, GIFT_TRANSFER_TGAS } from '../src/chain';
import { api, harness } from './helpers/api';
import { keyedPlayer, NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const PET = '93';
const FRIEND = NEAR_ACCOUNT(9);
const RESERVE = GIFT_RESERVE_YOCTO;
const setup = async (balance: bigint = RESERVE) => {
  const giver = keyedPlayer();
  const chain = h.net().contract;
  chain.addPet(PET, giver.account);
  if (balance > 0n) chain.balances.set(giver.account, balance);
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, 1, ?)').bind(PET, giver.account, '').run();
  const giverToken = await token(`did:privy:gift-tx-${giver.account}`, giver.account);
  const friendToken = await token('did:privy:gift-tx-friend', FRIEND);
  await env.DB.prepare('UPDATE players SET first_name = ? WHERE account_id = ?').bind('Maya', FRIEND).run();
  const code = (await api(`/api/pets/${PET}/gift`, { token: giverToken, method: 'POST' })).body.code as string;
  expect((await api(`/api/gifts/${code}/accept`, { token: friendToken, method: 'POST' })).status).toBe(200);
  return { giver, chain, giverToken, friendToken, code };
};
const prepare = (tk: string) => api(`/api/pets/${PET}/gift/prepare`, { token: tk, method: 'POST' });
const send = (tk: string, body: unknown) => api(`/api/pets/${PET}/gift/send`, { token: tk, body });
const outcome = (tk: string) => api(`/api/pets/${PET}/gift/outcome`, { token: tk });

describe('owner-signed gift flight', () => {
  // spec: add-gift › Gift flow › передаёт
  it('builds one nft_transfer for the accepted account with current nonce and block hash', async () => {
    const { giver, giverToken, chain, friendToken } = await setup();
    const made = await prepare(giverToken);
    expect(made.body).toMatchObject({ status: 'ready', receiver: FRIEND, acceptedName: 'Maya' });
    const tx = decodeTransaction(Uint8Array.from(atob(made.body.tx), (c) => c.charCodeAt(0)));
    expect(tx.signerId).toBe(giver.account);
    expect(tx.receiverId).toBe(env.CONTRACT_ID);
    expect(tx.nonce).toBe(101n);
    expect(tx.actions).toHaveLength(1);
    expect(tx.actions[0]!.functionCall?.methodName).toBe('nft_transfer');
    expect(tx.actions[0]!.functionCall?.gas).toBe(GIFT_TRANSFER_TGAS * 1_000_000_000_000n);
    expect(tx.actions[0]!.functionCall?.deposit).toBe(1n);
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(tx.actions[0]!.functionCall!.args as ArrayLike<number>)))).toEqual({ receiver_id: FRIEND, token_id: PET, approval_id: null, memo: null });
    expect(chain.sends).toHaveLength(0);
    expect((await prepare(friendToken)).status).toBe(403);
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('ok');
    expect(chain.sends.filter((s) => s.method === 'nft_transfer')).toHaveLength(1);
  });

  // spec: add-gift › Gift transaction data › аккаунта дарящего нет в сети
  it('creates a new implicit giver with one gas-account transfer before signing', async () => {
    const { giver, giverToken, chain } = await setup(0n);
    const [a, b] = await Promise.all([prepare(giverToken), prepare(giverToken)]);
    expect([a.body.status, b.body.status]).toContain('ready');
    expect(chain.sends.filter((s) => s.method === 'transfer' && s.signer === env.GAS_ACCOUNT_ID)).toHaveLength(1);
    expect(chain.balances.get(giver.account)).toBe(RESERVE);
    const row = await env.DB.prepare('SELECT gift_topup_at, gift_topup_flight, gas_added_yocto, wallet_seen_yocto FROM players WHERE account_id = ?').bind(giver.account).first<any>();
    expect(row.gift_topup_at).not.toBeNull();
    expect(row.gift_topup_flight).toBeTruthy();
    expect(row.gas_added_yocto).toBe(RESERVE.toString());
    expect(row.wallet_seen_yocto).toBe(RESERVE.toString());
  });

  // spec: add-gift › Gift transaction data › газ уже доливали
  it('never grants a second gift reserve and returns the shortfall before signing', async () => {
    const { giver, giverToken, chain } = await setup(0n);
    expect((await prepare(giverToken)).body.status).toBe('ready');
    chain.balances.set(giver.account, 0n);
    const second = await prepare(giverToken);
    expect(second.body).toMatchObject({ status: 'no_near', missingYocto: RESERVE.toString() });
    expect(chain.sends.filter((s) => s.method === 'transfer')).toHaveLength(1);
  });

  // spec: add-gift › Gift transaction data › газ уже доливали
  it('keeps a spent top-up claim when its landed hash is unavailable after expiry', async () => {
    const { giver, giverToken, chain } = await setup(0n);
    chain.mode = 'executed-but-silent';
    expect((await prepare(giverToken)).body.status).toBe('pending');
    const before = await env.DB.prepare('SELECT gift_topup_at, gift_topup_op, gift_topup_flight, gas_added_yocto, wallet_seen_yocto FROM players WHERE account_id = ?')
      .bind(giver.account).first<any>();
    expect(chain.balances.get(giver.account)).toBe(RESERVE);
    chain.balances.set(giver.account, 0n);
    chain.mode = 'normal';
    chain.txBlind = true;
    chain.blockHeight = 87_401;
    expect((await prepare(giverToken)).body).toMatchObject({ status: 'no_near', missingYocto: RESERVE.toString() });
    const after = await env.DB.prepare('SELECT gift_topup_at, gift_topup_op, gift_topup_flight, gas_added_yocto, wallet_seen_yocto FROM players WHERE account_id = ?')
      .bind(giver.account).first<any>();
    expect(after).toEqual(before);
    expect(chain.sends.filter((s) => s.method === 'transfer' && s.signer === env.GAS_ACCOUNT_ID)).toHaveLength(1);
  });

  // spec: add-gift › Gift transaction data › газ уже доливали
  it('keeps a landed top-up claim when rebroadcast is refused with an unseen hash', async () => {
    const { giver, giverToken, chain } = await setup(0n);
    chain.mode = 'executed-but-silent';
    expect((await prepare(giverToken)).body.status).toBe('pending');
    const before = await env.DB.prepare('SELECT gift_topup_op, gift_topup_flight, gas_added_yocto FROM players WHERE account_id = ?')
      .bind(giver.account).first<any>();
    chain.balances.set(giver.account, 0n);
    chain.mode = 'invalid-nonce';
    chain.txBlind = true;
    expect((await prepare(giverToken)).body.status).toBe('pending');
    const after = await env.DB.prepare('SELECT gift_topup_op, gift_topup_flight, gas_added_yocto FROM players WHERE account_id = ?')
      .bind(giver.account).first<any>();
    expect(after).toEqual(before);
    expect(chain.sends.filter((s) => s.method === 'transfer' && s.signer === env.GAS_ACCOUNT_ID)).toHaveLength(1);
  });

  // spec: add-gift › Gift transaction data › газ уже доливали
  it('releases a signed top-up claim only after a recorded transfer failure', async () => {
    const { giver, giverToken, chain } = await setup(0n);
    chain.transferFails = '1';
    expect((await prepare(giverToken)).body.status).toBe('pending');
    expect((await env.DB.prepare('SELECT gift_topup_at FROM players WHERE account_id = ?').bind(giver.account).first<any>()).gift_topup_at).toBeNull();
    chain.transferFails = null;
    expect((await prepare(giverToken)).body.status).toBe('ready');
    expect(chain.sends.filter((s) => s.method === 'transfer' && s.signer === env.GAS_ACCOUNT_ID)).toHaveLength(2);
  });

  // spec: add-gift › Gift transaction data › аккаунта дарящего нет в сети
  it('releases a first top-up refused by the node before execution when its hash is unseen', async () => {
    const { giver, giverToken, chain } = await setup(0n);
    chain.mode = 'not-enough-balance';
    expect((await prepare(giverToken)).body.status).toBe('paused');
    expect(chain.sends.filter((s) => s.method === 'transfer')).toHaveLength(0);
    expect((await env.DB.prepare('SELECT gift_topup_at, gift_topup_flight, gas_added_yocto, wallet_seen_yocto FROM players WHERE account_id = ?')
      .bind(giver.account).first<any>())).toMatchObject({ gift_topup_at: null, gift_topup_flight: null, gas_added_yocto: '0', wallet_seen_yocto: '0' });
    chain.mode = 'normal';
    expect((await prepare(giverToken)).body.status).toBe('ready');
    expect(chain.sends.filter((s) => s.method === 'transfer' && s.signer === env.GAS_ACCOUNT_ID)).toHaveLength(1);
  });

  // spec: add-gift › Gift transaction data › аккаунта дарящего нет в сети × uncertain transfer / reload
  it('keeps the original gas claim after a lost transfer answer across two tabs', async () => {
    const { giver, giverToken, chain } = await setup(0n);
    chain.mode = 'lost';
    expect((await prepare(giverToken)).body.status).toBe('pending');
    const attempts = chain.attempts;
    expect(attempts).toBe(1);
    expect((await prepare(giverToken)).body.status).toBe('pending');
    expect(chain.attempts).toBe(attempts);
    expect((await env.DB.prepare('SELECT gift_topup_at, gift_topup_flight FROM players WHERE account_id = ?').bind(giver.account).first<any>())).toMatchObject({ gift_topup_flight: expect.any(String) });
  });

  // spec: add-gift › Gift transaction data › аккаунта дарящего нет в сети
  it('releases an abandoned unsent top-up claim and grants one recoverable transfer', async () => {
    const { giver, giverToken, chain } = await setup(0n);
    const old = Date.now() - 31_000;
    await env.DB.prepare('UPDATE players SET gift_topup_at = ?, gas_added_yocto = ?, wallet_seen_yocto = ? WHERE account_id = ?')
      .bind(old, RESERVE.toString(), RESERVE.toString(), giver.account).run();
    expect((await prepare(giverToken)).body.status).toBe('ready');
    expect(chain.sends.filter((s) => s.method === 'transfer' && s.signer === env.GAS_ACCOUNT_ID)).toHaveLength(1);
    const row = await env.DB.prepare('SELECT gift_topup_at, gift_topup_flight, gas_added_yocto FROM players WHERE account_id = ?').bind(giver.account).first<any>();
    expect(row.gift_topup_at).not.toBe(old);
    expect(row.gift_topup_flight).toBeTruthy();
    expect(row.gas_added_yocto).toBe(RESERVE.toString());
  });

  // spec: add-gift › Gift transaction data › аккаунта дарящего нет в сети × uncertain transfer / reload
  it('resends only the recorded gas transaction after an uncertain broadcast', async () => {
    const { giver, giverToken, chain } = await setup(0n);
    chain.mode = 'lost';
    expect((await prepare(giverToken)).body.status).toBe('pending');
    const before = await env.DB.prepare('SELECT gift_topup_op, gift_topup_flight, gift_topup_signed_bytes FROM players WHERE account_id = ?')
      .bind(giver.account).first<any>();
    expect(before.gift_topup_signed_bytes).toBeTruthy();
    chain.mode = 'normal';
    expect((await prepare(giverToken)).body.status).toBe('ready');
    const after = await env.DB.prepare('SELECT gift_topup_op, gift_topup_flight, gift_topup_signed_bytes FROM players WHERE account_id = ?')
      .bind(giver.account).first<any>();
    expect(after).toEqual(before);
    expect(chain.sends.filter((s) => s.method === 'transfer' && s.signer === env.GAS_ACCOUNT_ID)).toHaveLength(1);
  });

  // spec: add-gift › Gift transaction data › аккаунта дарящего нет в сети × two tabs / interrupted claim
  it('does not let a delayed gas-key job spend a replaced stale claim', async () => {
    const { giver, giverToken, chain } = await setup(0n);
    let unlock!: () => void;
    chain.sendGate = new Promise<void>((resolve) => { unlock = resolve; });
    const gas = env.SERVER_KEY.get(env.SERVER_KEY.idFromName('gas'));
    const blocker = gas.transfer(FRIEND, '1');
    for (let i = 0; i < 100 && chain.attempts === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(chain.attempts).toBe(1);
    const old = prepare(giverToken);
    let claim: { gift_topup_at: number; gift_topup_op: string } | null = null;
    for (let i = 0; i < 100 && claim === null; i += 1) {
      claim = await env.DB.prepare('SELECT gift_topup_at, gift_topup_op FROM players WHERE account_id = ? AND gift_topup_at IS NOT NULL')
        .bind(giver.account).first<{ gift_topup_at: number; gift_topup_op: string }>();
      if (claim === null) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(claim?.gift_topup_op).toBeTruthy();
    vi.setSystemTime(new Date(Date.now() + 31_000));
    const fresh = prepare(giverToken);
    let newOp: string | null = null;
    for (let i = 0; i < 100 && newOp === null; i += 1) {
      const row = await env.DB.prepare('SELECT gift_topup_op FROM players WHERE account_id = ?').bind(giver.account).first<{ gift_topup_op: string | null }>();
      if (row?.gift_topup_op && row.gift_topup_op !== claim!.gift_topup_op) newOp = row.gift_topup_op;
      else await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(newOp).toBeTruthy();
    unlock();
    chain.sendGate = null;
    const [oldResult, freshResult] = await Promise.all([old, fresh, blocker]);
    expect(oldResult.status).toBe(503);
    expect(freshResult.body.status).toBe('ready');
    expect(chain.sends.filter((s) => s.method === 'transfer' && s.signer === env.GAS_ACCOUNT_ID && s.deposit === RESERVE.toString())).toHaveLength(1);
    expect((await env.DB.prepare('SELECT gift_topup_op FROM players WHERE account_id = ?').bind(giver.account).first<any>()).gift_topup_op).not.toBe(claim!.gift_topup_op);
  });

  // spec: add-gift › Gift flow › подарки на паузе
  it('returns paused without a signature when the gas account cannot create the giver', async () => {
    const { giverToken, chain } = await setup(0n);
    chain.balances.set(env.GAS_ACCOUNT_ID, RESERVE);
    expect((await prepare(giverToken)).body.status).toBe('paused');
    expect(chain.sends).toHaveLength(0);
  });

  // spec: add-gift › Gift flow › исход неизвестен
  it('keeps one hash after a lost answer, blocks cancellation and resolves after reload', async () => {
    const { giver, giverToken, friendToken, code, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'executed-but-silent';
    const signed = await giver.sign(made.body.tx);
    expect((await send(giverToken, signed)).body.status).toBe('unknown');
    const row = await env.DB.prepare('SELECT tx_hash, signed_bytes, state FROM gift_flights WHERE token_id = ?').bind(PET).first<any>();
    expect(row.tx_hash).toBeTruthy();
    expect(row.signed_bytes).toBeTruthy();
    expect(row.state).toBe('unknown');
    expect((await api(`/api/pets/${PET}/gift`, { token: giverToken, method: 'DELETE' })).status).toBe(403);
    expect((await outcome(friendToken)).body.status).toBe('ok');
    expect(chain.pets.get(PET)?.owner_id).toBe(FRIEND);
    expect((await outcome(friendToken)).body.status).toBe('ok');
    expect(chain.sends.filter((s) => s.method === 'nft_transfer')).toHaveLength(1);
    expect((await env.DB.prepare('SELECT status FROM gift_links WHERE code = ?').bind(code).first<any>()).status).toBe('transferred');
  });

  // spec: add-gift › Gift flow › исход неизвестен × second tap / second tab
  it('keeps an unseen signed transfer pending and prevents cancel or a second send', async () => {
    const { giver, giverToken, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'lost';
    const signed = await giver.sign(made.body.tx);
    expect((await send(giverToken, signed)).body.status).toBe('unknown');
    const attempts = chain.attempts;
    expect((await api(`/api/pets/${PET}/gift`, { token: giverToken, method: 'DELETE' })).status).toBe(409);
    expect((await send(giverToken, signed)).body.status).toBe('unknown');
    expect(chain.attempts).toBe(attempts);
    expect((await prepare(giverToken)).body.status).toBe('unknown');
    expect((await outcome(giverToken)).body.status).toBe('unknown');
    expect(chain.sends.filter((s) => s.method === 'nft_transfer')).toHaveLength(0);
  });

  // spec: add-gift › Gift flow › исход неизвестен
  it('rebroadcasts only the stored signed transfer and reaches success after a dropped RPC send', async () => {
    const { giver, giverToken, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'lost';
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('unknown');
    const before = await env.DB.prepare('SELECT tx_hash, signed_bytes FROM gift_flights WHERE token_id = ?').bind(PET).first<any>();
    chain.mode = 'normal';
    expect((await outcome(giverToken)).body.status).toBe('ok');
    const after = await env.DB.prepare('SELECT tx_hash, signed_bytes, state FROM gift_flights WHERE token_id = ?').bind(PET).first<any>();
    expect(after.tx_hash).toBe(before.tx_hash);
    expect(after.signed_bytes).toEqual(before.signed_bytes);
    expect(after.state).toBe('ok');
    expect(chain.sends.filter((s) => s.method === 'nft_transfer')).toHaveLength(1);
  });

  // spec: add-gift › Gift flow › исход неизвестен
  it('ends an expired, unseen transfer as failed when the giver still owns the pet', async () => {
    const { giver, giverToken, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'lost';
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('unknown');
    chain.blockHeight = 87_401;
    expect((await outcome(giverToken)).body.status).toBe('failed');
    expect((await env.DB.prepare('SELECT state FROM gift_flights WHERE token_id = ?').bind(PET).first<any>()).state).toBe('failed');
    expect((await api(`/api/pets/${PET}/gift`, { token: giverToken, method: 'DELETE' })).status).toBe(200);
  });

  // spec: add-gift › Gift ownership data › запись дневника до подарка
  it('does not replace a missing execution block time with the send time after expiry', async () => {
    const { giver, giverToken, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'executed-but-silent';
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('unknown');
    const flight = await env.DB.prepare('SELECT created_at FROM gift_flights WHERE token_id = ?').bind(PET).first<{ created_at: number }>();
    chain.blockTimestampMs = flight!.created_at;
    chain.mode = 'normal';
    chain.txBlind = true;
    chain.blockHeight = 87_401;
    vi.setSystemTime(new Date(flight!.created_at + 86_400_000));
    const friendToken = await token('did:privy:gift-tx-friend', FRIEND);
    expect((await outcome(friendToken)).body.status).toBe('unknown');
    expect((await env.DB.prepare('SELECT last_gift_block_at FROM pets WHERE token_id = ?').bind(PET).first<any>()).last_gift_block_at).toBeNull();
    chain.txBlind = false;
    expect((await outcome(friendToken)).body.status).toBe('ok');
    expect((await env.DB.prepare('SELECT last_gift_block_at FROM pets WHERE token_id = ?').bind(PET).first<any>()).last_gift_block_at).toBe(flight!.created_at);
  });

  // spec: add-gift › Gift accept flow › получил без него
  it('reconciles a landed flight from the recipient gift page without a giver poll', async () => {
    const { giver, giverToken, friendToken, code, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'executed-but-silent';
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('unknown');
    chain.mode = 'normal';
    expect((await api(`/api/gifts/${code}`, { token: friendToken })).body).toMatchObject({ status: 'transferred', viewer: 'receiver' });
    expect((await env.DB.prepare('SELECT status FROM gift_links WHERE code = ?').bind(code).first<any>()).status).toBe('transferred');
  });

  // spec: add-gift › Gift accept flow › получил без него
  it('shows the completed gift while the status node lags the owner view', async () => {
    const { giver, giverToken, friendToken, code, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'executed-but-silent';
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('unknown');
    chain.mode = 'normal';
    chain.txBlind = true;
    expect((await api(`/api/gifts/${code}`, { token: friendToken })).body).toMatchObject({ status: 'transferred', viewer: 'receiver' });
    expect((await env.DB.prepare('SELECT state FROM gift_flights WHERE token_id = ?').bind(PET).first<any>()).state).toBe('unknown');
    expect((await env.DB.prepare('SELECT status FROM gift_links WHERE code = ?').bind(code).first<any>()).status).toBe('accepted');
    chain.txBlind = false;
    expect((await api(`/api/gifts/${code}`, { token: friendToken })).body.status).toBe('transferred');
    expect((await env.DB.prepare('SELECT state FROM gift_flights WHERE token_id = ?').bind(PET).first<any>()).state).toBe('ok');
    expect((await env.DB.prepare('SELECT status, accepted_name FROM gift_links WHERE code = ?').bind(code).first<any>())).toMatchObject({ status: 'transferred', accepted_name: null });
  });

  // spec: add-gift › Gift ownership data › запись дневника до подарка
  it('keeps the Gift page complete but waits for the execution block before recording the diary boundary', async () => {
    const { giver, giverToken, friendToken, code, chain } = await setup();
    const made = await prepare(giverToken);
    const preparedAt = Date.now();
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status, origin_owner, origin_sent_at) VALUES (?, ?, ?, 'diary', NULL, ?, 'm', '1', 0, 'pet', 'unbilled', ?, ?)")
      .bind('diary-between-send-and-transfer', PET, preparedAt + 30_000, 'A note to the giver.', giver.account, preparedAt + 30_000).run();
    vi.setSystemTime(new Date(preparedAt + 60_000));
    const transferBlockAt = Date.now();
    chain.blockTimestampMs = transferBlockAt;
    chain.mode = 'executed-but-silent';
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('unknown');
    chain.mode = 'normal';
    chain.txBlind = true;
    expect((await api(`/api/gifts/${code}`, { token: friendToken })).body).toMatchObject({ status: 'transferred', viewer: 'receiver' });
    expect((await env.DB.prepare('SELECT state FROM gift_flights WHERE token_id = ?').bind(PET).first<any>()).state).not.toBe('ok');
    expect((await env.DB.prepare('SELECT last_gift_block_at FROM pets WHERE token_id = ?').bind(PET).first<any>()).last_gift_block_at).toBeNull();
    chain.txBlind = false;
    vi.setSystemTime(new Date(transferBlockAt + 120_000));
    expect((await outcome(friendToken)).body.status).toBe('ok');
    expect((await env.DB.prepare('SELECT last_gift_block_at FROM pets WHERE token_id = ?').bind(PET).first<any>()).last_gift_block_at).toBe(transferBlockAt);
    expect((await api(`/api/pets/${PET}/diary`, { token: friendToken })).body.entry).toMatchObject({ kind: 'text', previousOwner: true });
  });

  // spec: add-gift › Gift ownership data › запись дневника до подарка
  it('keeps the Gift page complete when the status is known but its block is temporarily unavailable', async () => {
    const { giver, giverToken, friendToken, code, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'executed-but-silent';
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('unknown');
    chain.mode = 'normal';
    chain.blockBlind = true;
    expect((await api(`/api/gifts/${code}`, { token: friendToken })).body).toMatchObject({ status: 'transferred', viewer: 'receiver' });
    expect((await env.DB.prepare('SELECT last_gift_block_at FROM pets WHERE token_id = ?').bind(PET).first<any>()).last_gift_block_at).toBeNull();
    chain.blockBlind = false;
    expect((await outcome(friendToken)).body.status).toBe('ok');
  });

  // spec: add-gift › Gift link data › former owner tries to cancel
  it('settles the old transfer before the recipient creates their next link', async () => {
    const { giver, giverToken, friendToken, code, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'executed-but-silent';
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('unknown');
    chain.mode = 'normal';
    expect((await api(`/api/pets/${PET}/gift`, { token: friendToken, method: 'POST' })).status).toBe(200);
    expect((await env.DB.prepare('SELECT state FROM gift_flights WHERE token_id = ?').bind(PET).first<any>()).state).toBe('ok');
    expect((await env.DB.prepare('SELECT last_gift_block_at FROM pets WHERE token_id = ?').bind(PET).first<any>()).last_gift_block_at).not.toBeNull();
    expect((await api(`/api/gifts/${code}`, { token: friendToken })).status).toBe(404);
  });

  // spec: add-gift › Gift flow › передаёт × second tab
  it('stores the hash and signed bytes before the only RPC broadcast', async () => {
    const { giver, giverToken, chain } = await setup();
    const made = await prepare(giverToken);
    const signed = await giver.sign(made.body.tx);
    let observation: unknown = null;
    chain.meanwhile.send_tx = async () => {
      try {
        const row = await env.DB.prepare('SELECT tx_hash, signed_bytes, state FROM gift_flights WHERE token_id = ?').bind(PET).first<any>();
        expect(row.tx_hash).toBeTruthy();
        const stored = decodeSignedTransaction(Uint8Array.from(row.signed_bytes as number[]));
        expect(stored.transaction.encode()).toEqual(Uint8Array.from(atob(signed.tx), (c) => c.charCodeAt(0)));
        expect(Uint8Array.from(stored.signature.ed25519Signature!.data)).toEqual(Uint8Array.from(atob(signed.signature), (c) => c.charCodeAt(0)));
        expect(row.state).toBe('sending');
        expect((await api(`/api/pets/${PET}/gift`, { token: giverToken, method: 'DELETE' })).status).toBe(409);
      } catch (error) {
        observation = error;
      }
    };
    expect((await send(giverToken, signed)).body.status).toBe('ok');
    expect(observation).toBeNull();
    expect(chain.sends.filter((s) => s.method === 'nft_transfer')).toHaveLength(1);
  });

  // spec: add-gift › Gift flow › chain rejected for gas
  it('keeps the accepted friend after a definite gas rejection and permits a new preparation', async () => {
    const { giver, giverToken, code, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'not-enough-balance';
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('gas_rejected');
    expect((await outcome(giverToken)).body.status).toBe('gas_rejected');
    expect((await env.DB.prepare('SELECT status, accepted_account FROM gift_links WHERE code = ?').bind(code).first<any>())).toMatchObject({ status: 'accepted', accepted_account: FRIEND });
    chain.mode = 'normal';
    expect((await prepare(giverToken)).body.status).toBe('ready');
  });

  // spec: add-gift › Gift flow › не прошло
  it('keeps acceptance after a definite nonce refusal and allows a fresh signed transfer', async () => {
    const { giver, giverToken, code, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'invalid-nonce';
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('failed');
    expect((await env.DB.prepare('SELECT status FROM gift_links WHERE code = ?').bind(code).first<any>()).status).toBe('accepted');
    chain.mode = 'normal';
    const fresh = await prepare(giverToken);
    expect(fresh.body.status).toBe('ready');
    expect((await send(giverToken, await giver.sign(fresh.body.tx))).body.status).toBe('ok');
  });

  // spec: add-gift › Gift flow › не прошло
  it('settles an unseen flight as failed when another owner takes the pet', async () => {
    const { giver, giverToken, code, chain } = await setup();
    const made = await prepare(giverToken);
    chain.mode = 'lost';
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('unknown');
    chain.pets.get(PET)!.owner_id = NEAR_ACCOUNT(10);
    expect((await outcome(giverToken)).body.status).toBe('failed');
    expect((await env.DB.prepare('SELECT status FROM gift_links WHERE code = ?').bind(code).first<any>()).status).toBe('cancelled');
  });

  // spec: add-gift › Gift flow › подарен
  it('clears the name and moves current pet and the unmarked ritual exactly once on confirmation', async () => {
    const { giver, giverToken, friendToken, code } = await setup();
    await env.DB.prepare('UPDATE players SET current_pet = ? WHERE account_id = ?').bind(PET, giver.account).run();
    const made = await prepare(giverToken);
    expect((await send(giverToken, await giver.sign(made.body.tx))).body.status).toBe('ok');
    const link = await env.DB.prepare('SELECT status, accepted_account, accepted_name, transferred_at FROM gift_links WHERE code = ?').bind(code).first<any>();
    expect(link).toMatchObject({ status: 'transferred', accepted_account: FRIEND, accepted_name: null });
    expect(link.transferred_at).toBeGreaterThan(0);
    expect((await env.DB.prepare('SELECT gifted_unmarked, last_gift_block_at FROM pets WHERE token_id = ?').bind(PET).first<any>())).toMatchObject({ gifted_unmarked: 1, last_gift_block_at: link.transferred_at });
    expect((await env.DB.prepare('SELECT current_pet, last_gifted_pet FROM players WHERE account_id = ?').bind(giver.account).first<any>())).toMatchObject({ current_pet: null, last_gifted_pet: PET });
    expect((await env.DB.prepare('SELECT current_pet FROM players WHERE account_id = ?').bind(FRIEND).first<any>()).current_pet).toBe(PET);
    await env.DB.prepare('UPDATE players SET current_pet = NULL WHERE account_id = ?').bind(FRIEND).run();
    expect((await outcome(friendToken)).body.status).toBe('ok');
    expect((await env.DB.prepare('SELECT current_pet FROM players WHERE account_id = ?').bind(FRIEND).first<any>()).current_pet).toBeNull();
  });
});
