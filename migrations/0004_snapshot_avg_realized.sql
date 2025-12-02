ALTER TABLE wallet_positions_snapshot
  ADD COLUMN last_avg_price REAL NOT NULL DEFAULT 0;

ALTER TABLE wallet_positions_snapshot
  ADD COLUMN last_realized_pnl REAL NOT NULL DEFAULT 0;
