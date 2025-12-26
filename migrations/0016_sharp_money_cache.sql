-- Sharp Money Cache table for storing analyzed market data
-- Caches sharp money analysis results to avoid repeated API calls

CREATE TABLE IF NOT EXISTS sharp_money_cache (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  market_title TEXT NOT NULL,
  market_slug TEXT,
  event_slug TEXT,
  sport_tag TEXT,
  
  -- Side A (first outcome)
  side_a_label TEXT NOT NULL,
  side_a_total_value REAL DEFAULT 0,
  side_a_sharp_score REAL DEFAULT 0,
  side_a_holder_count INTEGER DEFAULT 0,
  side_a_top_holders TEXT, -- JSON array of top 5 with PnL data
  
  -- Side B (second outcome)  
  side_b_label TEXT NOT NULL,
  side_b_total_value REAL DEFAULT 0,
  side_b_sharp_score REAL DEFAULT 0,
  side_b_holder_count INTEGER DEFAULT 0,
  side_b_top_holders TEXT, -- JSON array of top 5 with PnL data
  
  -- Analysis
  sharp_side TEXT, -- 'A' or 'B' or 'EVEN'
  confidence TEXT, -- 'HIGH', 'MEDIUM', 'LOW'
  score_differential REAL DEFAULT 0,
  
  updated_at INTEGER NOT NULL,
  UNIQUE(condition_id)
);

CREATE INDEX IF NOT EXISTS idx_sharp_money_sport ON sharp_money_cache(sport_tag);
CREATE INDEX IF NOT EXISTS idx_sharp_money_updated ON sharp_money_cache(updated_at);
CREATE INDEX IF NOT EXISTS idx_sharp_money_confidence ON sharp_money_cache(confidence);
