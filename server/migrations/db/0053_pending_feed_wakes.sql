-- A confirmed friend's feed can be settled before a lagging pet view shows its food.
-- Keep only the attribution needed by the owner's next state poll.
CREATE TABLE pending_feed_wakes (
  token_id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
