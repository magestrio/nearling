-- A definitive reveal refusal stays visible to the operator and is not resent each minute.
ALTER TABLE riddles ADD COLUMN reveal_refused_at INTEGER;
