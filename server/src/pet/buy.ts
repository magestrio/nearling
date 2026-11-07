// Buying an outfit (`Outfit purchase flow`): the owner's tap queues a row of `outfit_buys`, the pet's
// desk runs it as one more spend of the pet (`Thought queue data`: one at a time), and the server writes
// `outfit_buy` with its own key. The rows are a queue of their own, not rows of `jobs`: a clear of the
// memory fails every queued job and must not cancel a purchase.
//
// `queued` -> `sending` -> `bought` | `failed`, or `sending` -> `unknown` -> `bought` | `failed`. The
// price of a row in `sending` or `unknown` is held against the pet's food and daily cap (`foodState`).
import { ChainUnreachable, OUTFIT_BUY_TGAS, petView } from '../chain';
import { nearUsdRate, yoctoToUsdMicros, fullness, OUTFIT_PRICE_YOCTO } from '../pricing';
import { gasIsLow, isPaused } from '../servicePause';
import { track } from '../track';
import { dropItemSendStatement, itemTxStatements } from './itemTx';
import { idOf, OUTFITS, type OutfitSlug } from './outfits';
import { foodState } from './view';
import { releaseWishAfterOwnerBuy } from '../will/purchase';
import { recordWillEvent } from '../will/events';

export type BuyStatus = 'queued' | 'sending' | 'unknown' | 'bought' | 'failed';

export interface BuyRow {
  id: string;
  token_id: string;
  item: OutfitSlug;
  status: BuyStatus;
  price_yocto: string;
  given_yocto: string | null;
  tx_hash: string | null;
  code: string | null;
  created_at: number;
  settled_at: number | null;
  source: 'owner' | 'pet_wish';
}

export const BUY_COLUMNS = 'id, token_id, item, status, price_yocto, given_yocto, tx_hash, code, created_at, settled_at, source';

/** The contract's refusal codes in the words of a buy's `code`; any other contract code is kept as it is. */
const CODE_OF: Record<string, string> = { outfit_owned: 'owned', daily_cap: 'cap', over_food: 'short' };
export const buyCode = (code: string): string => CODE_OF[code] ?? code;

/** Queues a purchase of `item`, or returns the open one of this pet and item: one statement, so a
 * second tap, from any tab, makes no second purchase (`Outfit purchase flow` › «покупает»). */
export async function queueBuy(db: D1Database, tokenId: string, item: OutfitSlug): Promise<string> {
  const id = crypto.randomUUID().replaceAll('-', '');
  const made = await db
    .prepare(
      "INSERT INTO outfit_buys (id, token_id, item, status, price_yocto, created_at) SELECT ?1, ?2, ?3, 'queued', ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM outfit_buys WHERE token_id = ?2 AND item = ?3 AND status IN ('queued', 'sending', 'unknown')) RETURNING id",
    )
    .bind(id, tokenId, item, OUTFIT_PRICE_YOCTO.toString(), Date.now())
    .first<{ id: string }>();
  if (made !== null) return made.id;
  const open = await db
    .prepare("SELECT id FROM outfit_buys WHERE token_id = ? AND item = ? AND status IN ('queued', 'sending', 'unknown') ORDER BY created_at, rowid LIMIT 1")
    .bind(tokenId, item)
    .first<{ id: string }>();
  return open!.id;
}

/** The oldest purchase of the pet that has not been taken yet. */
export function nextBuy(db: D1Database, tokenId: string): Promise<BuyRow | null> {
  return db
    .prepare(`SELECT ${BUY_COLUMNS} FROM outfit_buys WHERE token_id = ? AND status = 'queued' ORDER BY created_at, rowid LIMIT 1`)
    .bind(tokenId)
    .first<BuyRow>();
}

/** The end of a purchase: bought (the chain wrote the item) or failed (nothing was spent). */
export type BuyEnd =
  // `wrote`: the network answered `ok` for `txHash`, so that transaction wrote the item and its hash is kept
  // (`itemTxStatements`). Without it the hash is only noted on the row; `settleItemSends` confirms it.
  | { status: 'bought'; burnt?: string | null; txHash?: string | null; wrote?: boolean }
  // `txHash`: the transaction the network answered `failed` (or refused): it wrote nothing.
  // `unlessSent`: the cron's «nothing was signed»; the flip changes nothing when a hash is noted for the pair
  // (`item_sends`), in the one statement, so a send that noted its hash a moment ago is not called unspent.
  | { status: 'failed'; code: string; txHash?: string | null; unlessSent?: boolean };

/** Settles a purchase once. The flip is the only statement that can move the row, so of two writers (the
 * desk and the cron) one wins; in the same batch a bought item is put on the pet (`Outfit rule` › «надел»,
 * with the tab closed too). Only the winner fires the analytics event and adds the gas. Returns whether
 * this call settled the row. */
export async function finishBuy(env: Env, row: BuyRow, end: BuyEnd): Promise<boolean> {
  const now = Date.now();
  const unlessSent = end.status === 'failed' && end.unlessSent === true;
  const flip = env.DB
    .prepare(
      `UPDATE outfit_buys SET status = ?2, code = ?3, tx_hash = COALESCE(?4, tx_hash), settled_at = ?5 WHERE id = ?1 AND status IN ('queued', 'sending', 'unknown')${
        unlessSent ? ' AND NOT EXISTS (SELECT 1 FROM item_sends WHERE token_id = ?6 AND item = ?7)' : ''
      } RETURNING id`,
    )
    .bind(...[row.id, end.status, end.status === 'failed' ? end.code : null, end.txHash ?? null, now, ...(unlessSent ? [row.token_id, row.item] : [])]);
  // `changes()` is the flip's: the item is worn only by the writer that settled the row.
  const wear = env.DB
    .prepare('INSERT INTO wardrobe (token_id, worn) SELECT ?1, ?2 WHERE changes() > 0 ON CONFLICT (token_id) DO UPDATE SET worn = excluded.worn')
    .bind(row.token_id, row.item);
  // After the flip and the wear, whose `changes()` is the flip's: the hash that wrote the item, kept; or the
  // hash of a send that failed, dropped.
  const hash =
    end.status === 'bought'
      ? end.wrote && end.txHash ? itemTxStatements(env.DB, row.token_id, row.item, end.txHash, now) : []
      : end.txHash ? [dropItemSendStatement(env.DB, end.txHash)] : [];
  const written = await env.DB.batch(end.status === 'bought' ? [flip, wear, ...hash] : [flip, ...hash]);
  if (written[0]!.results.length === 0) return false;

  if (end.status === 'failed') {
    if (row.source === 'pet_wish' && end.code === 'cap') {
      await env.DB.prepare("UPDATE pet_wishes SET status = 'waiting_day' WHERE token_id = ? AND status = 'buying'").bind(row.token_id).run();
    }
    console.log(`outfit_buy_failed:${end.code}`);
    return true;
  }
  console.log('outfit_bought');
  if (row.source === 'pet_wish') {
    await env.DB.prepare("DELETE FROM pet_wishes WHERE token_id = ? AND item = ? AND status IN ('buying', 'waiting_day')")
      .bind(row.token_id, row.item).run();
  }
  if (row.source === 'owner') await releaseWishAfterOwnerBuy(env, row.token_id, row.item);
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  const usd = (yocto: bigint) => (rate === null ? 0 : yoctoToUsdMicros(yocto, rate) / 1_000_000);
  track('outfit_bought', {
    item: OUTFITS.find((o) => o.slug === row.item)!.event,
    price_usd: usd(BigInt(row.price_yocto)),
    given_usd: usd(BigInt(row.given_yocto ?? '0')),
    ...(row.source === 'pet_wish' ? { via: 'pet_wish' } : {}),
  });
  if (row.source === 'pet_wish') await recordWillEvent(env, 'outfit_bought', { id: row.id, via: 'pet_wish' });
  if (end.burnt != null) {
    if (rate === null) console.log('rate_missing');
    else await env.DB.prepare('INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, ?, ?)').bind(now, 'gas', yoctoToUsdMicros(BigInt(end.burnt), rate)).run();
  }
  return true;
}

/** Runs one queued purchase, in the order of design.md › The purchase: the gas pause, the pet from the
 * chain, the item not there yet, the food and the cap, then the send. Every refusal before the send is a
 * `failed` row with no transaction; a send with no outcome is `unknown` and the desk goes on. Never leaves
 * the row `queued`. */
export async function runBuy(env: Env, row: BuyRow): Promise<void> {
  const refuse = (code: string) => finishBuy(env, row, { status: 'failed', code });
  const now = Date.now();
  if (await isPaused(env.DB, 'outfit')) {
    await refuse('paused');
    return;
  }
  let pet;
  try {
    // The server's gas is read before a send: a low balance pauses now, not at the next minute.
    if (await gasIsLow(env, now)) {
      await refuse('paused');
      return;
    }
    pet = await petView(env, row.token_id);
  } catch (e) {
    if (!(e instanceof ChainUnreachable)) throw e;
    await refuse('chain_unreachable');
    return;
  }
  if (pet === null) {
    await refuse('no_pet');
    return;
  }
  const item = idOf(row.item);
  if (pet.outfits.includes(item)) {
    await refuse('owned');
    return;
  }
  const price = BigInt(row.price_yocto);
  const food = await foodState(env.DB, row.token_id, pet, now);
  if (row.source === 'pet_wish') {
    const wish = await env.DB.prepare("SELECT item, status, owner_generation FROM pet_wishes WHERE token_id = ?")
      .bind(row.token_id).first<{ item: string; status: string; owner_generation: number }>();
    if (wish?.item !== row.item || wish.status !== 'buying' || wish.owner_generation !== pet.transfer_generation || !pet.wish_active || BigInt(pet.wish_reserve ?? '0') < price) {
      await refuse('wish_unavailable');
      return;
    }
  }
  // Not «Full» after the price (also an asleep pet), or over the day's cap with the thoughts the network
  // has not seen: the contract cannot know either (`Outfit purchase contract`).
  if (row.source === 'owner' && fullness(food.room - price).state !== 'full') {
    await refuse('short');
    return;
  }
  if (price > food.capLeft) {
    await refuse('cap');
    return;
  }

  // The price is held from here. The part paid from given food, for the analytics event, is what the
  // project's food does not cover (the contract takes the project's food first).
  const projectFood = BigInt(pet.project_food);
  const given = row.source === 'pet_wish' ? 0n : price - (price < projectFood ? price : projectFood);
  const taken = await env.DB.prepare("UPDATE outfit_buys SET status = 'sending', given_yocto = ?2, sending_at = ?3 WHERE id = ?1 AND status = 'queued' RETURNING id")
    .bind(row.id, given.toString(), Date.now())
    .first();
  if (taken === null) return;
  const sending: BuyRow = { ...row, status: 'sending', given_yocto: given.toString() };

  const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
    methodName: 'outfit_buy',
    args: { token_id: row.token_id, item, ...(row.source === 'pet_wish' ? { via_wish: true } : {}) },
    gas: (OUTFIT_BUY_TGAS * 1_000_000_000_000n).toString(),
    writes: { tokenId: row.token_id, item: row.item, buy: row.id },
  });
  if (answer.status === 'ok') {
    await finishBuy(env, sending, { status: 'bought', burnt: answer.burnt ?? null, txHash: answer.txHash, wrote: true });
    return;
  }
  if (answer.status === 'failed') {
    await finishBuy(env, sending, { status: 'failed', code: buyCode(answer.code), txHash: answer.txHash });
    return;
  }
  if (answer.status === 'unreachable') {
    // Nothing was signed or sent: nothing was spent.
    await finishBuy(env, sending, { status: 'failed', code: 'unreachable' });
    return;
  }
  // The outcome was not heard: the price stays held, the cron finds out (`unknown` below).
  await env.DB.prepare("UPDATE outfit_buys SET status = 'unknown', tx_hash = ?2 WHERE id = ?1 AND status = 'sending'").bind(row.id, answer.txHash).run();
  console.log('outfit_buy_unknown');
}

/** A purchase whose desk call threw before it was settled: failed if it was still queued (never leave it
 * to be taken again for ever). A row already `sending` is the cron's. */
export async function failIfQueued(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE outfit_buys SET status = 'failed', code = 'error', settled_at = ? WHERE id = ? AND status = 'queued'")
    .bind(Date.now(), id)
    .run();
}
