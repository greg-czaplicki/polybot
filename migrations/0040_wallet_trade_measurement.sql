ALTER TABLE wallet_trade_observations ADD COLUMN collection_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE wallet_trade_polls ADD COLUMN collection_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX wallet_trade_observations_close_due
  ON wallet_trade_observations(quote_status, event_time);

CREATE TABLE wallet_trade_market_metadata (
  condition_id TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  retry_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  snapshot_json TEXT,
  error TEXT
);

CREATE TABLE wallet_trade_close_books (
  condition_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  last_status TEXT NOT NULL,
  received_at INTEGER,
  book_at INTEGER,
  best_bid REAL,
  best_ask REAL,
  close_midpoint REAL,
  book_json TEXT,
  PRIMARY KEY(condition_id, token_id, event_time)
);

CREATE TABLE wallet_trade_measurements (
  trade_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('measured', 'missing_close', 'invalid_snapshot')),
  source TEXT,
  close_at INTEGER,
  close_price REAL,
  follow_clv REAL,
  relative_clv REAL,
  wallet_clv REAL,
  best_ask_clv REAL,
  settled_at INTEGER NOT NULL
);

ALTER TABLE wallet_trade_pilot ADD COLUMN maintenance_at INTEGER;
ALTER TABLE wallet_trade_pilot ADD COLUMN maintenance_json TEXT;
ALTER TABLE wallet_trade_pilot ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));
