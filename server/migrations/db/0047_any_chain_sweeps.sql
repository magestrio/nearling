-- One owner-approved portion; its payload and NEAR transaction reference never change after signing.
CREATE TABLE any_chain_sweeps (
  route_id TEXT PRIMARY KEY,
  deposit_id TEXT NOT NULL REFERENCES any_chain_deposits(id),
  token_id TEXT NOT NULL,
  chain TEXT NOT NULL CHECK (chain IN ('base', 'solana')),
  amount_units TEXT NOT NULL,
  provider_wallet TEXT NOT NULL,
  destination TEXT NOT NULL,
  refund_recipient TEXT NOT NULL,
  quote_json TEXT NOT NULL,
  payload_hex TEXT NOT NULL,
  approval_hash TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  expiry_ms INTEGER NOT NULL,
  sponsor_cap_micros INTEGER NOT NULL,
  estimated_gas_micros INTEGER NOT NULL,
  estimated_rent_micros INTEGER NOT NULL,
  native_funding_units TEXT NOT NULL,
  native_gas_units TEXT NOT NULL,
  native_rent_units TEXT NOT NULL,
  gas_wallet_address TEXT NOT NULL,
  source_meta_json TEXT NOT NULL,
  creation_message TEXT,
  state TEXT NOT NULL CHECK (state IN ('quoted', 'signing', 'sign_unknown', 'approval_rejected', 'sign_failed', 'signed', 'awaiting_gas', 'broadcasting', 'sent', 'failed', 'refunded', 'food')),
  owner_signature TEXT,
  near_tx_hash TEXT,
  signed_at_ms INTEGER,
  mpc_response TEXT,
  funding_tx_hash TEXT,
  funding_signed_tx TEXT,
  creation_tx_hash TEXT,
  creation_signed_tx TEXT,
  source_signed_tx TEXT,
  source_tx_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX any_chain_sweeps_deposit ON any_chain_sweeps(deposit_id, created_at);
CREATE INDEX any_chain_sweeps_pet_chain ON any_chain_sweeps(token_id, chain, created_at);

-- The rent is a real project expense even when the owner later declines a sweep.
ALTER TABLE project_spend ADD COLUMN any_chain_expense_id TEXT;
CREATE UNIQUE INDEX project_spend_any_chain_once ON project_spend(any_chain_expense_id)
  WHERE any_chain_expense_id IS NOT NULL;
