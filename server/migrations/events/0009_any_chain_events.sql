-- Private route and pet identifiers are hashed or mapped before writing this table.
CREATE TABLE any_chain_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (name IN ('cross_chain_quote_created', 'cross_chain_deposit_seen',
    'cross_chain_feed_settled', 'cross_chain_feed_refunded', 'cross_chain_feed_stalled',
    'pet_fed', 'pet_woke')),
  route_id TEXT NOT NULL,
  pet_id TEXT,
  route TEXT CHECK (route IN ('quote', 'pet_address')),
  chain TEXT CHECK (chain IN ('base', 'solana')),
  asset TEXT CHECK (asset IN ('usdc', 'other')),
  min_out_near REAL,
  fee_usd REAL,
  amount_near REAL,
  elapsed_seconds INTEGER,
  project_usd REAL,
  reason TEXT,
  source TEXT CHECK (source = 'cross_chain'),
  via TEXT CHECK (via IN ('link', 'owner', 'address'))
);
