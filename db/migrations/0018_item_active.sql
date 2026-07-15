-- Items become archivable: POS and pickers hide inactive items while
-- history (invoice lines, movements) keeps referencing them.
ALTER TABLE items ADD COLUMN active boolean NOT NULL DEFAULT true;
