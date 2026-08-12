-- Close-signal capture (2026-08-12): re-run the sharp-money analysis
-- ~10 min before start for each pending pick and freeze the result, so
-- the n~100 audit can split "clean at pick, deteriorated by start" from
-- "clean throughout". Record-only — picking/holding behavior unchanged
-- (hold-never-churn stands); this builds the evidence an exit/last-look
-- rule would need before ever being pre-registered.

ALTER TABLE manual_picks ADD COLUMN close_signal_captured_at INTEGER;
ALTER TABLE manual_picks ADD COLUMN close_signal_json TEXT;
