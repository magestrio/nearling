-- Preserve the sender of queued work and of a reply that lands after a gift.
ALTER TABLE jobs ADD COLUMN owner_account TEXT;
ALTER TABLE thoughts ADD COLUMN origin_owner TEXT;
ALTER TABLE thoughts ADD COLUMN origin_sent_at INTEGER;
