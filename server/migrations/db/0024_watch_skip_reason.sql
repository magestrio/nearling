-- A skipped watch day keeps why it was skipped (sleeping, energy, food, cap, services), so the owner's
-- Watch sheet can say it. The reason is a code, never words.
ALTER TABLE watch_checks ADD COLUMN skip_reason TEXT;
