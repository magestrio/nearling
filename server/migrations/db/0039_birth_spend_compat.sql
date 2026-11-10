-- Rows written by the new Worker before this migration used both keys. Keep the
-- first birth's account key as the legacy guard; repeats use only the token key.
UPDATE project_spend SET birth_account = NULL
WHERE birth_account IS NOT NULL AND birth_token_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM project_spend earlier
    WHERE earlier.birth_account = project_spend.birth_account
      AND earlier.kind = project_spend.kind
      AND earlier.rowid < project_spend.rowid
  );

-- An old Worker may already have retried in the window after 0038. Remove its
-- later duplicate rows before restoring the account guard.
DELETE FROM project_spend
WHERE birth_account IS NOT NULL AND rowid NOT IN (
  SELECT MIN(rowid) FROM project_spend
  WHERE birth_account IS NOT NULL GROUP BY birth_account, kind
);

-- Old Workers write birth costs with birth_account and no token. Keep their
-- account uniqueness guard through a forward deploy or Worker rollback.
CREATE UNIQUE INDEX project_spend_birth_once
ON project_spend (birth_account, kind)
WHERE birth_account IS NOT NULL;

-- A failed included mint has no token. Its gas is keyed by its transaction hash.
ALTER TABLE project_spend ADD COLUMN birth_tx_hash TEXT;
CREATE UNIQUE INDEX project_spend_failed_birth_gas_once
ON project_spend (birth_tx_hash) WHERE birth_tx_hash IS NOT NULL;
