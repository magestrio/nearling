-- Immutable evidence is inserted before a route projection changes. A second
-- delivery on the same quote gets its own row; a poll of one receipt is idempotent.
CREATE TABLE any_chain_delivery_evidence (
  receipt_id TEXT PRIMARY KEY,
  route_id TEXT,
  token_id TEXT,
  near_tx_hash TEXT NOT NULL,
  amount_yocto TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pending', 'held')),
  credit_id INTEGER UNIQUE,
  unwrap_failed INTEGER NOT NULL DEFAULT 0,
  held_id INTEGER UNIQUE,
  held_reason TEXT,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX any_chain_delivery_route ON any_chain_delivery_evidence(route_id);

CREATE TABLE any_chain_credit_evidence (
  credit_id INTEGER PRIMARY KEY,
  near_tx_hash TEXT NOT NULL,
  amount_yocto TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE TABLE any_chain_retry_operations (
  credit_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'sending', 'unknown', 'failed', 'settled')),
  tx_hash TEXT UNIQUE,
  signed_bytes BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE any_chain_retry_attempts (
  credit_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  ended_at INTEGER NOT NULL,
  PRIMARY KEY (credit_id, tx_hash)
);

CREATE TABLE any_chain_route_status (
  route_id TEXT PRIMARY KEY REFERENCES any_chain_routes(id),
  provider_state TEXT NOT NULL,
  provider_reference TEXT,
  source_tx_hash TEXT,
  source_condition TEXT,
  provider_refund_tx TEXT,
  provider_refund_amount TEXT,
  last_checked_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE any_chain_held_returns (
  held_id INTEGER PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES any_chain_delivery_evidence(receipt_id),
  amount_yocto TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_tx_hash TEXT,
  origin_chain TEXT,
  verified_recipient TEXT,
  attestation_nonce TEXT UNIQUE,
  quote_state TEXT CHECK (quote_state IN ('quoting', 'ready', 'below_minimum')),
  reverse_quote_json TEXT,
  reverse_provider_reference TEXT,
  release_tx_hash TEXT UNIQUE,
  release_state TEXT CHECK (release_state IN ('in_flight', 'failed', 'released')),
  reverse_state TEXT CHECK (reverse_state IN ('processing', 'failed', 'refunded', 'recovered')),
  recovered_tx_hash TEXT UNIQUE,
  refund_tx_hash TEXT UNIQUE,
  refund_amount_usdc TEXT,
  resolved_at INTEGER
);

CREATE TABLE any_chain_operator_nonces (
  nonce TEXT PRIMARY KEY,
  held_id INTEGER NOT NULL,
  used_at INTEGER NOT NULL
);

CREATE TABLE any_chain_held_attempts (
  held_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  reverse_quote_json TEXT NOT NULL,
  provider_reference TEXT NOT NULL UNIQUE,
  release_tx_hash TEXT UNIQUE,
  recovered_tx_hash TEXT UNIQUE,
  state TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (held_id, attempt)
);
