-- Cache for wallet unit size estimates (based on closed positions)
-- TTL handled in code; stores last computed median stake

CREATE TABLE IF NOT EXISTS wallet_unit_size_cache (
  wallet_address TEXT PRIMARY KEY,
  unit_size REAL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unit_size_cache_fetched_at ON wallet_unit_size_cache(fetched_at);
