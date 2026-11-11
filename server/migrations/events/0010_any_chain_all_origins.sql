-- Quotes can originate on any currently payable 1-Click chain.
CREATE TABLE any_chain_events_new (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (name IN ('cross_chain_quote_created', 'cross_chain_deposit_seen',
    'cross_chain_feed_settled', 'cross_chain_feed_refunded', 'cross_chain_feed_stalled',
    'pet_fed', 'pet_woke')),
  route_id TEXT NOT NULL,
  pet_id TEXT,
  route TEXT CHECK (route IN ('quote', 'pet_address')),
  chain TEXT,
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
INSERT INTO any_chain_events_new
  SELECT id, at, name, route_id, pet_id, route, chain, asset, min_out_near, fee_usd,
    amount_near, elapsed_seconds, project_usd, reason, source, via FROM any_chain_events;
DROP TABLE any_chain_events;
ALTER TABLE any_chain_events_new RENAME TO any_chain_events;
