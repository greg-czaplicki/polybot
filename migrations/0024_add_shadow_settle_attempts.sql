-- Settlement retry bookkeeping for shadow candidates. Rows whose Gamma market
-- never resolves (postponed/canceled and delisted games) previously occupied
-- the head of the event_time-ordered settle queue on every tick; with enough
-- of them the LIMIT batch starves and shadow settlement halts silently.
-- Track attempts so fresh rows settle first and repeatedly-failing rows retry
-- on a backoff instead of blocking.
ALTER TABLE shadow_candidates ADD COLUMN settle_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shadow_candidates ADD COLUMN last_checked_at INTEGER;
