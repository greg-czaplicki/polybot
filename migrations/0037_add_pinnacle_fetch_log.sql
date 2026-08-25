-- Free-tier budget pacing for the Pinnacle sweep (2026-08-25).
--
-- The Odds API free plan is 500 credits/month = ~250 sport fetches = ~8
-- per day across ALL sports. The sweep now spends against a hard daily
-- fetch cap tracked here (one row per Odds API request), shares one
-- per-sport feed cache across every capture kind, and records the feed
-- time on every capture so "how stale was this anchor/close" is a column,
-- not a guess.
CREATE TABLE IF NOT EXISTS pinnacle_fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at INTEGER NOT NULL,
  sport_key TEXT NOT NULL,
  credits_remaining INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pinnacle_fetch_log_at ON pinnacle_fetch_log (fetched_at);

ALTER TABLE manual_picks ADD COLUMN pin_feed_at INTEGER;
ALTER TABLE manual_picks ADD COLUMN pin_close_feed_at INTEGER;
ALTER TABLE shadow_candidates ADD COLUMN pin_close_feed_at INTEGER;
