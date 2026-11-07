-- add-pet-experience: a signed paid report can stage one private note. Debit acceptance activates it.
ALTER TABLE thoughts ADD COLUMN completed_errand INTEGER NOT NULL DEFAULT 0 CHECK (completed_errand IN (0, 1));
CREATE TABLE experience_notes (
  source_thought_id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  note_text TEXT NOT NULL CHECK (length(note_text) BETWEEN 1 AND 160),
  proposed_field TEXT NOT NULL CHECK (length(proposed_field) > 0),
  source_report_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  memory_epoch INTEGER NOT NULL,
  owner_account TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'active')),
  approved_generation INTEGER,
  FOREIGN KEY (source_thought_id) REFERENCES thoughts(id)
);
CREATE INDEX experience_notes_by_pet ON experience_notes (token_id, status, created_at DESC, source_thought_id DESC);

CREATE TABLE experience_field (
  token_id TEXT PRIMARY KEY,
  source_thought_id TEXT NOT NULL,
  wording TEXT NOT NULL,
  publisher TEXT NOT NULL,
  published_generation INTEGER NOT NULL
);
