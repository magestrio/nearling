// The transaction that wrote an item (`add-wardrobe` › groups 11.1–11.4; design.md › The item's transaction):
// its hash is noted before every broadcast, kept by the writer that hears `ok`, found later by the cron when
// the answer was lost, and stays through a gift and a clear of the memory. Also the purchase whose desk died
// with the send. The writers' own behavior is in `wardrobe-buy.test.ts` and `wardrobe-grant.test.ts`.
import { env } from 'cloudflare:workers';
import { baseEncode } from 'near-api-js';
import { describe, expect, it, vi } from 'vitest';
import { OUTFIT_BUY_TGAS, OUTFIT_GRANT_TGAS } from '../src/chain';
import { outfits, settleBuys } from '../src/cron';
import { finishBuy, type BuyRow } from '../src/pet/buy';
import { desk } from '../src/pet/desk';
import { settleItemSends } from '../src/pet/itemTx';
import { writeDueGrant } from '../src/pet/grant';
import { writeDueMark } from '../src/pet/mark';
import { finishReveal } from '../src/riddle/cron';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const OTHER = NEAR_ACCOUNT(2);
const owner = () => token('did:privy:owner', OWNER);
const DAY_MS = 86_400_000;
const DAY = Math.floor(Date.UTC(2036, 10, 4) / DAY_MS);
const MINUTE = 60_000;
const at = (hh: number, mm: number, ss = 0, day = DAY) => {
  const t = day * DAY_MS + ((hh * 60 + mm) * 60 + ss) * 1000;
  vi.setSystemTime(t);
  return t;
};

const chain = () => h.net().contract;
const sends = () => env.DB.prepare('SELECT * FROM item_sends ORDER BY sent_at, rowid').all<any>().then((r) => r.results);
const kept = () => env.DB.prepare('SELECT * FROM pet_transactions ORDER BY ref').all<any>().then((r) => r.results);
const buyRows = () => env.DB.prepare('SELECT * FROM outfit_buys ORDER BY created_at, rowid').all<any>().then((r) => r.results);
const buyRow = async () => (await buyRows()).at(-1)!;
const grantRows = () => env.DB.prepare('SELECT * FROM outfit_grants').all<any>().then((r) => r.results);
const worn = async () => (await env.DB.prepare("SELECT worn FROM wardrobe WHERE token_id = '5'").first<{ worn: string | null }>())?.worn ?? null;
/** The hashes of the transactions the fake network executed with success, in the order they landed. */
const landed = () => [...chain().outcomes.entries()].filter(([, o]) => 'SuccessValue' in ((o as { status: object }).status)).map(([hash]) => hash);
/** The network's answer for a hash it can be asked about: the transaction executed with success. */
const okOutcome = (hash: string) => ({
  final_execution_status: 'EXECUTED_OPTIMISTIC',
  status: { SuccessValue: '' },
  transaction: { hash, signer_id: env.SERVER_ACCOUNT_ID },
  transaction_outcome: { id: hash, outcome: { tokens_burnt: '0' } },
  receipts_outcome: [],
});
const serverKey = () => env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server'));
const done = () => desk(env, '5').process('5');
const well = (patch: Record<string, unknown> = {}) => chain().addPet('5', OWNER, { given_food: (10n ** 24n).toString(), ...patch });
const buy = async (item = 'smart-glasses') => api('/api/pets/5/wardrobe/buy', { token: await owner(), body: { item } });
const buyCall = { methodName: 'outfit_buy', args: { token_id: '5', item: 3 }, gas: (OUTFIT_BUY_TGAS * 10n ** 12n).toString(), writes: { tokenId: '5', item: 'smart-glasses' } };
/** A hash the way the network spells one (base58 of 32 bytes), distinct for each `n`. */
const hashOf = (n: number) => baseEncode(new Uint8Array(32).fill(n + 1));
const lostAnswers = () => h.logs().filter((l) => l === 'item_tx_lost');

describe('Outfit purchase flow: the hash before the send', () => {
  // spec: add-wardrobe › Outfit purchase flow › куплено × the item's transaction
  it('stands in item_sends when the transaction reaches the network, and a nonce retry adds its own', async () => {
    well();
    chain().mode = 'nonce-once';
    const seen: any[][] = [];
    const look = async () => {
      seen.push(await sends());
      // the retry is a second transaction: the hook runs for it as well
      if (seen.length < 2) chain().meanwhile.send_tx = look;
    };
    chain().meanwhile.send_tx = look;
    await buy();
    await done();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject([{ token_id: '5', item: 'smart-glasses', checked_at: null }]);
    expect(seen[1]).toHaveLength(2);
    expect(new Set(seen[1]!.map((r) => r.tx_hash)).size).toBe(2);
    // the one that landed is kept; the pair's rows are over
    expect(await buyRow()).toMatchObject({ status: 'bought' });
    expect(landed()).toHaveLength(1);
    expect(await kept()).toMatchObject([{ token_id: '5', kind: 'item', ref: 'smart-glasses', tx_hash: landed()[0] }]);
    expect(await sends()).toEqual([]);
  });

  // spec: add-wardrobe › Outfit purchase flow › не прошло × the hash cannot be stored
  it('sends nothing when the hash cannot be stored: the purchase fails and nothing was spent', async () => {
    well();
    await env.DB.exec("CREATE TRIGGER no_notes BEFORE INSERT ON item_sends BEGIN SELECT RAISE(ABORT, 'full'); END");
    try {
      await buy();
      await done();
    } finally {
      await env.DB.exec('DROP TRIGGER no_notes');
    }
    expect(chain().attempts).toBe(0);
    expect(await buyRow()).toMatchObject({ status: 'failed', code: 'unreachable' });
    expect(await worn()).toBeNull();
    expect(chain().pets.get('5')!.outfits).toEqual([]);
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toEqual([]);
    expect(await kept()).toEqual([]);
  });

  // spec: add-wardrobe › Outfit purchase flow › не прошло × a refused send
  it('keeps no hash for a send the network refused or the chain failed', async () => {
    well();
    chain().mode = 'not-enough-balance';
    await buy();
    await done();
    expect(await buyRow()).toMatchObject({ status: 'failed', code: 'not_enough_balance' });
    expect(await sends()).toEqual([]);
    expect(await kept()).toEqual([]);

    chain().mode = 'normal';
    chain().buyFails = 'over_food';
    await buy();
    await done();
    expect(await buyRow()).toMatchObject({ status: 'failed', code: 'short' });
    expect(await sends()).toEqual([]);
    expect(await kept()).toEqual([]);
    expect(await worn()).toBeNull();
  });
});

describe('Outfit purchase flow: the item\'s transaction', () => {
  // spec: add-wardrobe › Outfit purchase flow › куплено × the item's transaction
  it('keeps the hash of the transaction that wrote the bought item, at once', async () => {
    well();
    await buy('bow-tie');
    await done();
    expect(await buyRow()).toMatchObject({ status: 'bought', item: 'bow-tie' });
    expect(landed()).toHaveLength(1);
    expect(await kept()).toEqual([{ token_id: '5', kind: 'item', ref: 'bow-tie', tx_hash: landed()[0], at: Date.now() }]);
    expect((await buyRow()).tx_hash).toBe(landed()[0]);
    expect(await sends()).toEqual([]);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × outcome unknown
  it('finds the hash of a purchase whose answer was lost: the cron finds the item, a few minutes on the hash is kept', async () => {
    well();
    chain().mode = 'executed-but-silent';
    await buy();
    await done();
    chain().mode = 'normal';
    expect(await buyRow()).toMatchObject({ status: 'unknown' });
    expect(await sends()).toHaveLength(1);

    await settleBuys(env, Date.now() + MINUTE);
    expect(await buyRow()).toMatchObject({ status: 'bought' });
    expect(await kept()).toEqual([]);
    // the row for the hash is old enough to be asked after
    await outfits(env, Date.now() + 2 * MINUTE);
    expect(await kept()).toMatchObject([{ ref: 'smart-glasses', tx_hash: landed()[0] }]);
    expect(await sends()).toEqual([]);
  });
});

describe('Outfit purchase flow: the desk dies with the send', () => {
  // `sentAt`: when the row turned `sending`; it was queued at `created` (the same moment unless it waited).
  const insertSending = (created: number, sentAt = created) =>
    env.DB.prepare("INSERT INTO outfit_buys (id, token_id, item, status, price_yocto, given_yocto, created_at, sending_at) VALUES ('d', '5', 'smart-glasses', 'sending', ?, '0', ?, ?)")
      .bind(env.OUTFIT_PRICE, created, sentAt)
      .run();

  // spec: add-wardrobe › Outfit purchase flow › покупает × the desk dies before the send
  it('fails a row sending for 5 minutes with no hash noted: nothing was signed, nothing was spent', async () => {
    well();
    const created = Date.now();
    await insertSending(created);
    await settleBuys(env, created + 5 * MINUTE);
    expect(await buyRow()).toMatchObject({ status: 'sending' });
    await settleBuys(env, created + 5 * MINUTE + 1);
    expect(await buyRow()).toMatchObject({ id: 'd', status: 'failed', code: 'error' });
    expect(await worn()).toBeNull();
    expect(chain().sends).toEqual([]);
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toEqual([]);
    // the owner can try again: a new row
    expect((await buy()).body.id).not.toBe('d');
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × the desk dies after the send, the item landed
  it('finds the item on the chain: bought, worn, once, and the hash is kept by the cron', async () => {
    well();
    chain().mode = 'executed-but-silent';
    const sent = await serverKey().send(buyCall);
    chain().mode = 'normal';
    expect(sent).toMatchObject({ status: 'unknown' });
    const created = Date.now();
    await insertSending(created);

    await settleBuys(env, created + 5 * MINUTE + 1);
    expect(await buyRow()).toMatchObject({ id: 'd', status: 'bought' });
    expect(await worn()).toBe('smart-glasses');
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toHaveLength(1);
    expect(chain().sends.filter((s) => s.method === 'outfit_buy')).toHaveLength(1);

    await settleBuys(env, created + 6 * MINUTE);
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toHaveLength(1);
    await settleItemSends(env, created + 6 * MINUTE);
    expect(await kept()).toMatchObject([{ ref: 'smart-glasses', tx_hash: landed()[0] }]);
    expect(await sends()).toEqual([]);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × the desk dies after the send, nothing landed yet
  it('keeps the price held by the hash noted: unknown, then bought when the transaction lands, failed only at 24 hours', async () => {
    well();
    chain().mode = 'lost';
    const sent = (await serverKey().send(buyCall)) as { status: string; txHash: string };
    chain().mode = 'normal';
    expect(sent.status).toBe('unknown');
    const created = Date.now();
    await insertSending(created);

    await settleBuys(env, created + 5 * MINUTE + 1);
    expect(await buyRow()).toMatchObject({ id: 'd', status: 'unknown', tx_hash: sent.txHash, code: null });
    expect(await worn()).toBeNull();
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toEqual([]);

    // it lands: the pet has the item and the network knows the hash
    chain().pets.get('5')!.outfits = [3];
    chain().outcomes.set(sent.txHash, okOutcome(sent.txHash));
    await settleBuys(env, created + 6 * MINUTE);
    expect(await buyRow()).toMatchObject({ id: 'd', status: 'bought' });
    expect(await worn()).toBe('smart-glasses');
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × the desk dies after the send, nothing landed yet
  it('fails the unknown row at 24 hours when the hash never lands', async () => {
    well();
    chain().mode = 'lost';
    await serverKey().send(buyCall);
    chain().mode = 'normal';
    const created = Date.now();
    await insertSending(created);
    await settleBuys(env, created + 5 * MINUTE + 1);
    expect(await buyRow()).toMatchObject({ status: 'unknown' });
    await settleBuys(env, created + 24 * 3_600_000);
    expect(await buyRow()).toMatchObject({ status: 'failed', code: 'expired' });
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × the desk dies before the send
  it('leaves a row that has been sending for less than 5 minutes to its desk', async () => {
    well();
    const created = Date.now();
    await insertSending(created);
    await outfits(env, created + 4 * MINUTE);
    expect(await buyRow()).toMatchObject({ status: 'sending' });
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × the desk dies before the send
  it('counts the five minutes from the moment the row turned sending, not from the moment it was queued', async () => {
    well();
    const sentAt = Date.now();
    // queued ten minutes before, waited in the desk's queue, turned `sending` just now
    await insertSending(sentAt - 10 * MINUTE, sentAt);
    await settleBuys(env, sentAt + 4 * MINUTE);
    expect(await buyRow()).toMatchObject({ id: 'd', status: 'sending', code: null });
    expect(chain().sends).toEqual([]);
    await settleBuys(env, sentAt + 5 * MINUTE + 1);
    expect(await buyRow()).toMatchObject({ id: 'd', status: 'failed', code: 'error' });
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × the desk dies before the send
  it('broadcasts nothing for a row the cron failed while its send waited in the key\'s queue', async () => {
    well();
    // A send ahead of the purchase holds the key's queue (a slow RPC); the purchase's row turns `sending` and waits.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    chain().meanwhile.send_tx = async () => {
      held = true;
      await gate;
    };
    const ahead = serverKey().send({ methodName: 'outfit_buy', args: { token_id: '5', item: 4 }, gas: buyCall.gas });
    await vi.waitFor(() => expect(held).toBe(true));
    const bought = await buy();
    await vi.waitFor(async () => expect(await buyRow()).toMatchObject({ status: 'sending' }));
    expect(await sends()).toEqual([]);

    // Five minutes on: nothing is signed, so the cron takes the row for a dead desk.
    const sendingAt = (await buyRow()).sending_at as number;
    await settleBuys(env, sendingAt + 5 * MINUTE + 1);
    expect(await buyRow()).toMatchObject({ id: bought.body.id, status: 'failed', code: 'error' });

    // The queue moves on: the send ahead lands, and the purchase's send finds its row failed and goes nowhere.
    release();
    expect(await ahead).toMatchObject({ status: 'ok' });
    await done();
    expect(await buyRow()).toMatchObject({ id: bought.body.id, status: 'failed', code: 'error' });
    expect(chain().buys.map((b) => b.item)).toEqual([4]);
    expect(chain().pets.get('5')!.outfits).toEqual([4]);
    expect(await worn()).toBeNull();
    expect(h.events().filter((e) => e.name === 'outfit_bought')).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(await kept()).toEqual([]);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает × the desk dies before the send
  it('does not fail a row whose hash was noted a moment before the flip: the same statement holds both', async () => {
    well();
    await insertSending(Date.now());
    const row = (await buyRow()) as BuyRow;
    await env.DB.prepare("INSERT INTO item_sends (tx_hash, token_id, item, sent_at) VALUES ('h1', '5', 'smart-glasses', ?)").bind(Date.now()).run();

    expect(await finishBuy(env, row, { status: 'failed', code: 'error', unlessSent: true })).toBe(false);
    expect(await buyRow()).toMatchObject({ id: 'd', status: 'sending', code: null });
    // the cron's next pass takes the noted hash: the price stays held
    await settleBuys(env, Date.now() + 5 * MINUTE + 1);
    expect(await buyRow()).toMatchObject({ id: 'd', status: 'unknown', tx_hash: 'h1' });
  });
});

describe('Hashes nobody settled', () => {
  const note = (hash: string, sentAt: number, item = 'smart-glasses') =>
    env.DB.prepare("INSERT INTO item_sends (tx_hash, token_id, item, sent_at) VALUES (?, '5', ?, ?)").bind(hash, item, sentAt).run();

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × the outcome lost, the hash found
  it('keeps the hash of an ok whichever send it was and clears the pair; a row younger than a claim is left alone', async () => {
    well();
    chain().mode = 'executed-but-silent';
    const sent = (await serverKey().send(buyCall)) as { txHash: string };
    chain().mode = 'normal';
    await note(hashOf(20), Date.now() - 1000);
    const sentAt = Date.now();

    await settleItemSends(env, sentAt + 59_000);
    expect(await sends()).toHaveLength(2);
    expect(await kept()).toEqual([]);

    await settleItemSends(env, sentAt + 61_000);
    expect(await kept()).toEqual([{ token_id: '5', kind: 'item', ref: 'smart-glasses', tx_hash: sent.txHash, at: sentAt + 61_000 }]);
    expect(await sends()).toEqual([]);
  });

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × a failed send, a resend landed
  it('drops the row of a send the network answers as failed, and no other', async () => {
    well();
    chain().buyFails = 'over_food';
    const failed = (await serverKey().send(buyCall)) as { status: string; txHash: string };
    chain().buyFails = null;
    expect(failed.status).toBe('failed');
    const sentAt = Date.now();
    await note(hashOf(21), sentAt);

    await settleItemSends(env, sentAt + 61_000);
    expect((await sends()).map((r) => r.tx_hash)).toEqual([hashOf(21)]);
    expect(await kept()).toEqual([]);
    expect(lostAnswers()).toEqual([]);
  });

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × the outcome lost, the hash found
  it('asks again about a hash the network did not know only after 10 minutes', async () => {
    well();
    const sentAt = Date.now();
    await note(hashOf(22), sentAt);
    await settleItemSends(env, sentAt + 61_000);
    expect(await sends()).toMatchObject([{ tx_hash: hashOf(22), checked_at: sentAt + 61_000 }]);

    // it lands meanwhile
    chain().outcomes.set(hashOf(22), okOutcome(hashOf(22)));
    await settleItemSends(env, sentAt + 61_000 + 9 * MINUTE);
    expect(await kept()).toEqual([]);
    await settleItemSends(env, sentAt + 61_000 + 10 * MINUTE);
    expect(await kept()).toMatchObject([{ ref: 'smart-glasses', tx_hash: hashOf(22) }]);
    expect(await sends()).toEqual([]);
  });

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × a hash the network never answers
  it('drops a hash the network never answered at 24 hours, and says so once when it was the pair\'s last', async () => {
    well();
    const sentAt = Date.now();
    await note(hashOf(23), sentAt);
    await note(hashOf(24), sentAt + 1);
    await settleItemSends(env, sentAt + 24 * 3_600_000 - 1);
    expect(await sends()).toHaveLength(2);
    expect(lostAnswers()).toEqual([]);

    await settleItemSends(env, sentAt + 25 * 3_600_000);
    expect(await sends()).toEqual([]);
    expect(await kept()).toEqual([]);
    expect(lostAnswers()).toHaveLength(1);
  });

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × the outcome lost, the hash found
  it('asks after the rows never looked at first, and at most ten a tick', async () => {
    well();
    const sentAt = Date.now() - 3_600_000;
    for (let n = 0; n < 12; n += 1) await note(hashOf(n), sentAt + n);
    // two were looked at an hour ago: eligible again, but after the ten never looked at
    await env.DB.prepare('UPDATE item_sends SET checked_at = ? WHERE tx_hash IN (?, ?)').bind(sentAt + 10, hashOf(0), hashOf(1)).run();
    await settleItemSends(env, Date.now());
    const askedNow = (await sends()).filter((r) => r.checked_at === Date.now()).map((r) => r.tx_hash);
    expect(askedNow.sort()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(hashOf).sort());
  });
});

describe('Earned outfit flow: the riddle\'s item and its transaction', () => {
  const riddle = (day: number) => env.DB.prepare('INSERT INTO riddles (day, text, answers, salt, hash, sealed_at) VALUES (?, ?, ?, ?, ?, 1)').bind(day, 'r', '["a clock"]', 's', 'h').run();
  async function waiting() {
    chain().addPet('7', OWNER);
    await riddle(DAY);
    await env.DB.prepare("INSERT INTO riddle_answers (token_id, day, text, correct, answered_at) VALUES ('7', ?, 'a clock', 1, 1)").bind(DAY).run();
    await finishReveal(env, DAY, at(0, 1, 0, DAY + 1), null);
  }

  // spec: add-wardrobe › Earned outfit flow › наряд за загадки × the item's transaction
  it('keeps the hash of the grant that landed, with the row\'s end', async () => {
    await waiting();
    expect(await writeDueGrant(env, '7')).toBe('written');
    expect(chain().sends.filter((s) => s.method === 'outfit_grant')[0]!.gas).toBe((OUTFIT_GRANT_TGAS * 10n ** 12n).toString());
    expect(landed()).toHaveLength(1);
    expect(await kept()).toEqual([{ token_id: '7', kind: 'item', ref: 'thinking-cap', tx_hash: landed()[0], at: Date.now() }]);
    expect(await sends()).toEqual([]);
    expect(await grantRows()).toEqual([]);
  });

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × the outcome lost, the hash found
  it('finds the hash of a grant whose answer was lost: the writer finds the item, the cron keeps the hash', async () => {
    await waiting();
    chain().mode = 'executed-but-silent';
    expect(await writeDueGrant(env, '7')).toBe('failed');
    chain().mode = 'normal';
    expect(await sends()).toMatchObject([{ token_id: '7', item: 'thinking-cap' }]);
    expect(await kept()).toEqual([]);

    expect(await writeDueGrant(env, '7')).toBe('found');
    expect(await kept()).toEqual([]);
    await outfits(env, Date.now() + 2 * MINUTE);
    expect(await kept()).toMatchObject([{ token_id: '7', ref: 'thinking-cap', tx_hash: landed()[0] }]);
    expect(await sends()).toEqual([]);
  });

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × a resend refused, the first send landed
  it('keeps the first send\'s hash when the resend is refused because the first landed', async () => {
    await waiting();
    chain().mode = 'lost';
    expect(await writeDueGrant(env, '7')).toBe('failed');
    chain().mode = 'normal';
    const [first] = (await sends()).map((r) => r.tx_hash as string);
    expect(first).toBeDefined();

    // the chain shows no item when the writer reads it, and the first send lands while the second is on its way
    chain().meanwhile.send_tx = async () => {
      chain().pets.get('7')!.outfits = [2];
      chain().outcomes.set(first!, okOutcome(first!));
    };
    // the contract refused the second send (`outfit_owned`): the writer takes it as the item being there
    expect(await writeDueGrant(env, '7')).toBe('found');
    expect(chain().sends.filter((s) => s.method === 'outfit_grant')).toHaveLength(1);
    expect(chain().grants).toEqual([]);
    expect(h.events().filter((e) => e.name === 'outfit_earned' && e.props.via === 'riddle')).toHaveLength(1);
    expect(await grantRows()).toEqual([]);
    // the second send's row went with its answer; the first one's hash is kept by the cron
    expect((await sends()).map((r) => r.tx_hash)).toEqual([first]);
    await settleItemSends(env, Date.now() + 2 * MINUTE);
    expect(await kept()).toMatchObject([{ token_id: '7', ref: 'thinking-cap', tx_hash: first }]);
    expect(await sends()).toEqual([]);
  });

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × a failed send, a resend landed
  it('keeps the hash of the resend that landed, not the one of the send that failed', async () => {
    await waiting();
    chain().grantFails = 'outfit_too_early';
    expect(await writeDueGrant(env, '7')).toBe('failed');
    chain().grantFails = null;
    expect(await sends()).toEqual([]);
    expect(await writeDueGrant(env, '7')).toBe('written');
    expect(landed()).toHaveLength(1);
    expect(chain().outcomes.size).toBe(2);
    expect(await kept()).toMatchObject([{ ref: 'thinking-cap', tx_hash: landed()[0] }]);
    expect(await sends()).toEqual([]);
  });

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × a hash the network never answers
  it('lets go of a hash the network never answered at 24 hours, logs it, and the item stays written', async () => {
    await waiting();
    chain().mode = 'lost';
    expect(await writeDueGrant(env, '7')).toBe('failed');
    chain().mode = 'normal';
    const sentAt = Date.now();
    await settleItemSends(env, sentAt + 2 * MINUTE);
    expect(await sends()).toHaveLength(1);
    await settleItemSends(env, sentAt + 24 * 3_600_000 + 1);
    expect(await sends()).toEqual([]);
    expect(await kept()).toEqual([]);
    expect(lostAnswers()).toHaveLength(1);
    expect(await grantRows()).toHaveLength(1);
  });
});

describe('Earned outfit flow: the streak\'s item and its transaction', () => {
  async function markPet(patch: { streak?: number; freezes?: number; last?: number | null; outfits?: number[] }) {
    chain().addPet('1', OWNER, { streak: patch.streak ?? 0, freezes: patch.freezes ?? 1, last_streak_day: patch.last ?? null, outfits: patch.outfits ?? [] });
    await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)').bind('1', OWNER, 1, '').run();
    await env.DB.prepare('INSERT OR IGNORE INTO ritual_clock (id, closed_day) VALUES (1, ?)').bind(DAY - 1).run();
  }
  const ended = (day: number) => env.DB.prepare('INSERT INTO ritual_days (token_id, day, completed_at, excused) VALUES (?, ?, ?, 0)').bind('1', day, day * DAY_MS + 3_600_000).run();

  // spec: add-wardrobe › Earned outfit flow › наряд за серию × the item's transaction
  it('keeps the hash of the mark that wrote the crown, and again at the scarf', async () => {
    await markPet({});
    await ended(DAY);
    at(10, 0);
    expect(await writeDueMark(env, '1')).toBe('written');
    expect(await kept()).toMatchObject([{ token_id: '1', kind: 'item', ref: 'daisy-crown', tx_hash: landed()[0] }]);
    expect(await sends()).toEqual([]);

    for (const day of [DAY + 1, DAY + 2]) {
      at(10, 0, 0, day);
      await env.DB.prepare('UPDATE ritual_clock SET closed_day = ? WHERE id = 1').bind(day - 1).run();
      await ended(day);
      expect(await writeDueMark(env, '1')).toBe('written');
    }
    expect((await kept()).map((r) => r.ref)).toEqual(['cozy-scarf', 'daisy-crown']);
    // two marks that wrote no item left no hash
    expect(landed()).toHaveLength(3);
    expect(await sends()).toEqual([]);
  });

  // spec: add-wardrobe › Earned outfit flow › наряд за серию × the outcome lost, the hash found
  it('finds the hash of a mark whose answer was lost', async () => {
    await markPet({});
    await ended(DAY);
    at(10, 0);
    chain().mode = 'executed-but-silent';
    expect(await writeDueMark(env, '1')).toBe('failed');
    chain().mode = 'normal';
    expect(await sends()).toMatchObject([{ token_id: '1', item: 'daisy-crown' }]);
    expect(await kept()).toEqual([]);

    expect(await writeDueMark(env, '1')).toBe('found');
    await outfits(env, Date.now() + 2 * MINUTE);
    expect(await kept()).toMatchObject([{ token_id: '1', ref: 'daisy-crown', tx_hash: landed()[0] }]);
    expect(await sends()).toEqual([]);
    expect(chain().sends.filter((s) => s.method === 'streak_mark')).toHaveLength(1);
  });

  // spec: add-wardrobe › Earned outfit flow › наряд за серию × a mark that wrote no item
  it('notes and keeps no hash for a mark that wrote no item', async () => {
    await markPet({ streak: 5, freezes: 0, last: DAY - 4, outfits: [0, 1] });
    await ended(DAY);
    at(10, 0);
    const seen: number[] = [];
    chain().meanwhile.send_tx = async () => {
      seen.push((await sends()).length);
    };
    expect(await writeDueMark(env, '1')).toBe('written');
    expect(chain().pets.get('1')!.streak).toBe(1);
    expect(seen).toEqual([0]);
    expect(await sends()).toEqual([]);
    expect(await kept()).toEqual([]);
  });
});

describe('Wardrobe data: the item\'s transaction', () => {
  // spec: add-wardrobe › Wardrobe data › после подарка × the item's transaction stays
  it('stays with the pet through a gift: the row is by token_id', async () => {
    well();
    await buy('headphones');
    await done();
    const before = await kept();
    expect(before).toMatchObject([{ token_id: '5', ref: 'headphones' }]);

    chain().pets.get('5')!.owner_id = OTHER;
    const res = await api('/api/pets/5', { token: await token('did:privy:other', OTHER) });
    expect(res.body).toMatchObject({ outfits: ['headphones'] });
    expect(await kept()).toEqual(before);
  });

  // spec: add-wardrobe › Wardrobe data › удаление памяти × the item's transaction stays
  it('stays through a clear of the memory, and a clear leaves the notes of sends alone', async () => {
    well();
    await buy('party-hat');
    await done();
    chain().mode = 'executed-but-silent';
    await buy('headphones');
    await done();
    chain().mode = 'normal';
    const before = await kept();
    expect(before).toMatchObject([{ ref: 'party-hat' }]);
    expect(await sends()).toHaveLength(1);

    const cleared = await api('/api/pets/5/memory/clear', { token: await owner(), body: {} });
    expect(cleared.status).toBe(200);
    expect(await kept()).toEqual(before);
    expect(await sends()).toHaveLength(1);
  });
});
