-- Persist The Odds API credits-remaining on each feed fetch (2026-08-25) so
-- the burn rate is readable from D1 on demand instead of only via a live
-- `wrangler tail` (which costs attention every sweep). Written alongside
-- the per-sport feed; the newest fetched_at row carries the current value.
ALTER TABLE pinnacle_feed_cache ADD COLUMN credits_remaining INTEGER;
