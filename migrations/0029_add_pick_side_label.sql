-- Human-readable sharp-side outcome label on picks (2026-08-06), matching
-- migration 0028 on shadow_candidates. sharp_side 'A'/'B' is unreadable for
-- totals ("which side of the O/U am I on?"). New picks resolve the label
-- from sharp_money_cache at creation; existing totals rows are backfilled
-- from the sideA=Over/sideB=Under convention, others from the cache where
-- the market is still present.
ALTER TABLE manual_picks ADD COLUMN sharp_side_label TEXT;
