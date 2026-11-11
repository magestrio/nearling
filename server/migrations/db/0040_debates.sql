-- Invitations and published transcripts. Share codes never appear in a URL or log.
CREATE TABLE debates (
  id TEXT PRIMARY KEY,
  first_pet TEXT NOT NULL,
  second_pet TEXT NOT NULL,
  first_owner TEXT NOT NULL,
  second_owner TEXT NOT NULL,
  first_generation INTEGER NOT NULL,
  second_generation INTEGER NOT NULL,
  first_epoch INTEGER NOT NULL,
  second_epoch INTEGER NOT NULL,
  acquaintance TEXT NOT NULL CHECK (acquaintance IN ('first_fed', 'second_fed', 'hire')),
  opener_pet TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'accepted', 'running', 'completed', 'declined', 'expired', 'gift', 'cleared', 'stopped', 'refused', 'unavailable')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  ended_at INTEGER,
  share_code TEXT NOT NULL,
  share_hash TEXT NOT NULL UNIQUE,
  lease_until INTEGER,
  CHECK (first_pet <> second_pet),
  CHECK (first_owner <> second_owner),
  CHECK (opener_pet IN (first_pet, second_pet))
);
CREATE INDEX debates_by_first_pet ON debates (first_pet, created_at);
CREATE INDEX debates_by_second_pet ON debates (second_pet, created_at);

-- End-state only. Expired or gifted invitations lose their topic, code and consent rows,
-- while a current owner can still see why the invitation ended.
CREATE TABLE debate_ended_invites (
  id TEXT PRIMARY KEY,
  first_pet TEXT NOT NULL,
  second_pet TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('declined', 'expired', 'gift', 'cleared')),
  ended_at INTEGER NOT NULL
);

CREATE TABLE debate_consents (
  debate_id TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  pet_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'declined')),
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (debate_id, pet_id)
);

CREATE TABLE debate_started_days (
  pet_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  -- A memory clear removes the words and the debate row, but a started-day claim remains
  -- until the following reset so an unpaid in-flight call cannot permit a second start.
  debate_id TEXT NOT NULL,
  PRIMARY KEY (pet_id, day)
);

CREATE TABLE debate_lines (
  debate_id TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  line_order INTEGER NOT NULL CHECK (line_order BETWEEN 1 AND 4),
  speaker_pet TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'receipt_pending', 'settled', 'unavailable')),
  text TEXT,
  request_bytes TEXT,
  response_bytes TEXT,
  signed_call TEXT,
  receipt_tx_hash TEXT,
  price_yocto TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  PRIMARY KEY (debate_id, line_order)
);

CREATE TABLE debate_debit_operations (
  debate_id TEXT NOT NULL,
  line_order INTEGER NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  tx_hash TEXT,
  signed_tx TEXT,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'sending', 'unknown', 'accepted', 'rejected')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (debate_id, line_order),
  FOREIGN KEY (debate_id, line_order) REFERENCES debate_lines(debate_id, line_order) ON DELETE CASCADE
);
