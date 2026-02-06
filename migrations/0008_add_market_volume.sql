-- Add market volume/liquidity to cache entries for UI display.

ALTER TABLE sharp_money_cache ADD COLUMN market_volume REAL;
ALTER TABLE sharp_money_cache ADD COLUMN market_liquidity REAL;
