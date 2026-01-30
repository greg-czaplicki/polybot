-- Add freshness metadata for sharp money cache/history.

ALTER TABLE sharp_money_cache ADD COLUMN computed_at INTEGER;
ALTER TABLE sharp_money_cache ADD COLUMN history_updated_at INTEGER;

ALTER TABLE sharp_money_history ADD COLUMN computed_at INTEGER;
