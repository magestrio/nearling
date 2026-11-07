-- Code-only experience outcomes. No account, token, note, field or report column exists.
CREATE TABLE experience_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL CHECK (at >= 0),
  name TEXT NOT NULL CHECK (name IN ('experience_note_saved', 'experience_note_approved',
    'experience_field_published', 'experience_record_opened', 'pet_hired')),
  approved INTEGER CHECK (approved IN (0, 1)),
  experience INTEGER CHECK (experience IN (0, 1)),
  tab_id TEXT,
  player_id TEXT,
  pet_id TEXT,
  CHECK ((name = 'experience_note_approved' AND approved IS NOT NULL AND experience IS NULL)
    OR (name = 'pet_hired' AND experience IS NOT NULL AND approved IS NULL)
    OR (name NOT IN ('experience_note_approved', 'pet_hired') AND approved IS NULL AND experience IS NULL))
);
