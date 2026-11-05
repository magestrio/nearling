-- A birth can be rebroadcast with exactly its original signature until its reference block expires.
-- The flight survives the item-send journal's retention and remembers a terminal failed outcome.
ALTER TABLE births_in_flight ADD COLUMN signed_bytes BLOB;
ALTER TABLE births_in_flight ADD COLUMN rebroadcast_at INTEGER;
ALTER TABLE births_in_flight ADD COLUMN failed INTEGER NOT NULL DEFAULT 0;
