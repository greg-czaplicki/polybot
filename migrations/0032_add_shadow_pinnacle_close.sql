-- Pinnacle close proxy for shadow candidates (2026-08-12).
--
-- Gate-promotion decisions (pre-registered n>=50 sole-blocker checkpoint)
-- include a CLV>0 criterion that so far rests on Polymarket-close clv —
-- a weak benchmark (beating PM's own close only proves internal price
-- discovery). This adds the sharp-book yardstick to the shadow book:
-- pin_close_* captured by the same cron sweep as manual_picks pin
-- columns (close window opens ~10 min pre-start; close PROXY, not a
-- frozen line), sharing the per-sport Odds API fetch with pick captures.
-- pin_clv = pin_close_fair_prob - shadow price (same sign convention).
-- Close-only: no anchor capture for shadows (anchors would fetch on
-- every scan tick and blow the credit budget). Coverage from 2026-08-12.

ALTER TABLE shadow_candidates ADD COLUMN pin_close_captured_at INTEGER;
ALTER TABLE shadow_candidates ADD COLUMN pin_close_total_line REAL;
ALTER TABLE shadow_candidates ADD COLUMN pin_close_fair_prob REAL;
ALTER TABLE shadow_candidates ADD COLUMN pin_clv REAL;
