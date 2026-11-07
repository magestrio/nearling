-- Private, directed society memory. No player account, hire words or public event is stored here.
CREATE TABLE society_relations (
  token_id TEXT NOT NULL,
  other_id TEXT NOT NULL,
  stance TEXT NOT NULL DEFAULT 'neutral' CHECK (stance IN ('neutral', 'liked', 'strained')),
  good_days INTEGER NOT NULL DEFAULT 0 CHECK (good_days BETWEEN 0 AND 2),
  rude_days INTEGER NOT NULL DEFAULT 0 CHECK (rude_days BETWEEN 0 AND 2),
  last_move_day INTEGER,
  break_until INTEGER,
  last_settled_day INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, other_id),
  CHECK (token_id <> other_id)
);
CREATE INDEX society_relations_by_pet ON society_relations (token_id, stance, created_at);

-- Remove an existing row before admitting a 33rd. This runs within the inserting statement's
-- transaction, including when two Worker requests introduce different pairs concurrently.
CREATE TRIGGER society_relation_bound BEFORE INSERT ON society_relations
WHEN (SELECT COUNT(*) FROM society_relations WHERE token_id = NEW.token_id) >= 32
  AND NOT EXISTS (SELECT 1 FROM society_relations WHERE token_id = NEW.token_id AND other_id = NEW.other_id)
BEGIN
  DELETE FROM society_relations WHERE rowid = (
    SELECT rowid FROM society_relations WHERE token_id = NEW.token_id
    ORDER BY CASE WHEN stance = 'neutral' THEN 0 ELSE 1 END, created_at, rowid LIMIT 1
  );
END;

-- The attempt key makes each batch's writes conditional on its own newly claimed hire id.
CREATE TABLE society_processed_hires (
  hire_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  settled_at INTEGER NOT NULL
);

-- A settled code has no question, answer or player name. The later diary stage supplies the public
-- name from the pet view and writes only up to three private lines per pet and UTC day.
CREATE TABLE society_encounters (
  hire_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  other_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bond', 'quarrel', 'reconcile', 'help')),
  PRIMARY KEY (hire_id, token_id)
);
CREATE INDEX society_encounters_by_pet_day ON society_encounters (token_id, day);

CREATE TABLE society_diary_lines (
  token_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  line TEXT NOT NULL,
  PRIMARY KEY (token_id, day, slot)
);
