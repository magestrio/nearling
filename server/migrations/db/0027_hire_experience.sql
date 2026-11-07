-- Snapshot whether the accepted hire's worker call actually used an approved note.
ALTER TABLE hires ADD COLUMN experience INTEGER NOT NULL DEFAULT 0 CHECK (experience IN (0, 1));

-- The note-bearing request is private even when the worker has no separate skill.
CREATE TRIGGER experience_hire_private AFTER INSERT ON hires WHEN NEW.experience = 1 BEGIN
  UPDATE thoughts SET link_eligible = 0 WHERE id = NEW.answer_thought_id;
END;
