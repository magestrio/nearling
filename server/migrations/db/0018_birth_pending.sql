-- Keep the signed birth hash through an unknown outcome and a Worker restart.
ALTER TABLE births_in_flight ADD COLUMN tx_hash TEXT;

-- A recovered birth can be finalized by a read and by the original POST at the same time.
-- Each of its two costs is recorded once, keyed by the account that hatched it.
ALTER TABLE project_spend ADD COLUMN birth_account TEXT;
CREATE UNIQUE INDEX project_spend_birth_once ON project_spend (birth_account, kind) WHERE birth_account IS NOT NULL;
