-- A diary view shares the showcase browser-event counters. The attempt exists only during
-- its INSERT; the trigger admits the event and increments all four windows atomically.
CREATE TABLE society_diary_event_attempt (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  tab_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  pet_id TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  minute_bucket INTEGER NOT NULL,
  day_bucket INTEGER NOT NULL
);

CREATE TRIGGER society_diary_event_admit AFTER INSERT ON society_diary_event_attempt
BEGIN
  DELETE FROM society_diary_event_attempt WHERE id = NEW.id;
  SELECT CASE WHEN
    EXISTS (SELECT 1 FROM society_events WHERE id = NEW.id) OR
    COALESCE((SELECT n FROM showcase_event_counts WHERE scope = 'tab_minute' AND subject = NEW.tab_id AND bucket = NEW.minute_bucket), 0) >= 60 OR
    COALESCE((SELECT n FROM showcase_event_counts WHERE scope = 'tab_day' AND subject = NEW.tab_id AND bucket = NEW.day_bucket), 0) >= 1000 OR
    COALESCE((SELECT n FROM showcase_event_counts WHERE scope = 'ip_minute' AND subject = NEW.ip_key AND bucket = NEW.minute_bucket), 0) >= 600 OR
    COALESCE((SELECT n FROM showcase_event_counts WHERE scope = 'ip_day' AND subject = NEW.ip_key AND bucket = NEW.day_bucket), 0) >= 10000
    THEN RAISE(IGNORE) END;
  INSERT INTO society_events (id, at, name, tab_id, player_id, pet_id)
    VALUES (NEW.id, NEW.at, 'society_diary_seen', NEW.tab_id, NEW.player_id, NEW.pet_id);
  INSERT INTO showcase_event_counts VALUES ('tab_minute', NEW.tab_id, NEW.minute_bucket, (NEW.minute_bucket + 1) * 60000, 1)
    ON CONFLICT (scope, subject, bucket) DO UPDATE SET n = n + 1;
  INSERT INTO showcase_event_counts VALUES ('tab_day', NEW.tab_id, NEW.day_bucket, (NEW.day_bucket + 1) * 86400000, 1)
    ON CONFLICT (scope, subject, bucket) DO UPDATE SET n = n + 1;
  INSERT INTO showcase_event_counts VALUES ('ip_minute', NEW.ip_key, NEW.minute_bucket, (NEW.minute_bucket + 1) * 60000, 1)
    ON CONFLICT (scope, subject, bucket) DO UPDATE SET n = n + 1;
  INSERT INTO showcase_event_counts VALUES ('ip_day', NEW.ip_key, NEW.day_bucket, (NEW.day_bucket + 1) * 86400000, 1)
    ON CONFLICT (scope, subject, bucket) DO UPDATE SET n = n + 1;
END;
