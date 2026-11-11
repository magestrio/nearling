-- A wake needs its source even after a second owner tab asks with an older wake counter.
-- This is a coded route, never a payer address or name.
ALTER TABLE pets ADD COLUMN wake_source TEXT;
