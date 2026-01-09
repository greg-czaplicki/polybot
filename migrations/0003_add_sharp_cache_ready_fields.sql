-- Add readiness fields to sharp money cache for staged updates.

ALTER TABLE sharp_money_cache ADD COLUMN pnl_coverage REAL;
ALTER TABLE sharp_money_cache ADD COLUMN is_ready INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sharp_money_ready ON sharp_money_cache(is_ready);
