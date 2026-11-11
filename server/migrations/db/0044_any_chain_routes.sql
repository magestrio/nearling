-- A dry quote has no payment destination. Acceptance stores the one-time destination
-- only after a fresh payable quote passes the same chain and contract checks.
CREATE TABLE any_chain_routes (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  origin_asset TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  refund_to TEXT NOT NULL,
  expected_out TEXT NOT NULL,
  min_out TEXT NOT NULL,
  quote_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'accepting', 'accepted')),
  created_at INTEGER NOT NULL,
  request_deadline TEXT NOT NULL,
  deposit_address TEXT UNIQUE,
  deposit_memo TEXT,
  provider_deadline TEXT,
  inactive_at TEXT
);
