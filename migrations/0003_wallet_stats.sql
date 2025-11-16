-- Per-wallet resolved market results (sports-focused)
CREATE TABLE IF NOT EXISTS wallet_results (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  asset TEXT NOT NULL,
  title TEXT,
  event_slug TEXT,
  resolved_at INTEGER NOT NULL,
  pnl_usd REAL NOT NULL,
  result TEXT NOT NULL,
  is_sports INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS wallet_results_wallet_resolved_idx
  ON wallet_results(wallet_address, resolved_at);

-- Snapshots of currently open positions so we can detect when they close
CREATE TABLE IF NOT EXISTS wallet_positions_snapshot (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  asset TEXT NOT NULL,
  title TEXT,
  event_slug TEXT,
  is_sports INTEGER NOT NULL DEFAULT 0,
  last_size REAL NOT NULL,
  last_current_value REAL NOT NULL,
  last_cash_pnl REAL NOT NULL,
  last_percent_pnl REAL NOT NULL,
  last_seen_at INTEGER NOT NULL,
  CONSTRAINT wallet_positions_snapshot_unique UNIQUE(wallet_address, asset)
);

CREATE INDEX IF NOT EXISTS wallet_positions_snapshot_wallet_idx
  ON wallet_positions_snapshot(wallet_address);

