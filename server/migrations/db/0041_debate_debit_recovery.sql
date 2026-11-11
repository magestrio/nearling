-- A prepared operation keeps the exact debit sequence and the signed transaction before broadcast.
ALTER TABLE debate_debit_operations ADD COLUMN debit_id INTEGER;
ALTER TABLE debate_debit_operations ADD COLUMN args_json TEXT;
ALTER TABLE debates ADD COLUMN end_reason TEXT;
