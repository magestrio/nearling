-- add-pet-life (expand only: the code before this file never reads these tables).
-- The counted days, the deeds of a window, the mood day and the energy of a pet; the friends who
-- fed it in the window; the stage change waiting to be written to the contract.
-- PRODUCT.md §8 > Жизнь питомца, Переход стадии, Хранение. All of it stays by token_id through a
-- gift, and Clear memory touches none of it (`Pet life data` > «удаление памяти»).

-- One row per pet, made by its first counted reply (`INSERT OR IGNORE`); no row means: one counted
-- day (the birth day), no deeds, full energy.
-- `last_counted_day`: the chain's UTC day of the last counted reply; NULL = only the birth day.
-- `riddles`, `works`, `deeps`: the deeds of the window since the last transition (kept while
-- `counted_days` < 3, reset at the transition). `mood_day`: the Worker's UTC day of the last event of
-- the day. `energy_used`: steps spent (0..10) in `energy_day`; another day reads 0.
CREATE TABLE pet_life (
  token_id         TEXT PRIMARY KEY,
  counted_days     INTEGER NOT NULL DEFAULT 1,
  last_counted_day INTEGER,
  riddles          INTEGER NOT NULL DEFAULT 0,
  works            INTEGER NOT NULL DEFAULT 0,
  deeps            INTEGER NOT NULL DEFAULT 0,
  mood_day         INTEGER,
  energy_day       INTEGER,
  energy_used      INTEGER NOT NULL DEFAULT 0
);

-- The distinct friends who fed the pet in the window: emptied at the transition, not written from
-- adult on.
CREATE TABLE life_friends (
  token_id TEXT NOT NULL,
  account  TEXT NOT NULL,
  PRIMARY KEY (token_id, account)
);

-- A stage change chosen at a counted reply and not yet written to the contract; deleted at the
-- write. `stage`: teen | adult; `trait`: the contract's snake_case word, fixed when chosen.
-- `sending_at`: the writer's claim; `retry_day`: no attempt before this UTC day.
CREATE TABLE pending_growth (
  token_id   TEXT NOT NULL,
  stage      TEXT NOT NULL,
  trait      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sending_at INTEGER,
  retry_day  INTEGER,
  PRIMARY KEY (token_id, stage)
);

-- `thoughts.kind` gains `growth`: the line of a transition (no model, no price). The column is free text.
