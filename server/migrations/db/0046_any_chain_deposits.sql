-- The first address offered is immutable even when ownership changes.
CREATE TABLE any_chain_addresses (
  token_id TEXT NOT NULL,
  chain TEXT NOT NULL CHECK (chain IN ('base', 'solana')),
  signer_id TEXT NOT NULL,
  domain_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  public_key TEXT NOT NULL,
  address TEXT NOT NULL,
  first_offered_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, chain),
  UNIQUE (chain, address)
);

-- One public source transfer can fund several independently approved portions.
CREATE TABLE any_chain_deposits (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  chain TEXT NOT NULL CHECK (chain IN ('base', 'solana')),
  source_tx_hash TEXT NOT NULL,
  transfer_index INTEGER NOT NULL,
  sender TEXT NOT NULL,
  address TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('usdc', 'other')),
  amount_units TEXT NOT NULL,
  source_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'below_minimum', 'unsupported', 'converting', 'food', 'refunded')),
  source_explorer TEXT NOT NULL,
  near_credit_tx TEXT,
  source_refund_tx TEXT,
  observed_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (chain, source_tx_hash, transfer_index)
);
CREATE INDEX any_chain_deposits_pet ON any_chain_deposits (token_id, observed_at);
