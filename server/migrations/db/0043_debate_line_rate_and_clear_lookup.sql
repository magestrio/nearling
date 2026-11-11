-- Freeze the exchange rate used for a paid line, and retain only a hash for an
-- owner to learn that an in-flight debate ended after memory clear. The share
-- code and all debate words still disappear with the active record.
ALTER TABLE debate_lines ADD COLUMN near_usd_rate TEXT;
ALTER TABLE debate_ended_invites ADD COLUMN share_hash TEXT;
ALTER TABLE debate_ended_invites ADD COLUMN clear_during_line INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX debate_ended_invites_by_share_hash
  ON debate_ended_invites (share_hash) WHERE share_hash IS NOT NULL;
