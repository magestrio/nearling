-- Repeat-birth and board intent signals. Only opaque identities and coded properties.
CREATE TABLE hatch_again_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (name IN ('pet_born', 'hire_board_opened', 'hire_board_pet_opened')),
  tab_id TEXT,
  player_id TEXT,
  pet_id TEXT,
  device TEXT CHECK (device IN ('desktop', 'phone')),
  repeat INTEGER CHECK (repeat IN (0, 1)),
  has_owned_pet INTEGER CHECK (has_owned_pet IN (0, 1)),
  CHECK ((name = 'pet_born' AND pet_id IS NOT NULL AND repeat IS NOT NULL AND device IS NULL AND has_owned_pet IS NULL)
    OR (name = 'hire_board_opened' AND tab_id IS NOT NULL AND pet_id IS NULL AND device IS NOT NULL AND repeat IS NULL)
    OR (name = 'hire_board_pet_opened' AND tab_id IS NOT NULL AND pet_id IS NOT NULL AND device IS NOT NULL AND repeat IS NULL))
);
