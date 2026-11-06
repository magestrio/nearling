-- Rotate bounded shared-job retry scans past older links that remain blocked.
CREATE TABLE shared_retry_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at INTEGER NOT NULL,
  token_id TEXT NOT NULL
);
INSERT INTO shared_retry_cursor (id, updated_at, token_id) VALUES (1, 0, '');
