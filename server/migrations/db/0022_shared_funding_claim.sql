-- Keep the active job hash with an in-flight feeding until its chain event has
-- been copied into shared_errand_contributions in the same D1 batch as deletion.
ALTER TABLE feedings ADD COLUMN job_hash TEXT;
CREATE INDEX feedings_by_shared_job ON feedings (token_id, job_hash);
ALTER TABLE shared_errand_contributions ADD COLUMN funding_index INTEGER;
CREATE UNIQUE INDEX shared_contributions_by_index ON shared_errand_contributions (job_hash, funding_index);
-- Public chain evidence survives erasure of contributor access and job words.
CREATE TABLE shared_funding_evidence (
  job_hash TEXT NOT NULL,
  funding_index INTEGER NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  token_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('near', 'snack')),
  amount_yocto TEXT NOT NULL,
  spent_yocto TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (job_hash, funding_index)
);
CREATE INDEX shared_funding_evidence_by_token ON shared_funding_evidence (token_id, job_hash);
ALTER TABLE errands ADD COLUMN shared_job_hash TEXT;
ALTER TABLE thoughts ADD COLUMN shared_job_hash TEXT;
ALTER TABLE debit_sessions ADD COLUMN shared_job_hash TEXT;
CREATE UNIQUE INDEX debit_session_by_shared_job ON debit_sessions (shared_job_hash) WHERE shared_job_hash IS NOT NULL;
