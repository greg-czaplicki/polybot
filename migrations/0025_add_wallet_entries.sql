-- Wallet CLV foundation: observed top-holder position entries per market,
-- diffed between pipeline snapshots, settled against closing prices later.
-- Pure data collection — no picking behavior reads this yet.
CREATE TABLE wallet_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('A','B')),
  -- 'increase' = share growth vs previous snapshot; 'new_top20' = first
  -- appearance in the top-holder list (entry size is a lower bound, and the
  -- wallet may simply have crossed the top-20 cutoff — filter by kind in
  -- analysis).
  kind TEXT NOT NULL CHECK (kind IN ('increase','new_top20')),
  entry_price REAL NOT NULL,
  delta_usd REAL NOT NULL,
  total_usd REAL NOT NULL,
  observed_at INTEGER NOT NULL,
  event_time INTEGER NOT NULL,
  market_title TEXT NOT NULL,
  sport_series_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','void')),
  close_price REAL,
  clv REAL,
  settled_at INTEGER
);

CREATE INDEX idx_wallet_entries_status_event ON wallet_entries (status, event_time);
CREATE INDEX idx_wallet_entries_wallet ON wallet_entries (wallet_address);
CREATE INDEX idx_wallet_entries_condition ON wallet_entries (condition_id, side);
