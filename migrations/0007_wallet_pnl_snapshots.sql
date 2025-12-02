CREATE TABLE IF NOT EXISTS wallet_pnl_snapshots (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  open_cash_pnl REAL NOT NULL,
  open_position_value REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS wallet_pnl_snapshots_wallet_time_idx
  ON wallet_pnl_snapshots(wallet_address, captured_at);
