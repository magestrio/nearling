-- add-gift: one live bearer link per token. Replacing a cancelled or transferred row
-- changes its code, so a former link cannot become live again.
CREATE TABLE gift_links (
  token_id          TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  giver_account     TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('waiting', 'accepted', 'transferred', 'cancelled')),
  accepted_account  TEXT,
  accepted_name     TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  accepted_at       INTEGER,
  transferred_at    INTEGER
);

-- The transfer flight is written by the next server stage before RPC broadcast.
CREATE TABLE gift_flights (
  token_id       TEXT PRIMARY KEY,
  code           TEXT NOT NULL,
  sender         TEXT NOT NULL,
  receiver       TEXT NOT NULL,
  tx_hash        TEXT NOT NULL,
  signed_bytes   BLOB NOT NULL,
  state          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER
);

ALTER TABLE players ADD COLUMN current_pet TEXT;
ALTER TABLE players ADD COLUMN last_gifted_pet TEXT;
ALTER TABLE players ADD COLUMN gift_topup_at INTEGER;
ALTER TABLE players ADD COLUMN gift_topup_flight TEXT;
ALTER TABLE pets ADD COLUMN last_gift_block_at INTEGER;

-- The public gift page repeats the amount the sender saw, even before the desk reserves food.
ALTER TABLE errands ADD COLUMN display_max_yocto TEXT;
ALTER TABLE errands ADD COLUMN display_max_cents REAL;
