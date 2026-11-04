-- A link made before this migration has no chain transfer generation and must be re-published.
-- A generation is never inferred from gift_flights, which misses direct nft_transfer calls.
ALTER TABLE receipt_links ADD COLUMN transfer_generation INTEGER;
