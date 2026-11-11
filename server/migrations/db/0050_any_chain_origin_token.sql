ALTER TABLE any_chain_routes ADD COLUMN origin_chain TEXT;
ALTER TABLE any_chain_routes ADD COLUMN origin_symbol TEXT;
ALTER TABLE any_chain_routes ADD COLUMN origin_decimals INTEGER;
ALTER TABLE any_chain_sweeps ADD COLUMN rejection_reason TEXT;
ALTER TABLE any_chain_retry_operations ADD COLUMN rejection_reason TEXT;
ALTER TABLE any_chain_route_status ADD COLUMN rejection_reason TEXT;
