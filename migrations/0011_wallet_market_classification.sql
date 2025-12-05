ALTER TABLE wallet_positions_snapshot
  ADD COLUMN opened_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE wallet_positions_snapshot
  ADD COLUMN event_end_timestamp INTEGER;

ALTER TABLE wallet_results
  ADD COLUMN bet_type TEXT;

ALTER TABLE wallet_results
  ADD COLUMN horizon_bucket TEXT;

ALTER TABLE wallet_results
  ADD COLUMN event_end_timestamp INTEGER;

ALTER TABLE wallet_results
  ADD COLUMN opened_at INTEGER;

CREATE INDEX IF NOT EXISTS wallet_results_wallet_bet_idx
  ON wallet_results(wallet_address, sport_tag, bet_type, horizon_bucket);
