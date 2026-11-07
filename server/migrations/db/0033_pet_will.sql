-- Private will state. The contract holds only the public reserve and active flag.
CREATE TABLE pet_wishes (
  token_id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 160),
  status TEXT NOT NULL CHECK (status IN ('starting', 'active', 'paused', 'buying', 'waiting_day')),
  owner_generation INTEGER NOT NULL,
  memory_epoch INTEGER NOT NULL,
  diary_day INTEGER NOT NULL,
  start_op TEXT NOT NULL UNIQUE,
  start_tx_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE will_diary_lines (
  token_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  line TEXT NOT NULL CHECK (length(line) BETWEEN 1 AND 240),
  memory_epoch INTEGER NOT NULL,
  PRIMARY KEY (token_id, day)
);

CREATE TABLE work_invitations (
  id TEXT PRIMARY KEY,
  sender_token TEXT NOT NULL,
  recipient_token TEXT NOT NULL,
  day INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sender_generation INTEGER NOT NULL,
  recipient_generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'accepted', 'expired')),
  UNIQUE (sender_token, day)
);
CREATE INDEX work_invitations_recipient ON work_invitations (recipient_token, status, created_at DESC);

CREATE TABLE will_screenings (
  worker_token TEXT NOT NULL,
  day INTEGER NOT NULL,
  started INTEGER NOT NULL DEFAULT 0 CHECK (started BETWEEN 0 AND 3),
  PRIMARY KEY (worker_token, day)
);
CREATE TABLE will_refusals (
  id TEXT PRIMARY KEY,
  payer_token TEXT NOT NULL,
  worker_token TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  signed_bytes BLOB NOT NULL,
  worker_code TEXT NOT NULL CHECK (worker_code = 'character'),
  created_at INTEGER NOT NULL
);
CREATE INDEX will_refusals_payer ON will_refusals (payer_token, created_at DESC);
CREATE INDEX will_refusals_worker ON will_refusals (worker_token, created_at DESC);

CREATE TABLE will_operations (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'release', 'buy')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'unknown', 'confirmed', 'failed', 'waiting_day')),
  tx_hash TEXT,
  signed_bytes BLOB,
  rebroadcast_at INTEGER,
  amount_yocto TEXT,
  item TEXT,
  created_at INTEGER NOT NULL,
  sending_at INTEGER,
  settled_at INTEGER
);
CREATE INDEX will_operations_open ON will_operations (status, created_at);

ALTER TABLE outfit_buys ADD COLUMN source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'pet_wish'));
