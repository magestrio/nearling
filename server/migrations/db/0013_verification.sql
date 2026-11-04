-- add-verification: expand the receipt index and the existing signed-send journal.
-- Existing thought rows remain readable; values that cannot be proved stay unknown.
ALTER TABLE thoughts ADD COLUMN receipt_token_id TEXT;
ALTER TABLE thoughts ADD COLUMN paying_token_id TEXT;
ALTER TABLE thoughts ADD COLUMN debit_tx_hash TEXT;
ALTER TABLE thoughts ADD COLUMN near_usd_rate TEXT;
ALTER TABLE thoughts ADD COLUMN without_reply INTEGER;
ALTER TABLE thoughts ADD COLUMN link_eligible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thoughts ADD COLUMN adapter_used INTEGER NOT NULL DEFAULT 0;

UPDATE thoughts SET
  receipt_token_id = CASE WHEN kind IN ('advice', 'hire_answer') AND worker_id IS NOT NULL THEN worker_id ELSE token_id END,
  paying_token_id = token_id,
  without_reply = CASE WHEN erased_at IS NULL THEN CASE WHEN reply_text IS NULL THEN 1 ELSE 0 END ELSE NULL END,
  adapter_used = CASE WHEN data_labels IS NOT NULL THEN 1 ELSE 0 END;

CREATE INDEX thoughts_by_receipt ON thoughts (receipt_token_id, created_at DESC, id DESC);

CREATE TRIGGER verification_thought_insert AFTER INSERT ON thoughts BEGIN
  UPDATE thoughts SET
    receipt_token_id = CASE WHEN NEW.kind IN ('advice', 'hire_answer') AND NEW.worker_id IS NOT NULL THEN NEW.worker_id ELSE NEW.token_id END,
    paying_token_id = NEW.token_id,
    without_reply = CASE WHEN NEW.reply_text IS NULL THEN 1 ELSE 0 END,
    adapter_used = CASE WHEN NEW.data_labels IS NOT NULL THEN 1 ELSE 0 END,
    link_eligible = CASE WHEN NEW.kind NOT IN ('growth', 'hire_event') AND NEW.skilled = 0 AND NEW.data_labels IS NULL THEN 1 ELSE 0 END
  WHERE id = NEW.id;
END;

CREATE TRIGGER verification_thought_update AFTER UPDATE OF worker_id, reply_text, data_labels, erased_at ON thoughts BEGIN
  UPDATE thoughts SET
    receipt_token_id = CASE WHEN NEW.kind IN ('advice', 'hire_answer') AND NEW.worker_id IS NOT NULL THEN NEW.worker_id ELSE NEW.token_id END,
    without_reply = CASE WHEN NEW.erased_at IS NULL THEN CASE WHEN NEW.reply_text IS NULL THEN 1 ELSE 0 END ELSE OLD.without_reply END,
    adapter_used = CASE WHEN NEW.data_labels IS NOT NULL THEN 1 ELSE 0 END,
    link_eligible = CASE WHEN NEW.kind NOT IN ('growth', 'hire_event') AND NEW.skilled = 0 AND NEW.data_labels IS NULL THEN 1 ELSE 0 END
  WHERE id = NEW.id;
END;

-- Publication is implemented in the next server stage. Codes are stored by digest only.
CREATE TABLE receipt_links (
  code_hash TEXT PRIMARY KEY,
  thought_id TEXT NOT NULL,
  paying_token_id TEXT NOT NULL,
  publisher TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (thought_id, publisher, operation_id)
);
CREATE INDEX receipt_links_by_payer ON receipt_links (paying_token_id, revoked_at);

-- The journal records the kind and reference of every signed transaction before broadcast.
-- Older item rows retain their meaning through the default.
ALTER TABLE item_sends ADD COLUMN kind TEXT NOT NULL DEFAULT 'item';
CREATE INDEX item_sends_record ON item_sends (token_id, kind, item, sent_at);
