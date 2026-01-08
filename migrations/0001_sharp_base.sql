-- Base schema for Sharp Money data and supporting caches.

CREATE TABLE IF NOT EXISTS sharp_money_cache (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  market_title TEXT NOT NULL,
  market_slug TEXT,
  event_slug TEXT,
  event_time TEXT,
  sport_series_id INTEGER,

  -- Side A (first outcome)
  side_a_label TEXT NOT NULL,
  side_a_total_value REAL DEFAULT 0,
  side_a_sharp_score REAL DEFAULT 0,
  side_a_holder_count INTEGER DEFAULT 0,
  side_a_top_holders TEXT,
  side_a_price REAL,

  -- Side B (second outcome)
  side_b_label TEXT NOT NULL,
  side_b_total_value REAL DEFAULT 0,
  side_b_sharp_score REAL DEFAULT 0,
  side_b_holder_count INTEGER DEFAULT 0,
  side_b_top_holders TEXT,
  side_b_price REAL,

  -- Analysis
  sharp_side TEXT,
  confidence TEXT,
  score_differential REAL DEFAULT 0,
  sharp_side_value_ratio REAL,
  edge_rating INTEGER,

  updated_at INTEGER NOT NULL,
  UNIQUE(condition_id)
);

CREATE INDEX IF NOT EXISTS idx_sharp_money_updated ON sharp_money_cache(updated_at);
CREATE INDEX IF NOT EXISTS idx_sharp_money_confidence ON sharp_money_cache(confidence);
CREATE INDEX IF NOT EXISTS idx_sharp_money_series_id ON sharp_money_cache(sport_series_id);
CREATE INDEX IF NOT EXISTS idx_sharp_money_edge_rating ON sharp_money_cache(edge_rating DESC);

CREATE TABLE IF NOT EXISTS wallet_pnl_cache (
  wallet_address TEXT PRIMARY KEY,
  pnl_day REAL,
  pnl_week REAL,
  pnl_month REAL,
  pnl_all REAL,
  volume REAL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pnl_cache_fetched_at ON wallet_pnl_cache(fetched_at);

CREATE TABLE IF NOT EXISTS wallet_unit_size_cache (
  wallet_address TEXT PRIMARY KEY,
  unit_size REAL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unit_size_cache_fetched_at ON wallet_unit_size_cache(fetched_at);
