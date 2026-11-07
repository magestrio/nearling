import { decodeSignedTransaction } from 'near-api-js';
import { petView, sendSigned, transactionExpired, txStatus } from '../chain';
import { utcDay } from '../http';
import { nearUsdRate, OUTFIT_PRICE_YOCTO, yoctoToUsdMicros } from '../pricing';
import { gasIsLow } from '../servicePause';
import { track } from '../track';
import { recordWillEvent } from './events';
import { BOUGHT_IDS, idOf, isOutfitSlug } from '../pet/outfits';

const RELEASE_GAS = (5n * 1_000_000_000_000n).toString();
const id = () => crypto.randomUUID().replaceAll('-', '');

/** The chain has already credited a settled hire. D1 only mirrors its public reserve. */
// spec: add-pet-will › Wish pursuit flow › earned food settles
export async function noteWishSavings(env: Env, workerIds: string[]): Promise<void> {
  for (const tokenId of new Set(workerIds)) {
    const wish = await env.DB.prepare("SELECT item, status, owner_generation, noted_reserve_yocto FROM pet_wishes WHERE token_id = ? AND status IN ('active', 'buying', 'waiting_day')")
      .bind(tokenId).first<{ item: string; status: string; owner_generation: number; noted_reserve_yocto: string }>();
    if (wish === null) continue;
    const pet = await petView(env, tokenId);
    if (pet === null || pet.transfer_generation !== wish.owner_generation || !pet.wish_active) continue;
    const saved = BigInt(pet.wish_reserve ?? '0');
    if (saved <= BigInt(wish.noted_reserve_yocto)) continue;
    const recorded = await env.DB.prepare("UPDATE pet_wishes SET noted_reserve_yocto = ? WHERE token_id = ? AND noted_reserve_yocto = ? RETURNING token_id")
      .bind(saved.toString(), tokenId, wish.noted_reserve_yocto).first();
    if (recorded === null) continue;
    const delta = saved - BigInt(wish.noted_reserve_yocto);
    const rate = nearUsdRate(env.NEAR_USD_RATE);
    track('pet_wish_saved', { saved_usd: rate === null ? 0 : yoctoToUsdMicros(delta, rate) / 1_000_000 });
    await recordWillEvent(env, 'pet_wish_saved', { amount_usd: rate === null ? 0 : yoctoToUsdMicros(delta, rate) / 1_000_000 });
  }
}

/** One queued row per target, with the ordinary buy journal and unknown-send recovery. */
// spec: add-pet-will › Wish pursuit flow › automatic purchase
// spec: add-pet-will › Wish pursuit flow › purchase after daily reset
export async function queueFundedWish(env: Env, tokenId: string, now: number): Promise<boolean> {
  const wish = await env.DB.prepare("SELECT item, status, owner_generation FROM pet_wishes WHERE token_id = ? AND status IN ('active', 'waiting_day', 'buying')")
    .bind(tokenId).first<{ item: string; status: string; owner_generation: number }>();
  if (wish === null || !isOutfitSlug(wish.item) || !(BOUGHT_IDS as readonly number[]).includes(idOf(wish.item))) return false;
  const pet = await petView(env, tokenId);
  if (pet === null || pet.transfer_generation !== wish.owner_generation || !pet.wish_active) return false;
  if (pet.outfits.includes(idOf(wish.item))) {
    await requestWishRelease(env, tokenId);
    return false;
  }
  if (BigInt(pet.wish_reserve ?? '0') < OUTFIT_PRICE_YOCTO) return false;
  if (wish.status === 'waiting_day') {
    const held = await env.DB.prepare("SELECT settled_at FROM outfit_buys WHERE token_id = ? AND source = 'pet_wish' AND code = 'cap' ORDER BY settled_at DESC LIMIT 1")
      .bind(tokenId).first<{ settled_at: number }>();
    if (held !== null && utcDay(held.settled_at) >= utcDay(now)) return false;
  }
  // Flip first: if the Worker dies before the insert, the next tick can still queue it.
  const claimed = await env.DB.prepare("UPDATE pet_wishes SET status = 'buying' WHERE token_id = ? AND status IN ('active', 'waiting_day', 'buying') RETURNING token_id")
    .bind(tokenId).first();
  if (claimed === null) return false;
  const made = await env.DB.prepare(`INSERT INTO outfit_buys (id, token_id, item, status, price_yocto, created_at, source)
    SELECT ?1, ?2, ?3, 'queued', ?4, ?5, 'pet_wish' WHERE NOT EXISTS
    (SELECT 1 FROM outfit_buys WHERE token_id = ?2 AND status IN ('queued', 'sending', 'unknown')) RETURNING id`)
    .bind(id(), tokenId, wish.item, OUTFIT_PRICE_YOCTO.toString(), now).first();
  if (made === null) return false;
  return true;
}

/** A confirmed owner buy or Cancel requests release. The private target stays until chain confirmation. */
// spec: add-pet-will › Wish pursuit flow › owner cancels
// spec: add-pet-will › Wish pursuit flow › target bought by owner
export async function requestWishRelease(env: Env, tokenId: string, purpose: 'cancel' | 'clear' = 'cancel'): Promise<void> {
  const wish = await env.DB.prepare("SELECT item FROM pet_wishes WHERE token_id = ? AND status <> 'starting'")
    .bind(tokenId).first<{ item: string }>();
  if (wish === null && purpose !== 'clear') return;
  await env.DB.batch([
    env.DB.prepare("UPDATE pet_wishes SET status = 'paused' WHERE token_id = ? AND status <> 'starting'").bind(tokenId),
    env.DB.prepare(`INSERT INTO will_operations (id, token_id, kind, status, item, created_at, purpose)
      SELECT ?1, ?2, 'release', 'queued', ?3, ?4, ?5 WHERE NOT EXISTS
      (SELECT 1 FROM will_operations WHERE token_id = ?2 AND kind = 'release' AND status IN ('queued', 'sending', 'unknown'))`)
      .bind(id(), tokenId, wish?.item ?? null, Date.now(), purpose),
    ...(purpose === 'clear' ? [env.DB.prepare("UPDATE will_operations SET purpose = 'clear' WHERE token_id = ? AND kind = 'release' AND status IN ('queued', 'sending', 'unknown')")
      .bind(tokenId)] : []),
  ]);
}

export async function releaseWishAfterOwnerBuy(env: Env, tokenId: string, item: string): Promise<void> {
  const wish = await env.DB.prepare("SELECT item FROM pet_wishes WHERE token_id = ? AND status <> 'starting'")
    .bind(tokenId).first<{ item: string }>();
  if (wish?.item === item) {
    await requestWishRelease(env, tokenId);
    try { await processWishRelease(env, tokenId); }
    catch { console.log('will_release_deferred'); }
  }
}

/** A hash is authoritative. A lost response never causes a fresh release of the same amount. */
export async function processWishRelease(env: Env, tokenId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT id, status, amount_yocto, tx_hash, signed_bytes, rebroadcast_at, sending_at, created_at
    FROM will_operations WHERE token_id = ? AND kind = 'release' AND status IN ('queued', 'sending', 'unknown')
    ORDER BY created_at LIMIT 1`).bind(tokenId)
    .first<{ id: string; status: string; amount_yocto: string | null; tx_hash: string | null; signed_bytes: ArrayBuffer | null;
      rebroadcast_at: number | null; sending_at: number | null; created_at: number }>();
  if (row === null) return;
  if (row.tx_hash !== null) {
    if (row.status === 'sending') {
      await env.DB.prepare("UPDATE will_operations SET status = 'unknown' WHERE id = ? AND status = 'sending' AND tx_hash = ?")
        .bind(row.id, row.tx_hash).run();
    }
    const outcome = await txStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID);
    if (outcome?.status === 'pending' || outcome === null) {
      const signed = row.signed_bytes === null ? null : decodeSignedTransaction(new Uint8Array(row.signed_bytes));
      if (signed !== null && await transactionExpired(env, signed.transaction.blockHash, row.created_at)) {
        const latest = await txStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID);
        if (latest?.status === 'ok') return finishRelease(env, tokenId, row.id);
        if (latest?.status === 'pending') return;
        await env.DB.prepare("UPDATE will_operations SET status = 'queued', tx_hash = NULL, signed_bytes = NULL WHERE id = ? AND status = 'unknown'")
          .bind(row.id).run();
      } else if (signed !== null && Date.now() - (row.rebroadcast_at ?? row.sending_at ?? row.created_at) >= 60_000) {
        const claim = await env.DB.prepare("UPDATE will_operations SET rebroadcast_at = ? WHERE id = ? AND status = 'unknown' AND (rebroadcast_at IS NULL OR rebroadcast_at <= ?)")
          .bind(Date.now(), row.id, Date.now() - 60_000).run();
        if (claim.meta.changes === 1) await sendSigned(env, signed);
        return;
      } else return;
    } else if (outcome.status === 'ok') return finishRelease(env, tokenId, row.id);
    else return failRelease(env, row.id);
  } else if (row.status === 'sending') {
    if (row.sending_at === null || Date.now() - row.sending_at < 300_000) return;
    await env.DB.prepare("UPDATE will_operations SET status = 'queued' WHERE id = ? AND status = 'sending' AND tx_hash IS NULL")
      .bind(row.id).run();
  } else if (row.status === 'unknown' && row.tx_hash === null) {
    await env.DB.prepare("UPDATE will_operations SET status = 'queued' WHERE id = ? AND status = 'unknown' AND tx_hash IS NULL")
      .bind(row.id).run();
  }
  const pet = await petView(env, tokenId);
  if (pet === null) return;
  const amount = BigInt(pet.wish_reserve ?? '0');
  if (amount === 0n && !pet.wish_active) return finishRelease(env, tokenId, row.id);
  if (await gasIsLow(env, Date.now())) return;
  const claim = await env.DB.prepare("UPDATE will_operations SET status = 'sending', amount_yocto = ?, sending_at = ? WHERE id = ? AND status = 'queued' RETURNING id")
    .bind(amount.toString(), Date.now(), row.id).first();
  if (claim === null) return;
  const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
    methodName: 'will_release', args: { token_id: tokenId, amount: amount.toString() }, gas: RELEASE_GAS,
    writes: { kind: 'will_release', op: row.id },
  });
  if (answer.status === 'ok') await finishRelease(env, tokenId, row.id);
  else if (answer.status === 'failed') await failRelease(env, row.id);
  else await env.DB.prepare("UPDATE will_operations SET status = ?, tx_hash = COALESCE(tx_hash, ?) WHERE id = ?")
    .bind(answer.status === 'unreachable' ? 'queued' : 'unknown', 'txHash' in answer ? answer.txHash : null, row.id).run();
}

async function finishRelease(env: Env, tokenId: string, op: string): Promise<void> {
  const pet = await petView(env, tokenId);
  if (pet === null) return;
  const [wish, operation] = await Promise.all([
    env.DB.prepare("SELECT item FROM pet_wishes WHERE token_id = ?").bind(tokenId).first<{ item: string }>(),
    env.DB.prepare('SELECT purpose FROM will_operations WHERE id = ?').bind(op).first<{ purpose: string }>(),
  ]);
  const rest = BigInt(pet.wish_reserve ?? '0');
  const written = await env.DB.batch([
    env.DB.prepare("UPDATE will_operations SET status = 'confirmed', settled_at = ? WHERE id = ? AND status IN ('queued', 'sending', 'unknown')")
      .bind(Date.now(), op),
    ...(rest === 0n && operation?.purpose !== 'clear' ? [env.DB.prepare("DELETE FROM pet_wishes WHERE token_id = ? AND status = 'paused'").bind(tokenId)] : []),
  ]);
  if (written[0]?.meta.changes !== 1) return;
  if (rest > 0n) await requestWishRelease(env, tokenId);
  else if (operation?.purpose !== 'clear' && wish !== null && isOutfitSlug(wish.item) && !pet.outfits.includes(idOf(wish.item))) {
    track('pet_wish_canceled');
    await recordWillEvent(env, 'pet_wish_canceled', { id: op });
  }
}

async function failRelease(env: Env, op: string): Promise<void> {
  await env.DB.prepare("UPDATE will_operations SET status = 'failed', settled_at = ? WHERE id = ? AND status IN ('queued', 'sending', 'unknown')")
    .bind(Date.now(), op).run();
}
