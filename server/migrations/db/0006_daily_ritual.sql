-- add-daily-ritual (expand only: the code before this file never reads these tables or columns).
-- The ritual of a UTC day, the riddle of the day on the server, the owners' answers to it, and the
-- clock of the days already closed. PRODUCT.md §8 > Ритуал дня, Загадка суток на сервере, Ответ на
-- загадку, Хранение.

-- One row per pet and UTC day, made by the first thing that needs it: a part, or the close of a day.
-- `opened_at`: the Diary screen really stood; `read_at`: the entry was shown; `question_at`: the
-- answer to the question was heard; `riddle_at`: the answer to the riddle was accepted (the answer
-- itself is in `riddle_answers` and goes with a clear; this stays). `completed_at`: the ritual of
-- the day ended. `excused`: the day goes into `skipped` of the next mark (the pet slept through its
-- end, nothing was available, a mark that came too late); with `completed_at` it is «day not
-- recorded». `marked_at`: the streak mark of the day landed. `sending_at`: the mark writer's claim.
-- `mark_before`: the streak, freezes, last day and `skipped` at the send, JSON. `checked_at`: when the
-- cron last looked at the open row. Rows go with the next mark (`DELETE ... WHERE day < marked day`).
CREATE TABLE ritual_days (
  token_id     TEXT NOT NULL,
  day          INTEGER NOT NULL,
  opened_at    INTEGER,
  read_at      INTEGER,
  question_at  INTEGER,
  riddle_at    INTEGER,
  completed_at INTEGER,
  excused      INTEGER NOT NULL DEFAULT 0,
  marked_at    INTEGER,
  sending_at   INTEGER,
  mark_before  TEXT,
  checked_at   INTEGER,
  PRIMARY KEY (token_id, day)
);
CREATE INDEX ritual_days_pending ON ritual_days (completed_at, marked_at);

-- The riddle of a UTC day, written once by the first tick of the day, so the salt and the hash
-- survive every retry. `answers`: JSON array, the first one is the riddle's own. `salt` is cleared at
-- the reveal. `claim_at` / `reveal_claim_at`: the sender's claim. `sealed_at`: our commit is on chain,
-- and the riddle opens. `foreign_hash`: another hash was filed first that day, so none opens.
CREATE TABLE riddles (
  day             INTEGER PRIMARY KEY,
  text            TEXT NOT NULL,
  answers         TEXT NOT NULL,
  salt            TEXT,
  hash            TEXT NOT NULL,
  claim_at        INTEGER,
  sealed_at       INTEGER,
  reveal_claim_at INTEGER,
  revealed_at     INTEGER,
  foreign_hash    INTEGER NOT NULL DEFAULT 0
);

-- The owner's answer to a day's riddle (at most 40 characters) and whether it matched; read for the
-- verdict only once the riddle is revealed. Kept to the end of the next UTC day.
CREATE TABLE riddle_answers (
  token_id    TEXT NOT NULL,
  day         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  correct     INTEGER NOT NULL,
  answered_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, day)
);

-- One row (id = 1): the last UTC day whose end the cron has closed (`closeDays`).
CREATE TABLE ritual_clock (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  closed_day INTEGER NOT NULL
);

-- `asleep_diary_day`: the UTC day for which the pet woke up after its diary window, having been asleep
-- through it; tells «a day with no diary» from «a diary that was not written» (`Daily ritual flow`).
-- `gifted_unmarked`: 1 from a gift to the first streak mark after it (`Streak rule`); `add-gift` sets it.
ALTER TABLE pets ADD COLUMN asleep_diary_day INTEGER;
ALTER TABLE pets ADD COLUMN gifted_unmarked INTEGER NOT NULL DEFAULT 0;

-- `thoughts.kind` gains `question`: the answer to the question of the day. The column is free text.
