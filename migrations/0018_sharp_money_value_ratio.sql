-- Add sharp_side_value_ratio column to sharp_money_cache
-- Tracks what % of total market value is on the sharp side (0-1)

ALTER TABLE sharp_money_cache ADD COLUMN sharp_side_value_ratio REAL;
