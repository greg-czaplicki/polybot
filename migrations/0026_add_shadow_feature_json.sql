-- 2026-08-04 deep-dive follow-up: persist the signal-score component
-- breakdown and the sharp-side top-holder roster on shadow rows, so gate
-- calibration and wallet-CLV joins can use rejected candidates too.
-- Data collection only — nothing gates on these.
ALTER TABLE shadow_candidates ADD COLUMN signal_components_json TEXT;
ALTER TABLE shadow_candidates ADD COLUMN top_holders_json TEXT;
