-- Bot candidate cohort snapshots.
-- Stores production candidate scan summaries so selection behavior can be tracked over time.

CREATE TABLE IF NOT EXISTS bot_candidate_snapshots (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  min_grade TEXT NOT NULL,
  window_minutes INTEGER,
  min_minutes_to_start INTEGER,
  max_minutes_to_start INTEGER,
  require_ready INTEGER NOT NULL DEFAULT 1,
  include_started INTEGER NOT NULL DEFAULT 0,
  require_microstructure INTEGER NOT NULL DEFAULT 1,
  market_quality_threshold REAL NOT NULL,
  requested INTEGER NOT NULL DEFAULT 0,
  returned INTEGER NOT NULL DEFAULT 0,
  total_entries INTEGER NOT NULL DEFAULT 0,
  upcoming_entries INTEGER NOT NULL DEFAULT 0,
  candidates_before_dedup INTEGER NOT NULL DEFAULT 0,
  returned_after_dedup INTEGER NOT NULL DEFAULT 0,
  excluded_json TEXT NOT NULL,
  policy_matched_json TEXT NOT NULL,
  returned_by_market_type_json TEXT NOT NULL,
  returned_by_timing_bucket_json TEXT NOT NULL,
  returned_by_sport_series_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_candidate_snapshots_created
  ON bot_candidate_snapshots(created_at DESC);
