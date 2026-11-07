-- Keep the quote's relationship state with the Manual offer, and the mode of a hire
-- refusal with its private conversation event. Settled hires already store mode.
ALTER TABLE hire_offers ADD COLUMN discounted INTEGER NOT NULL DEFAULT 0 CHECK (discounted IN (0, 1));
ALTER TABLE thoughts ADD COLUMN hire_mode TEXT CHECK (hire_mode IN ('auto', 'manual'));
