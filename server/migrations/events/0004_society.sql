-- Coded playtest outcomes only. No words, names, account ids or token ids.
ALTER TABLE experience_events ADD COLUMN discounted INTEGER CHECK (discounted IN (0, 1));

CREATE TABLE society_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL CHECK (at >= 0),
  name TEXT NOT NULL CHECK (name IN ('pet_relationship_changed', 'pet_hire_refused', 'society_diary_seen')),
  cause TEXT CHECK (cause IN ('paid_help', 'rude')),
  state TEXT CHECK (state IN ('neutral', 'liked', 'strained')),
  by_kind TEXT CHECK (by_kind IN ('player', 'pet')),
  reason TEXT CHECK (reason = 'relationship'),
  tab_id TEXT,
  player_id TEXT,
  pet_id TEXT,
  CHECK ((name = 'pet_relationship_changed' AND cause IS NOT NULL AND state IS NOT NULL AND by_kind IS NULL AND reason IS NULL)
    OR (name = 'pet_hire_refused' AND cause IS NULL AND state IS NULL AND by_kind IS NOT NULL AND reason IS NOT NULL)
    OR (name = 'society_diary_seen' AND cause IS NULL AND state IS NULL AND by_kind IS NULL AND reason IS NULL))
);
