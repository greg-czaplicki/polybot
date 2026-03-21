-- Warehouse tables for feature snapshots and historical labels
-- Used by feature generation and label generation services

-- Player feature snapshots: computed player features per event/market
CREATE TABLE IF NOT EXISTS player_feature_snapshots (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  event_time TEXT,
  sport_series_id INTEGER,
  position_value REAL,
  pnl_day REAL,
  pnl_week REAL,
  pnl_month REAL,
  pnl_all REAL,
  unit_size REAL,
  momentum_weight REAL,
  pnl_tier_weight REAL,
  stake_units REAL,
  computed_at INTEGER NOT NULL,
  UNIQUE(condition_id, wallet_address)
);

CREATE INDEX idx_player_features_condition ON player_feature_snapshots(condition_id);
CREATE INDEX idx_player_features_computed ON player_feature_snapshots(computed_at);

-- Market feature snapshots: computed market-level features
CREATE TABLE IF NOT EXISTS market_feature_snapshots (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  market_title TEXT NOT NULL,
  event_time TEXT,
  sport_series_id INTEGER,
  side_a_label TEXT,
  side_b_label TEXT,
  side_a_sharp_score REAL,
  side_b_sharp_score REAL,
  side_a_price REAL,
  side_b_price REAL,
  side_a_total_value REAL,
  side_b_total_value REAL,
  sharp_side TEXT,
  confidence TEXT,
  score_differential REAL,
  edge_rating INTEGER,
  market_volume REAL,
  market_liquidity REAL,
  holder_count_a INTEGER,
  holder_count_b INTEGER,
  computed_at INTEGER NOT NULL,
  UNIQUE(condition_id, computed_at)
);

CREATE INDEX idx_market_features_condition ON market_feature_snapshots(condition_id);
CREATE INDEX idx_market_features_sport ON market_feature_snapshots(sport_series_id);
CREATE INDEX idx_market_features_computed ON market_feature_snapshots(computed_at);

-- Historical matchup labels: outcome labels for model training
CREATE TABLE IF NOT EXISTS historical_matchup_labels (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL UNIQUE,
  market_title TEXT NOT NULL,
  event_time TEXT,
  sport_series_id INTEGER,
  sharp_side TEXT,
  sharp_side_price_at_pick REAL,
  confidence TEXT,
  edge_rating INTEGER,
  resolved_outcome TEXT,
  close_price REAL,
  roi REAL,
  clv REAL,
  labeled_at INTEGER NOT NULL
);

CREATE INDEX idx_matchup_labels_sport ON historical_matchup_labels(sport_series_id);
CREATE INDEX idx_matchup_labels_outcome ON historical_matchup_labels(resolved_outcome);
CREATE INDEX idx_matchup_labels_labeled ON historical_matchup_labels(labeled_at);
