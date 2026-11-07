-- A pending paid answer cannot restore either pet's social memory after Clear memory.
ALTER TABLE hires ADD COLUMN society_payer_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hires ADD COLUMN society_worker_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hires ADD COLUMN society_discounted INTEGER NOT NULL DEFAULT 0 CHECK (society_discounted IN (0, 1));
ALTER TABLE society_encounters ADD COLUMN used_day INTEGER;
ALTER TABLE society_encounters ADD COLUMN state TEXT CHECK (state IN ('neutral', 'liked', 'strained'));
ALTER TABLE society_encounters ADD COLUMN event_recorded INTEGER NOT NULL DEFAULT 0 CHECK (event_recorded IN (0, 1));
ALTER TABLE society_diary_lines ADD COLUMN hire_id TEXT;
ALTER TABLE society_relations ADD COLUMN last_hire_id TEXT;
ALTER TABLE society_relations ADD COLUMN last_kind TEXT CHECK (last_kind IN ('bond', 'quarrel', 'reconcile', 'help'));
