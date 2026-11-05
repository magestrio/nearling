-- Word-free signed close intent survives the memory deletion of a running shared job.
-- Errands U2/U3 fill and settle it; this expand-only table must exist first.
CREATE TABLE shared_job_close_recovery (
  token_id    TEXT NOT NULL,
  job_hash    TEXT NOT NULL,
  approval    BLOB NOT NULL,
  close_state TEXT NOT NULL CHECK (close_state IN ('pending', 'unknown', 'confirmed')),
  retry_at    INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, job_hash)
);
