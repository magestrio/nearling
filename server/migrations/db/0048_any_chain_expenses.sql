-- Keep the route's delivery category and the original sleep state for once-only signals.
ALTER TABLE any_chain_routes ADD COLUMN via TEXT NOT NULL DEFAULT 'link'
  CHECK (via IN ('link', 'owner'));
ALTER TABLE any_chain_credit_evidence ADD COLUMN was_asleep INTEGER NOT NULL DEFAULT 0;
ALTER TABLE any_chain_sweeps ADD COLUMN near_signer_reserve_micros INTEGER NOT NULL DEFAULT 0;

-- A source payment may have several independently billed project transactions.
-- The unique project_spend.any_chain_expense_id is the monetary source of truth.
CREATE TABLE any_chain_expense_links (
  expense_id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('source_gas', 'source_account_rent', 'near_signer_gas',
    'near_release_gas', 'near_return_deposit_gas')),
  usd_micros INTEGER NOT NULL CHECK (usd_micros >= 0)
);
CREATE INDEX any_chain_expense_route ON any_chain_expense_links(route_id);
