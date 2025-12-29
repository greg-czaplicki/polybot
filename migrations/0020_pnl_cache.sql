-- Cache for wallet PnL data to avoid hitting Cloudflare subrequest limits
-- TTL of 1 hour (3600 seconds)

CREATE TABLE IF NOT EXISTS wallet_pnl_cache (
  wallet_address TEXT PRIMARY KEY,
  pnl_day REAL,
  pnl_week REAL,
  pnl_month REAL,
  pnl_all REAL,
  volume REAL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pnl_cache_fetched_at ON wallet_pnl_cache(fetched_at);

