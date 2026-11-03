-- add-pet-errands (expand only: the code before this file never reads these columns and tables).
-- PRODUCT.md §8 > Мысль, Чек мысли, Errand in flight, Data source, Catalog entry, Skill code, Ответы работника
-- за день; ADR-024, ADR-025, ADR-026, ADR-027.

-- The thought of an errand (kind `errand`, status `away` while its search call waits for the report).
-- `form`: read | find | check. `sources`: what the report cites, as JSON for the page (a link's host, the
-- results' hosts), never the page. `verdict`: true | false | unclear, for «Is it true?». `searches`: how
-- many searches ran. `data_labels` / `data_missed`: the data sources a worker or an errand read / that did not
-- answer, as JSON of labels.
ALTER TABLE thoughts ADD COLUMN form TEXT;
ALTER TABLE thoughts ADD COLUMN sources TEXT;
ALTER TABLE thoughts ADD COLUMN verdict TEXT;
ALTER TABLE thoughts ADD COLUMN searches INTEGER;
ALTER TABLE thoughts ADD COLUMN data_labels TEXT;
ALTER TABLE thoughts ADD COLUMN data_missed TEXT;

-- What a call is on the receipt: search | data | report | reask (NULL for the calls of earlier kinds).
ALTER TABLE thought_calls ADD COLUMN label TEXT;

-- The errand in flight, one a pet. `owner`: the account that sent it, so a transfer is seen at the next
-- read (the failed errand goes with no one). `state`: away | done | failed. `reason` (failed only):
-- unreadable | too_long | search_down | empty | timeout | blocked; `cause` (search_down only):
-- unreachable | no_search. `job` is the owner's words: nulled by a clear of the memory, the row kept until the
-- errand ends or times out. `reserve_yocto`: the number held in `pet_spend` while it is away.
-- `price_yocto`: what the pet paid, NULL when nothing was spent.
CREATE TABLE errands (
  token_id      TEXT PRIMARY KEY,
  id            TEXT NOT NULL,
  owner         TEXT NOT NULL,
  form          TEXT NOT NULL,
  job           TEXT,
  state         TEXT NOT NULL,
  reason        TEXT,
  cause         TEXT,
  sent_at       INTEGER NOT NULL,
  reserve_yocto TEXT NOT NULL DEFAULT '0',
  searches_ran  INTEGER NOT NULL DEFAULT 0,
  thought_id    TEXT,
  price_yocto   TEXT
);
CREATE INDEX errands_by_state ON errands (state, sent_at);

-- A skill's keyless data source: the address sealed under SKILL_KEY (token id and row id as additional data),
-- `public_address` only for a copy from the catalog, `added_by` the account that added an own one (only it,
-- while it owns the pet, may publish it).
CREATE TABLE data_sources (
  id              TEXT PRIMARY KEY,
  token_id        TEXT NOT NULL,
  added_by        TEXT,
  label           TEXT NOT NULL,
  addr_ct         BLOB NOT NULL,
  addr_iv         BLOB NOT NULL,
  public_address  TEXT,
  entry_id        TEXT,
  tools           TEXT NOT NULL,
  published_entry TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX data_sources_by_pet ON data_sources (token_id);

-- A public copy made at publish: free and keyless.
CREATE TABLE catalog_entries (
  id           TEXT PRIMARY KEY,
  token_id     TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  address      TEXT NOT NULL,
  tools        TEXT NOT NULL,
  pet_name     TEXT NOT NULL,
  published_at INTEGER NOT NULL
);
CREATE INDEX catalog_by_time ON catalog_entries (published_at);
CREATE INDEX catalog_by_pet ON catalog_entries (token_id);

-- The skill's code under SKILL_KEY (token id and «code» as additional data); `hash` the sha-256 of the
-- text, `functions` the declaration as JSON.
CREATE TABLE skill_code (
  token_id   TEXT PRIMARY KEY,
  ct         BLOB NOT NULL,
  iv         BLOB NOT NULL,
  hash       TEXT NOT NULL,
  functions  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Test runs of a pet in a UTC day and the hash of today's last passing run.
CREATE TABLE code_tests (
  token_id    TEXT NOT NULL,
  day         INTEGER NOT NULL,
  runs        INTEGER NOT NULL DEFAULT 0,
  passed_hash TEXT,
  PRIMARY KEY (token_id, day)
);

-- Code versions (`<token_id>:<sha-256 of the code>`) loaded in a UTC day across the game.
CREATE TABLE code_versions (
  day     INTEGER NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (day, version)
);

-- A worker whose data call or code failed on its UTC day is out of Auto until 00:00 UTC.
ALTER TABLE worker_answers ADD COLUMN data_failed INTEGER NOT NULL DEFAULT 0;
