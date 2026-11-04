-- A claim ID prevents a delayed gas-key job from attaching its hash to a later claim made
-- in the same millisecond. The signed bytes let an uncertain send retry the same transaction.
ALTER TABLE players ADD COLUMN gift_topup_op TEXT;
ALTER TABLE players ADD COLUMN gift_topup_signed_bytes BLOB;
ALTER TABLE players ADD COLUMN gift_topup_retry_at INTEGER;

-- Polls may rebroadcast one stored gift transaction, but never build another nonce while open.
ALTER TABLE gift_flights ADD COLUMN rebroadcast_at INTEGER;
