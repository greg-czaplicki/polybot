CREATE TABLE wallet_trade_pilot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enrolled_at INTEGER,
  expires_at INTEGER,
  cohort_json TEXT,
  cursor INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO wallet_trade_pilot (id) VALUES (1);

CREATE TABLE wallet_trade_polls (
  run_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  report_json TEXT,
  error TEXT
);

CREATE TABLE wallet_trade_observations (
  trade_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
  outcome TEXT NOT NULL,
  trade_at INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  wallet_price REAL NOT NULL,
  shares REAL NOT NULL,
  notional REAL NOT NULL,
  sport TEXT,
  event_time INTEGER,
  market_side TEXT,
  market_snapshot_json TEXT,
  quote_status TEXT NOT NULL,
  quote_received_at INTEGER,
  book_at INTEGER,
  best_bid REAL,
  best_ask REAL,
  follow_price REAL,
  follow_shares REAL,
  book_json TEXT
);
CREATE INDEX wallet_trade_observations_sport_time
  ON wallet_trade_observations (sport, detected_at);
CREATE INDEX wallet_trade_observations_wallet_time
  ON wallet_trade_observations (wallet_address, trade_at);

-- Tombstones prevent a locally capped trade receiving a later substitute quote.
CREATE TABLE wallet_trade_skips (
  trade_key TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  trade_at INTEGER NOT NULL,
  detected_at INTEGER NOT NULL
);
CREATE INDEX wallet_trade_skips_wallet_time ON wallet_trade_skips(wallet_address, trade_at);
