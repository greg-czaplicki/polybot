CREATE TABLE IF NOT EXISTS position_alert_state (
  wallet_address TEXT NOT NULL,
  asset TEXT NOT NULL,
  last_alerted_value REAL NOT NULL DEFAULT 0,
  last_alerted_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet_address, asset)
);
