-- Keep the contract's refusal reason with a project-settled thought so its existing
-- receipt read can distinguish an unfunded first experience count from ordinary failures.
ALTER TABLE thoughts ADD COLUMN debit_refusal_code TEXT;
