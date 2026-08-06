-- Gate-vector instrumentation for the shadow book (2026-08-06).
--
-- The bot's gate chain early-returns on the first failing gate, so a shadow
-- row's reject_reason alone cannot say whether the candidate would have
-- passed the OTHER gates. Without that, per-gate shadow ROI overstates what
-- loosening a single gate would recover (a candidate rejected by two gates
-- is not admitted by loosening one). These columns capture the raw values
-- behind every global calibration gate at record time, plus the full
-- pass/fail vector as JSON:
--   gates_json = {"price_edge":{"value":..,"pass":..}, "edge_rating":{..},
--                 "signal_score":{..}, "score_differential":{..},
--                 "grade_vs_base":{"value":..,"threshold":..,"pass":..}}
-- pass is null when the input was unavailable at record time (NOT a pass).
-- Rows created before this migration have NULL in all five columns.
ALTER TABLE shadow_candidates ADD COLUMN price_edge REAL;
ALTER TABLE shadow_candidates ADD COLUMN fair_price REAL;
ALTER TABLE shadow_candidates ADD COLUMN edge_rating REAL;
ALTER TABLE shadow_candidates ADD COLUMN score_differential REAL;
ALTER TABLE shadow_candidates ADD COLUMN gates_json TEXT;
