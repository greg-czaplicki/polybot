-- Add sports-specific open PnL tracking to wallet_pnl_snapshots
-- This allows filtering unrealized PnL by sports vs non-sports markets

ALTER TABLE wallet_pnl_snapshots ADD COLUMN open_sports_cash_pnl REAL NOT NULL DEFAULT 0;
ALTER TABLE wallet_pnl_snapshots ADD COLUMN open_sports_position_value REAL NOT NULL DEFAULT 0;
