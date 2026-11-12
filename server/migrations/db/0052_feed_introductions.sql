-- Social introductions follow a confirmed friend's feed without holding up its outcome.
CREATE TABLE feed_introductions (
  feed_id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  token_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- A started screening is returned at most once even when a failed call is retried.
CREATE TABLE will_screening_refunds (id TEXT PRIMARY KEY, day INTEGER NOT NULL);
