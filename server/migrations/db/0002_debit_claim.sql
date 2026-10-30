-- add-pet, fix round 1: the tick that works on a session claims it, so two crons never send the same
-- batch (expand only: the code before this file never reads the column).
ALTER TABLE debit_sessions ADD COLUMN claimed_at INTEGER;
