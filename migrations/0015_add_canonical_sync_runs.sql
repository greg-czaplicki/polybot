-- Canonical sync run tracking for pipeline automation (Phase 6).
-- Records each automated sync cycle's results for freshness/status visibility.

CREATE TABLE IF NOT EXISTS canonical_sync_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success', 'partial', 'failed')),
  steps_json TEXT NOT NULL,
  games_processed INTEGER NOT NULL DEFAULT 0,
  facts_computed INTEGER NOT NULL DEFAULT 0,
  picks_backfilled INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_canonical_sync_runs_started ON canonical_sync_runs(started_at DESC);
