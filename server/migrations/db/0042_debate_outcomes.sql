-- A model's private social code is kept apart from the public spoken line.
-- The existing society_processed_hires table claims a debate outcome under a prefixed id.
ALTER TABLE debate_lines ADD COLUMN social_reaction TEXT CHECK (social_reaction IN ('respectful', 'rude'));
