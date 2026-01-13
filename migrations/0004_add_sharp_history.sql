-- Add history snapshots for sharp money signals (last 24h).

CREATE TABLE IF NOT EXISTS sharp_money_history (
  condition_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  market_title TEXT NOT NULL,
  event_time TEXT,
  sport_series_id INTEGER,
  side_a_label TEXT NOT NULL,
  side_b_label TEXT NOT NULL,
  side_a_total_value REAL DEFAULT 0,
  side_b_total_value REAL DEFAULT 0,
  side_a_sharp_score REAL DEFAULT 0,
  side_b_sharp_score REAL DEFAULT 0,
  side_a_price REAL,
  side_b_price REAL,
  sharp_side TEXT,
  confidence TEXT,
  score_differential REAL DEFAULT 0,
  sharp_side_value_ratio REAL,
  edge_rating INTEGER,
  pnl_coverage REAL,
  PRIMARY KEY(condition_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_sharp_history_condition_time
  ON sharp_money_history(condition_id, recorded_at);
