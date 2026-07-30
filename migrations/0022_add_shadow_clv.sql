-- Shadow CLV: closing price captured at settlement so gates are judged on
-- line movement, not just noisy outcome ROI. Must be captured promptly —
-- sharp_money_history prunes at 7 days.
ALTER TABLE shadow_candidates ADD COLUMN close_price REAL;
ALTER TABLE shadow_candidates ADD COLUMN clv REAL;
