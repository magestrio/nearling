-- Identifiable, expiring preparation claims. Started calls remain in will_screenings.
CREATE TABLE will_screening_claims (
  id TEXT PRIMARY KEY,
  worker_token TEXT NOT NULL,
  day INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX will_screening_claims_worker_day ON will_screening_claims (worker_token, day, expires_at);
