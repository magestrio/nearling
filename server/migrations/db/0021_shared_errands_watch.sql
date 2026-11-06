-- Shared errands keep their public words in D1; only a random hash and funding live on chain.
-- A link code is never stored in plaintext. The close-recovery row from 0016 stays word-free.
CREATE TABLE shared_errands (
  token_id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  job_hash TEXT NOT NULL UNIQUE,
  owner_account TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  memory_epoch INTEGER NOT NULL,
  form TEXT NOT NULL CHECK (form IN ('find', 'check')),
  job TEXT NOT NULL,
  allowance_yocto TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('opening', 'funding', 'running', 'reported', 'failed', 'closed')),
  report TEXT,
  sources TEXT,
  receipt_id TEXT,
  open_tx_hash TEXT,
  open_signed_bytes BLOB,
  open_rebroadcast_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX shared_errands_by_state ON shared_errands (state, updated_at);

CREATE TABLE shared_errand_contributions (
  tx_hash TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  job_hash TEXT NOT NULL,
  contributor_account TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('near', 'snack')),
  amount_yocto TEXT NOT NULL,
  spent_yocto TEXT NOT NULL DEFAULT '0',
  confirmed_at INTEGER NOT NULL,
  FOREIGN KEY (token_id) REFERENCES shared_errands(token_id) ON DELETE CASCADE
);
CREATE INDEX shared_contributions_by_job ON shared_errand_contributions (job_hash, confirmed_at);
CREATE INDEX shared_contributions_by_account ON shared_errand_contributions (token_id, contributor_account);

-- A word erasure that deletes the link deletes sponsor access in the same SQL statement.
CREATE TRIGGER shared_errand_erase AFTER DELETE ON shared_errands BEGIN
  DELETE FROM shared_errand_contributions WHERE token_id = OLD.token_id;
END;

CREATE TABLE watch_targets (
  token_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('topic', 'release', 'account', 'page')),
  target TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  saved_hour_utc INTEGER NOT NULL CHECK (saved_hour_utc BETWEEN 0 AND 23),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  owner_generation INTEGER NOT NULL,
  last_started_day INTEGER,
  latest_result TEXT,
  latest_price_yocto TEXT,
  latest_receipt_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX watch_targets_due ON watch_targets (paused, saved_hour_utc, last_started_day);

CREATE TABLE watch_observations (
  token_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  named_content TEXT NOT NULL,
  source_urls TEXT NOT NULL,
  observed_day INTEGER NOT NULL,
  FOREIGN KEY (token_id) REFERENCES watch_targets(token_id) ON DELETE CASCADE
);
CREATE TRIGGER watch_target_erase AFTER DELETE ON watch_targets BEGIN
  DELETE FROM watch_observations WHERE token_id = OLD.token_id;
END;

-- A paid check keeps its receipt pointer after Stop watch; it carries no target words.
CREATE TABLE watch_checks (
  token_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'paid', 'failed', 'skipped')),
  price_yocto TEXT,
  receipt_id TEXT,
  changed INTEGER NOT NULL DEFAULT 0 CHECK (changed IN (0, 1)),
  started_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, day)
);
CREATE INDEX watch_checks_by_status ON watch_checks (status, started_at);
