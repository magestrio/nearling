// A named observation may become the baseline only after the day's paid receipt exists.
import type { NamedObservation } from './source';

export async function storePaidObservation(db: D1Database, tokenId: string, day: number, revision: number, observation: NamedObservation): Promise<boolean> {
  const [target, baseline] = await db.batch([
    db.prepare(`UPDATE watch_targets SET latest_receipt_id = c.receipt_id,
      latest_price_yocto = c.price_yocto
      FROM watch_checks c
      WHERE watch_targets.token_id = ? AND watch_targets.revision = ?
        AND c.token_id = watch_targets.token_id AND c.day = ? AND c.revision = ?
        AND c.status = 'paid' AND c.receipt_id IS NOT NULL`).bind(tokenId, revision, day, revision),
    db.prepare(`INSERT INTO watch_observations (token_id, revision, named_content, source_urls, observed_day)
      SELECT w.token_id, w.revision, ?, ?, ? FROM watch_targets w
      JOIN watch_checks c ON c.token_id = w.token_id AND c.day = ? AND c.revision = w.revision
      WHERE w.token_id = ? AND w.revision = ? AND c.status = 'paid' AND c.receipt_id IS NOT NULL
      ON CONFLICT(token_id) DO UPDATE SET revision = excluded.revision, named_content = excluded.named_content,
        source_urls = excluded.source_urls, observed_day = excluded.observed_day`)
      .bind(observation.namedContent, JSON.stringify(observation.sourceUrls), day, day, tokenId, revision),
  ]);
  return target.meta.changes === 1 && baseline.meta.changes === 1;
}
