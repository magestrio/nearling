-- Stable public card identity. The skill rows remain the only Hire board index.
CREATE TABLE pet_public_ids (
  token_id  TEXT PRIMARY KEY,
  opaque_id TEXT NOT NULL UNIQUE
);
