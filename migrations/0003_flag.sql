ALTER TABLE cards ADD COLUMN flagged_at INTEGER;
CREATE INDEX cards_flagged_at ON cards (flagged_at);
