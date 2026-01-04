-- Remove sport_tag from sharp_money_cache (series IDs are now the source of truth)

DROP INDEX IF EXISTS idx_sharp_money_sport;
ALTER TABLE sharp_money_cache DROP COLUMN sport_tag;
