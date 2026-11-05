-- Showcase's one completed card-delivery event. No image, words, name, account or token id.
-- ADR-019 keeps event scans without a secondary index; the minute cron erases these rows on Dec 1.
CREATE TABLE showcase_card_shared (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL CHECK (at >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('thought', 'growth', 'outfit')),
  delivery TEXT NOT NULL CHECK (delivery IN ('save', 'share')),
  tab_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  pet_id TEXT NOT NULL
);
