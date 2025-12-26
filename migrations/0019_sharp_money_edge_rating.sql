-- Add edge_rating column to sharp_money_cache
-- Single ranking score (0-100) for prioritizing bets

ALTER TABLE sharp_money_cache ADD COLUMN edge_rating INTEGER;

-- Index for sorting by edge rating
CREATE INDEX IF NOT EXISTS idx_sharp_money_edge_rating ON sharp_money_cache(edge_rating DESC);


