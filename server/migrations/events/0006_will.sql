-- Coded outcomes only. No words, account ids, token ids, or recipient identities.
CREATE TABLE will_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL CHECK (at >= 0),
  name TEXT NOT NULL CHECK (name IN ('pet_wish_chosen', 'pet_wish_saved', 'pet_wish_canceled',
    'outfit_bought', 'pet_work_invited', 'pet_work_invitation_accepted', 'pet_hire_refused')),
  amount_usd REAL CHECK (amount_usd >= 0),
  via TEXT CHECK (via = 'pet_wish'),
  reason TEXT CHECK (reason = 'character'),
  by_kind TEXT CHECK (by_kind IN ('player', 'pet')),
  project_usd REAL CHECK (project_usd >= 0),
  tab_id TEXT,
  player_id TEXT,
  pet_id TEXT,
  CHECK (
    (name = 'pet_wish_saved' AND amount_usd IS NOT NULL AND via IS NULL AND reason IS NULL AND by_kind IS NULL AND project_usd IS NULL)
    OR (name = 'outfit_bought' AND via = 'pet_wish' AND amount_usd IS NULL AND reason IS NULL AND by_kind IS NULL AND project_usd IS NULL)
    OR (name = 'pet_hire_refused' AND reason = 'character' AND by_kind IS NOT NULL AND project_usd IS NOT NULL AND amount_usd IS NULL AND via IS NULL)
    OR (name IN ('pet_wish_chosen', 'pet_wish_canceled', 'pet_work_invited', 'pet_work_invitation_accepted')
      AND amount_usd IS NULL AND via IS NULL AND reason IS NULL AND by_kind IS NULL AND project_usd IS NULL)
  )
);
