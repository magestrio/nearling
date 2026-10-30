-- add-pet: the pet's server-side records (design.md › Worker). The contract holds the pet, its owner
-- and its food; these tables hold what the chain does not: the conversation, the unbilled thoughts,
-- the sessions waiting to be debited, the project's own costs and the service pause.

CREATE TABLE pets (
  token_id   TEXT PRIMARY KEY,
  hatched_by TEXT NOT NULL,
  born_at    INTEGER NOT NULL,
  birth_tx   TEXT NOT NULL,
  -- When the server saw the pet fall asleep; cleared when it is woken (wakeIfFed).
  slept_at   INTEGER,
  -- The UTC day (days since the epoch) of the last diary entry written for the pet.
  diary_day  INTEGER,
  -- The UTC day to the end of which the pet is «tired» (the daily cap), see design.md › Решения.
  tired_day  INTEGER
);

CREATE TABLE thoughts (
  id               TEXT PRIMARY KEY,
  token_id         TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  -- reply | deep | greeting | wake | diary
  kind             TEXT NOT NULL,
  player_text      TEXT,
  reply_text       TEXT,
  model            TEXT NOT NULL,
  price_yocto      TEXT NOT NULL,
  price_usd_micros INTEGER NOT NULL,
  -- fuse | food | cap
  cut              TEXT,
  reasked          INTEGER NOT NULL DEFAULT 0,
  -- pet | project
  payer            TEXT NOT NULL,
  session_id       TEXT,
  -- unbilled | billed | project
  status           TEXT NOT NULL
);
CREATE INDEX thoughts_by_pet ON thoughts (token_id, created_at);
CREATE INDEX thoughts_by_session ON thoughts (session_id);

CREATE TABLE thought_calls (
  thought_id        TEXT NOT NULL,
  n                 INTEGER NOT NULL,
  req_bytes         BLOB NOT NULL,
  res_bytes         BLOB NOT NULL,
  req_sha256        TEXT NOT NULL,
  res_sha256        TEXT NOT NULL,
  signature         TEXT NOT NULL,
  sig_kind          TEXT NOT NULL,
  signer            TEXT NOT NULL,
  completion_id     TEXT NOT NULL,
  tokens_in         INTEGER NOT NULL,
  tokens_out        INTEGER NOT NULL,
  tokens_reasoning  INTEGER NOT NULL,
  cut               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thought_id, n)
);

CREATE TABLE memory_notes (
  token_id TEXT NOT NULL,
  kind     TEXT NOT NULL,
  name     TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX memory_notes_by_pet ON memory_notes (token_id, at);

CREATE TABLE debit_sessions (
  id        TEXT PRIMARY KEY,
  token_id  TEXT NOT NULL,
  day       INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  last_at   INTEGER NOT NULL,
  -- open | sending | done | rejected
  status    TEXT NOT NULL,
  debit_id  INTEGER,
  tx_hash   TEXT
);
CREATE INDEX debit_sessions_by_pet ON debit_sessions (token_id, status);

CREATE TABLE pet_spend (
  token_id      TEXT PRIMARY KEY,
  reserve_yocto TEXT NOT NULL,
  job_id        TEXT
);

-- Empty answers of a pet in a UTC day: written atomically with INSERT .. ON CONFLICT .. RETURNING n.
CREATE TABLE empty_answers (
  token_id TEXT NOT NULL,
  day      INTEGER NOT NULL,
  n        INTEGER NOT NULL,
  PRIMARY KEY (token_id, day)
);

CREATE TABLE jobs (
  id         TEXT PRIMARY KEY,
  token_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  mode       TEXT,
  -- What the job needs to run (the player's line, the friend's name); cleared when it is done.
  payload    TEXT,
  -- queued | running | done | failed
  status     TEXT NOT NULL,
  -- The outcome (a thought id, or a code); never the text of a line.
  result     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX jobs_by_pet ON jobs (token_id, created_at);

-- What the project pays out of its own pocket, one row per event, in USD micro-dollars.
-- kind: starter_food | storage | no_thought | rejected_batch | gas | edge
CREATE TABLE project_spend (
  at         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  usd_micros INTEGER NOT NULL
);

-- One row (id = 1) while the services are paused. reason: gas | ai.
CREATE TABLE service_pause (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  reason     TEXT,
  since      INTEGER,
  last_probe INTEGER
);

-- A birth in flight for an account: the second tap does not mint a second pet.
CREATE TABLE births_in_flight (
  account    TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL
);
