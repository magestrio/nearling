-- add-pet-work (expand only: the code before this file never reads these columns and tables).
-- PRODUCT.md §8 > Режим найма, Предложение найма, Ответы работника за день, Навык, Запись работы;
-- ADR-011 > «A band», ADR-023.

-- The thoughts of a hire. `worker_id` / `worker_name`: the pet an advice, a hire question or a worker's answer
-- is about (the worker's name at the time). `skilled`: the answer was given under the worker's skill.
-- `recall`: 1 is read into the pet's later requests; 0 is not (a skilled answer is never remembered, `Skilled
-- answer data`). `turn_id`: the lines of one hire turn. New kinds, free text as the column is: `advice`,
-- `hire_question`, `hire_answer`, `hire_event`.
ALTER TABLE thoughts ADD COLUMN worker_id TEXT;
ALTER TABLE thoughts ADD COLUMN worker_name TEXT;
ALTER TABLE thoughts ADD COLUMN skilled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thoughts ADD COLUMN recall INTEGER NOT NULL DEFAULT 1;
ALTER TABLE thoughts ADD COLUMN turn_id TEXT;

-- What a job on its way shows a reloaded page: `{"asking": "<worker's name>"}`; cleared with the payload.
ALTER TABLE jobs ADD COLUMN progress TEXT;

-- One row per hire: the fee's record from the question to the batch that writes it. Amounts are yocto in
-- text, as everywhere; `fee_usd_micros` is the fee at the rate it was made, so the line under an answer
-- never moves. `kind`: pet | player. `status` and `dropped_code`: written by the hire code of the later
-- stages (the batch, the resend). `record_day`: the UTC day of the hirer's debit, the day of the worker's
-- work record.
CREATE TABLE hires (
  id                TEXT PRIMARY KEY,
  turn_id           TEXT,
  hirer_id          TEXT NOT NULL,
  worker_id         TEXT NOT NULL,
  worker_name       TEXT NOT NULL,
  kind              TEXT NOT NULL,
  mode              TEXT,
  skilled           INTEGER NOT NULL DEFAULT 0,
  fee_yocto         TEXT NOT NULL,
  fee_usd_micros    INTEGER NOT NULL,
  answer_thought_id TEXT,
  session_id        TEXT,
  status            TEXT NOT NULL,
  dropped_code      TEXT,
  record_day        INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX hires_by_hirer ON hires (hirer_id, status);
CREATE INDEX hires_by_answer ON hires (answer_thought_id);

-- The hire mode of a pet, by token id: it goes with the pet at a gift and stays through a clear of the
-- memory. No row is Auto (OD-20).
CREATE TABLE hire_modes (
  token_id TEXT PRIMARY KEY,
  -- auto | manual
  mode     TEXT NOT NULL
);

-- The offer a pet in Manual made and the owner has not answered: one per pet. It keeps the question the
-- pet wrote and the price it named, which is only a ceiling (`Hire quote data`).
CREATE TABLE hire_offers (
  token_id    TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL,
  worker_id   TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  question    TEXT NOT NULL,
  price_yocto TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- The answers of a worker in a UTC day, by the server's clock: `n` those that reached the asker, `held` the
-- places of calls on their way (`Hire quote data`). `held_at`: when a place was last held, for the cron to
-- clear a place a dead desk left. A row of an earlier day than yesterday is erased by the cron.
CREATE TABLE worker_answers (
  token_id TEXT NOT NULL,
  day      INTEGER NOT NULL,
  n        INTEGER NOT NULL DEFAULT 0,
  held     INTEGER NOT NULL DEFAULT 0,
  held_at  INTEGER,
  PRIMARY KEY (token_id, day)
);

-- The private skill of a pet: the label in the clear (it is public on the pet's page), the instruction
-- sealed with AES-256-GCM under the Worker's secret `SKILL_KEY`: `ct` the ciphertext with its tag, `iv` the
-- one-time value of that write.
CREATE TABLE skills (
  token_id   TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  ct         BLOB NOT NULL,
  iv         BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

-- What a worker did, for its own page and diary: names and amounts, never a question or an answer.
CREATE TABLE work_records (
  hire_id            TEXT PRIMARY KEY,
  worker_id          TEXT NOT NULL,
  hirer_id           TEXT NOT NULL,
  hirer_name         TEXT NOT NULL,
  fee_yocto          TEXT NOT NULL,
  answer_yocto       TEXT NOT NULL,
  earned_usd_micros  INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  day                INTEGER NOT NULL,
  recorded_at        INTEGER NOT NULL
);
CREATE INDEX work_records_by_worker ON work_records (worker_id, day);
