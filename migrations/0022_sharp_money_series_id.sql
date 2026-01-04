-- Add sport_series_id to sharp_money_cache and backfill from sport_tag

ALTER TABLE sharp_money_cache ADD COLUMN sport_series_id INTEGER;

UPDATE sharp_money_cache
SET sport_series_id = CASE sport_tag
  WHEN 'nfl' THEN 10187
  WHEN 'nba' THEN 10345
  WHEN 'cfb' THEN 10210
  WHEN 'ncaaf' THEN 10210
  WHEN 'ncaab' THEN 39
  WHEN 'mlb' THEN 10426
  WHEN 'nhl' THEN 10346
  WHEN 'epl' THEN 10188
  ELSE sport_series_id
END
WHERE sport_series_id IS NULL
  AND sport_tag IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sharp_money_series_id ON sharp_money_cache(sport_series_id);
