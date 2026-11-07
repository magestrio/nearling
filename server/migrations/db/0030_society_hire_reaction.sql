-- The paid answer's bounded code waits beside its hire until the chain accepts the fee.
-- A rejected hire never becomes a social encounter. No model words are stored here.
ALTER TABLE hires ADD COLUMN society_reaction TEXT CHECK (society_reaction IN ('respectful', 'rude'));
