-- Manual picks log for validation loop.

CREATE TABLE IF NOT EXISTS manual_picks (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  market_title TEXT NOT NULL,
  event_time TEXT,
  picked_at INTEGER NOT NULL,
  grade TEXT,
  signal_score REAL,
  edge_rating INTEGER,
  score_differential REAL,
  sharp_side TEXT,
  price REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_manual_picks_status ON manual_picks(status);
CREATE INDEX IF NOT EXISTS idx_manual_picks_picked_at ON manual_picks(picked_at DESC);
