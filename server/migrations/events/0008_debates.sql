-- Opaque debate signals only. No topic, line, account, token id or share code.
CREATE TABLE debate_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL CHECK (at >= 0),
  name TEXT NOT NULL CHECK (name IN ('debate_invited', 'debate_accepted', 'debate_started',
    'debate_line_delivered', 'debate_ended', 'debate_link_opened', 'debate_receipt_opened')),
  debate_id TEXT NOT NULL,
  first_pet_id TEXT,
  second_pet_id TEXT,
  day INTEGER,
  side TEXT CHECK (side IN ('first', 'second')),
  round INTEGER CHECK (round IN (1, 2)),
  price_usd REAL CHECK (price_usd >= 0),
  cost_usd REAL CHECK (cost_usd >= 0),
  reason TEXT CHECK (reason IN ('complete', 'refused', 'stopped', 'unavailable')),
  tab_id TEXT,
  CHECK ((name IN ('debate_link_opened', 'debate_receipt_opened')
    AND first_pet_id IS NULL AND second_pet_id IS NULL AND day IS NULL AND side IS NULL
    AND round IS NULL AND price_usd IS NULL AND cost_usd IS NULL AND reason IS NULL AND tab_id IS NOT NULL)
    OR (name IN ('debate_invited', 'debate_accepted', 'debate_started')
      AND first_pet_id IS NOT NULL AND second_pet_id IS NOT NULL AND day IS NOT NULL AND side IS NOT NULL
      AND round IS NULL AND price_usd IS NULL AND cost_usd IS NULL AND reason IS NULL AND tab_id IS NULL)
    OR (name = 'debate_line_delivered' AND first_pet_id IS NOT NULL AND second_pet_id IS NOT NULL
      AND day IS NULL AND side IS NOT NULL AND round IS NOT NULL AND price_usd IS NOT NULL
      AND cost_usd IS NOT NULL AND reason IS NULL AND tab_id IS NULL)
    OR (name = 'debate_ended' AND first_pet_id IS NOT NULL AND second_pet_id IS NOT NULL
      AND day IS NULL AND side IS NULL AND round IS NULL AND price_usd IS NULL
      AND cost_usd IS NULL AND reason IS NOT NULL AND tab_id IS NULL))
);

-- The attempt exists only during its INSERT. Admission and all four counters are atomic.
CREATE TABLE debate_event_attempt (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (name IN ('debate_link_opened', 'debate_receipt_opened')),
  debate_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  minute_bucket INTEGER NOT NULL,
  day_bucket INTEGER NOT NULL
);

CREATE TRIGGER debate_event_admit AFTER INSERT ON debate_event_attempt
BEGIN
  DELETE FROM debate_event_attempt WHERE id = NEW.id;
  SELECT CASE WHEN
    EXISTS (SELECT 1 FROM debate_events WHERE id = NEW.id) OR
    COALESCE((SELECT n FROM showcase_event_counts WHERE scope = 'tab_minute' AND subject = NEW.tab_id AND bucket = NEW.minute_bucket), 0) >= 60 OR
    COALESCE((SELECT n FROM showcase_event_counts WHERE scope = 'tab_day' AND subject = NEW.tab_id AND bucket = NEW.day_bucket), 0) >= 1000 OR
    COALESCE((SELECT n FROM showcase_event_counts WHERE scope = 'ip_minute' AND subject = NEW.ip_key AND bucket = NEW.minute_bucket), 0) >= 600 OR
    COALESCE((SELECT n FROM showcase_event_counts WHERE scope = 'ip_day' AND subject = NEW.ip_key AND bucket = NEW.day_bucket), 0) >= 10000
    THEN RAISE(IGNORE) END;
  INSERT INTO debate_events (id, at, name, debate_id, tab_id)
    VALUES (NEW.id, NEW.at, NEW.name, NEW.debate_id, NEW.tab_id);
  INSERT INTO showcase_event_counts VALUES ('tab_minute', NEW.tab_id, NEW.minute_bucket, (NEW.minute_bucket + 1) * 60000, 1)
    ON CONFLICT (scope, subject, bucket) DO UPDATE SET n = n + 1;
  INSERT INTO showcase_event_counts VALUES ('tab_day', NEW.tab_id, NEW.day_bucket, (NEW.day_bucket + 1) * 86400000, 1)
    ON CONFLICT (scope, subject, bucket) DO UPDATE SET n = n + 1;
  INSERT INTO showcase_event_counts VALUES ('ip_minute', NEW.ip_key, NEW.minute_bucket, (NEW.minute_bucket + 1) * 60000, 1)
    ON CONFLICT (scope, subject, bucket) DO UPDATE SET n = n + 1;
  INSERT INTO showcase_event_counts VALUES ('ip_day', NEW.ip_key, NEW.day_bucket, (NEW.day_bucket + 1) * 86400000, 1)
    ON CONFLICT (scope, subject, bucket) DO UPDATE SET n = n + 1;
END;
