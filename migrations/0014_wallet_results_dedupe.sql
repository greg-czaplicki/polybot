-- Remove duplicate wallet_results rows so that each wallet + asset pair is only counted once
WITH ranked AS (
  SELECT
    rowid,
    ROW_NUMBER() OVER (
      PARTITION BY wallet_address, asset
      ORDER BY resolved_at DESC, rowid DESC
    ) AS rn
  FROM wallet_results
)
DELETE FROM wallet_results
WHERE rowid IN (
  SELECT rowid
  FROM ranked
  WHERE rn > 1
);

-- Enforce uniqueness for future inserts
CREATE UNIQUE INDEX IF NOT EXISTS wallet_results_wallet_asset_unique
  ON wallet_results(wallet_address, asset);
