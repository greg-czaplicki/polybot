ALTER TABLE wallet_positions_snapshot
  ADD COLUMN sport_tag TEXT;

ALTER TABLE wallet_results
  ADD COLUMN sport_tag TEXT;

CREATE INDEX IF NOT EXISTS wallet_results_wallet_sport_idx
  ON wallet_results(wallet_address, sport_tag);
