-- Human-readable sharp-side outcome label on shadow rows (2026-08-06).
-- sharp_side is 'A'/'B', which is unreadable for totals markets ("which side
-- of the O/U are we on?"). Store the outcome label ("Over"/"Under"/team name)
-- at record time. Existing rows are backfilled from sharp_money_cache where
-- the market is still cached; rows whose market has left the cache stay NULL.
ALTER TABLE shadow_candidates ADD COLUMN sharp_side_label TEXT;
