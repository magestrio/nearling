-- add-wardrobe (expand only: the code before this file never reads these tables).
-- PRODUCT.md §8 > Гардероб на сервере, Транзакции питомца; ADR-012, ADR-013.

-- The worn item of a pet and which earned items' notices were shown. By token_id: it goes with the pet
-- at a gift and stays through a clear of the memory. `worn` is the item's slug (`null`: no outfit);
-- `seen` is a bit mask of the earned items (bit = item id) whose notice has been shown. «Not yet
-- shown» is derived: an earned item on the chain whose bit is not here. No row: nothing worn, nothing
-- seen.
CREATE TABLE wardrobe (
  token_id TEXT PRIMARY KEY,
  worn     TEXT,
  seen     INTEGER NOT NULL DEFAULT 0
);

-- The Thinking cap waiting to be written to the chain (§8 «выдача вещи за загадку, ждущая записи»):
-- one row per pet, made by the reveal of a riddle the owner answered rightly. `sending_at`: the
-- writer's claim. `tried`: a send was made, so a lost outcome that turns out to have landed fires
-- its event at once.
CREATE TABLE outfit_grants (
  token_id   TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  sending_at INTEGER,
  tried      INTEGER NOT NULL DEFAULT 0
);

-- A purchase of the owner's: a queue of its own (a clear of the memory fails every row of `jobs`, and
-- a purchase must survive it). `status`: queued, sending, bought, failed, or unknown (the send
-- brought no outcome; the price stays held). `given_yocto`: the part of the price paid from given
-- food, for the analytics event. `code`: why it failed. `sending_at`: when the row turned `sending`
-- (not `created_at`: a row that waited in the desk's queue is not a dead desk; a send waiting in the key's
-- queue past 5 minutes is failed with the row and broadcasts nothing: its hash is noted only while `sending`).
CREATE TABLE outfit_buys (
  id           TEXT PRIMARY KEY,
  token_id     TEXT NOT NULL,
  item         TEXT NOT NULL,
  status       TEXT NOT NULL,
  price_yocto  TEXT NOT NULL,
  given_yocto  TEXT,
  tx_hash      TEXT,
  code         TEXT,
  created_at   INTEGER NOT NULL,
  sending_at   INTEGER,
  settled_at   INTEGER
);
CREATE INDEX outfit_buys_status ON outfit_buys (status, created_at);
CREATE INDEX outfit_buys_pet ON outfit_buys (token_id, created_at);

-- The hash of a transaction that may write an item, stored before the broadcast, so an answer that
-- never came still leaves the hash behind. Rows go when the pair's hash is kept or the network never
-- knew it.
CREATE TABLE item_sends (
  tx_hash    TEXT PRIMARY KEY,
  token_id   TEXT NOT NULL,
  item       TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  checked_at INTEGER
);
CREATE INDEX item_sends_pair ON item_sends (token_id, item, sent_at);

-- §8 > Транзакции питомца: the transaction that wrote an item. `kind` is 'item' and `ref` the item's
-- slug; later changes add their own kinds. By token_id: it stays through a gift and a clear.
CREATE TABLE pet_transactions (
  token_id TEXT NOT NULL,
  kind     TEXT NOT NULL,
  ref      TEXT NOT NULL,
  tx_hash  TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (token_id, kind, ref)
);
