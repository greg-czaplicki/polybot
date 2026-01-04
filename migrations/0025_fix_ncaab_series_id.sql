-- Backfill ncaab series id from legacy 39 to 10470

UPDATE sharp_money_cache
SET sport_series_id = 10470
WHERE sport_series_id = 39;
