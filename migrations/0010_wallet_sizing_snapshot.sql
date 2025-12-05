CREATE TABLE IF NOT EXISTS wallet_sizing_snapshot (
  wallet_address TEXT PRIMARY KEY,
  avg_initial_size REAL NOT NULL DEFAULT 0,
  position_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
