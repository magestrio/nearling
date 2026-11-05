-- Private judge admission. The plaintext bearer codes never enter D1.
CREATE TABLE judge_codes (
  hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TRIGGER judge_code_limit BEFORE INSERT ON judge_codes
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM judge_codes) >= 10 THEN RAISE(ABORT, 'judge_issue_limit') END;
END;

CREATE TABLE judge_redemptions (
  code_hash TEXT NOT NULL REFERENCES judge_codes(hash) ON DELETE CASCADE,
  sub TEXT NOT NULL,
  month TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (code_hash, sub),
  UNIQUE (sub, month)
);
CREATE INDEX judge_redemptions_by_code ON judge_redemptions(code_hash);

-- D1 executes the redemption and player write in one batch transaction. These checks therefore
-- see every earlier committed redemption, even when two Google returns race for the last place.
CREATE TRIGGER judge_redeem_guard BEFORE INSERT ON judge_redemptions
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM judge_codes WHERE hash = NEW.code_hash)
    THEN RAISE(ABORT, 'judge_invalid') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM judge_codes WHERE hash = NEW.code_hash AND expires_at <= NEW.redeemed_at)
    THEN RAISE(ABORT, 'judge_expired') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM judge_redemptions WHERE code_hash = NEW.code_hash) >= 2
    THEN RAISE(ABORT, 'judge_exhausted') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM players WHERE month = NEW.month) >= 480
    THEN RAISE(ABORT, 'judge_admission_full') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM players WHERE month = NEW.month) +
    (SELECT COUNT(*) FROM sign_in_refusals WHERE month = NEW.month) >= 490
    THEN RAISE(ABORT, 'judge_ceiling') END;
END;
