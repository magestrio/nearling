-- The last confirmed public reserve seen after a settled hire, for idempotent progress events.
ALTER TABLE pet_wishes ADD COLUMN noted_reserve_yocto TEXT NOT NULL DEFAULT '0';
