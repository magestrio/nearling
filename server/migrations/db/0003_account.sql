-- add-account (expand only: the code before this file never reads these tables and columns).
-- The player, who is let in this month, the refusals after Google and the sessions ended by a
-- sign-out. PRODUCT.md §8 › Игрок, Отказ после Google, Ended sign-in session.

-- The other fields of the player come with their changes (add-feeding, add-gift, add-analytics).
-- `month` is the UTC month (YYYY-MM) of the player's last sign-in or request with a session.
CREATE TABLE players (
  sub        TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  month      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX players_by_month ON players (month);

-- One row per account and month; erased by the cron at the next month.
CREATE TABLE sign_in_refusals (
  sub   TEXT NOT NULL,
  month TEXT NOT NULL,
  PRIMARY KEY (sub, month)
);

-- Privy's opaque session id and the time of the sign-out; the cron erases a row after 24 hours.
CREATE TABLE ended_sessions (
  sid      TEXT PRIMARY KEY,
  ended_at INTEGER NOT NULL
);

-- Memory deletion (the stage that builds `forget`): the count of clears, and the time a thought's
-- words were erased.
ALTER TABLE pets ADD COLUMN memory_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thoughts ADD COLUMN erased_at INTEGER;
