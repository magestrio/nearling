-- A watch debit can settle on chain before its target and diary pointer are updated in D1.
-- Keep the named observation only until the confirmed debit is reconciled. Clear memory and
-- target replacement erase these pending words in the same batch as the active watch.
ALTER TABLE watch_checks ADD COLUMN pending_content TEXT;
ALTER TABLE watch_checks ADD COLUMN pending_sources TEXT;
ALTER TABLE watch_checks ADD COLUMN pending_result TEXT;
ALTER TABLE watch_checks ADD COLUMN cost_usd_micros INTEGER;
ALTER TABLE watch_checks ADD COLUMN owner_generation INTEGER;
