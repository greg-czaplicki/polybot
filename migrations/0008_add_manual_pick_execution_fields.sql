-- Add decision snapshot + execution quality fields for bot analytics.

ALTER TABLE manual_picks ADD COLUMN strategy_version TEXT;
ALTER TABLE manual_picks ADD COLUMN threshold_used REAL;
ALTER TABLE manual_picks ADD COLUMN market_quality_score REAL;
ALTER TABLE manual_picks ADD COLUMN warnings_json TEXT;
ALTER TABLE manual_picks ADD COLUMN decision_snapshot_json TEXT;
ALTER TABLE manual_picks ADD COLUMN candidate_computed_at INTEGER;
ALTER TABLE manual_picks ADD COLUMN execution_submitted_at INTEGER;
ALTER TABLE manual_picks ADD COLUMN execution_filled_at INTEGER;
ALTER TABLE manual_picks ADD COLUMN fill_status TEXT;
ALTER TABLE manual_picks ADD COLUMN fill_price REAL;
ALTER TABLE manual_picks ADD COLUMN fill_size REAL;
ALTER TABLE manual_picks ADD COLUMN fill_notional REAL;
ALTER TABLE manual_picks ADD COLUMN fill_slippage_bps REAL;
ALTER TABLE manual_picks ADD COLUMN order_id TEXT;
ALTER TABLE manual_picks ADD COLUMN exchange_trade_id TEXT;
ALTER TABLE manual_picks ADD COLUMN execution_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_manual_picks_fill_status ON manual_picks(fill_status);
CREATE INDEX IF NOT EXISTS idx_manual_picks_execution_filled_at ON manual_picks(execution_filled_at DESC);
