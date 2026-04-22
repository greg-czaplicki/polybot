-- Daily stats snapshots.
-- Persists compact per-day pick performance and candidate funnel rollups.

CREATE TABLE IF NOT EXISTS daily_stats_snapshots (
  day_key TEXT PRIMARY KEY,
  window_start_at INTEGER NOT NULL,
  window_end_at INTEGER NOT NULL,
  snapshot_created_at INTEGER NOT NULL,
  manual_picks_json TEXT NOT NULL,
  candidate_funnel_json TEXT NOT NULL,
  drift_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_stats_snapshots_created
  ON daily_stats_snapshots(snapshot_created_at DESC);
