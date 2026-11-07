-- Keep a paused wish if memory deletion fails after a confirmed reserve release.
ALTER TABLE will_operations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'cancel'
  CHECK (purpose IN ('cancel', 'clear', 'resume'));

-- A gifted pet's new owner must not see the former owner's private refusal evidence.
ALTER TABLE will_refusals ADD COLUMN payer_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE will_refusals ADD COLUMN worker_generation INTEGER NOT NULL DEFAULT 0;
