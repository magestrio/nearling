// The Manual offer as a row (`Pet hire flow`, §8 › Предложение найма): read where the owner's page and routes need it.
// It has no dependency on the spend path, so the owner's view can read it.

export interface Offer {
  turnId: string;
  workerId: string;
  /** The worker's name when it was offered. */
  worker: string;
  question: string;
  price: bigint;
  discounted: boolean;
}

interface OfferRow {
  turn_id: string;
  worker_id: string;
  worker_name: string;
  question: string;
  price_yocto: string;
  discounted: number;
}

/** The offer standing, or none. An offer whose hirer fell asleep is deleted where it is read: an asleep pet reads no
 * turn and nothing is spent; its words stay in the conversation (`Pet hire flow` › «offer goes stale»). */
export async function readOffer(db: D1Database, tokenId: string, hirerAsleep: boolean): Promise<Offer | null> {
  const row = await db.prepare('SELECT turn_id, worker_id, worker_name, question, price_yocto, discounted FROM hire_offers WHERE token_id = ?').bind(tokenId).first<OfferRow>();
  if (row === null) return null;
  if (hirerAsleep) {
    await db.prepare('DELETE FROM hire_offers WHERE token_id = ?').bind(tokenId).run();
    return null;
  }
  return { turnId: row.turn_id, workerId: row.worker_id, worker: row.worker_name, question: row.question, price: BigInt(row.price_yocto), discounted: row.discounted === 1 };
}
