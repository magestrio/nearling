-- The Worker seeds this row from showcasePolicy.json in the same transaction as issuance or
-- redemption. Without a row, both triggers fail closed. This replaces the applied literal guards.
CREATE TABLE judge_admission_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  code_limit INTEGER NOT NULL,
  uses_per_code INTEGER NOT NULL,
  admitted_limit INTEGER NOT NULL,
  counted_limit INTEGER NOT NULL
);

DROP TRIGGER judge_code_limit;
CREATE TRIGGER judge_code_limit BEFORE INSERT ON judge_codes
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM judge_codes) >=
    COALESCE((SELECT code_limit FROM judge_admission_policy WHERE id = 1), 0)
    THEN RAISE(ABORT, 'judge_issue_limit') END;
END;

DROP TRIGGER judge_redeem_guard;
CREATE TRIGGER judge_redeem_guard BEFORE INSERT ON judge_redemptions
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM judge_codes WHERE hash = NEW.code_hash)
    THEN RAISE(ABORT, 'judge_invalid') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM judge_codes WHERE hash = NEW.code_hash AND expires_at <= NEW.redeemed_at)
    THEN RAISE(ABORT, 'judge_expired') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM judge_redemptions WHERE code_hash = NEW.code_hash) >=
    COALESCE((SELECT uses_per_code FROM judge_admission_policy WHERE id = 1), 0)
    THEN RAISE(ABORT, 'judge_exhausted') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM players WHERE month = NEW.month) >=
    COALESCE((SELECT admitted_limit FROM judge_admission_policy WHERE id = 1), 0)
    THEN RAISE(ABORT, 'judge_admission_full') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM players WHERE month = NEW.month) +
    (SELECT COUNT(*) FROM sign_in_refusals WHERE month = NEW.month) >=
    COALESCE((SELECT counted_limit FROM judge_admission_policy WHERE id = 1), 0)
    THEN RAISE(ABORT, 'judge_ceiling') END;
END;
