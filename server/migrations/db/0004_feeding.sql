-- add-feeding (expand only: the code before this file never reads these tables and columns).
-- The feeder's first name, the gas the project topped up, the last balance read of the game wallet,
-- the meal on its way, the friends' snacks of the day and the index of acquaintances.
-- PRODUCT.md §8 › Игрок, Кормление в пути, Перекусы друзей, Индекс знакомых.

-- `first_name`: the first word of the Google name when it passes `Feeder identity data`, else NULL.
-- `gas_topup_at`: when the project gave this player the gas of a portion (once, ADR-006), NULL before.
-- `gas_added_yocto`: what the project's transfers put into the wallet (the feeding top-up and, with
-- add-gift, the gift's). `wallet_seen_yocto`: the highest balance the server counted as the player's
-- own NEAR. Both are decimal text: yoctoNEAR does not fit a SQLite integer.
ALTER TABLE players ADD COLUMN first_name TEXT;
ALTER TABLE players ADD COLUMN gas_topup_at INTEGER;
ALTER TABLE players ADD COLUMN gas_added_yocto TEXT NOT NULL DEFAULT '0';
ALTER TABLE players ADD COLUMN wallet_seen_yocto TEXT NOT NULL DEFAULT '0';

-- `wake_seq`: +1 each time a meal wakes the pet; `wake_by`: the friend's name ('' for a nameless one,
-- NULL for the owner's own meal and for work). `wake_by` is memory: Clear memory erases it.
ALTER TABLE pets ADD COLUMN wake_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pets ADD COLUMN wake_by TEXT;

-- The meal or snack on its way, one per player; deleted at the outcome (§8: «до исхода транзакции»).
-- `id` is the portion's hash; a snack gets a random id and its hash after the send.
CREATE TABLE feedings (
  id            TEXT PRIMARY KEY,
  sub           TEXT NOT NULL,
  account       TEXT NOT NULL UNIQUE,
  token_id      TEXT NOT NULL,
  source        TEXT NOT NULL,
  via           TEXT NOT NULL,
  deposit_yocto TEXT,
  tx_hash       TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX feedings_by_pet ON feedings (token_id);

-- A friend's snack: written before the send of `pet_snack`, removed on a failure; read before a snack
-- is shown and at the write. `day` is the UTC day number; the cron erases earlier days.
CREATE TABLE friend_snacks (
  account  TEXT NOT NULL,
  token_id TEXT NOT NULL,
  day      INTEGER NOT NULL,
  PRIMARY KEY (account, token_id, day)
);
CREATE INDEX friend_snacks_by_day ON friend_snacks (account, day);

-- Who the pet knows, as a hint for `add-pet-work` (the chain's `pet_knows` is the truth). It stays
-- with the pet after a gift and after Clear memory.
CREATE TABLE known_index (
  token_id TEXT NOT NULL,
  account  TEXT NOT NULL,
  PRIMARY KEY (token_id, account)
);
