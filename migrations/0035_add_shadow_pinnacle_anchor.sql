-- Pinnacle ANCHOR (pick-time) proxy for shadow candidates (2026-08-25).
--
-- Migration 0032 gave shadows a Pinnacle CLOSE only, deliberately skipping
-- anchors because shadows are created on every bot poll and an anchor
-- fetch per sweep per sport would burn ~1,000 Odds API fetches/day/sport.
-- This adds the anchor with a credit-safe design:
--   * pinnacle_feed_cache holds the last per-sport event feed; shadow
--     anchors read it while it is younger than the sweep's TTL (~20 min)
--     and only refetch when stale, so anchor cost is bounded by
--     active-hours / TTL per sport instead of by sweep cadence.
--   * pin_feed_at records the feed's fetch time so the anchor's staleness
--     relative to the sighting (pin_captured_at) is auditable.
--   * pin_ev = pin_fair_prob / price - 1 (same convention as manual_picks).
-- Purpose: a second, holder-independent signal ("price beats Pinnacle's
-- devigged number") measurable per sport in the shadow book — the
-- pre-registered pin_edge gate test in docs/STRATEGY.md. Coverage from
-- 2026-08-25 evening; timing-reject rows (outside_window,
-- too_close_to_start, not_ready) are not anchored.

ALTER TABLE shadow_candidates ADD COLUMN pin_captured_at INTEGER;
ALTER TABLE shadow_candidates ADD COLUMN pin_feed_at INTEGER;
ALTER TABLE shadow_candidates ADD COLUMN pin_total_line REAL;
ALTER TABLE shadow_candidates ADD COLUMN pin_fair_prob REAL;
ALTER TABLE shadow_candidates ADD COLUMN pin_ev REAL;

CREATE TABLE IF NOT EXISTS pinnacle_feed_cache (
  sport_tag TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  events_json TEXT NOT NULL
);
