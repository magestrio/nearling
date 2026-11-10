-- Repeat hatches keep the prior birth separately from the new transaction.
ALTER TABLE births_in_flight ADD COLUMN prior_token_id TEXT;
ALTER TABLE births_in_flight ADD COLUMN reserved_usd_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE births_in_flight ADD COLUMN birth_rate_usd_micros INTEGER;

-- The old uniqueness key was the account, so it could record only one birth's costs.
ALTER TABLE project_spend ADD COLUMN birth_token_id TEXT;
UPDATE project_spend
SET birth_token_id = (
  SELECT token_id FROM pets WHERE pets.hatched_by = project_spend.birth_account
  ORDER BY pets.born_at DESC, pets.token_id DESC LIMIT 1
)
WHERE birth_account IS NOT NULL AND kind IN ('starter_food', 'storage');
DROP INDEX project_spend_birth_once;
CREATE UNIQUE INDEX project_spend_birth_token_once
ON project_spend (birth_token_id, kind) WHERE birth_token_id IS NOT NULL;

-- Private navigation pointers; no player words or pet memory.
CREATE TABLE known_pets (
  account_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('gift', 'feed', 'paid_advice')),
  interacted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, token_id)
);
CREATE INDEX known_pets_by_account ON known_pets (account_id, interacted_at DESC);
