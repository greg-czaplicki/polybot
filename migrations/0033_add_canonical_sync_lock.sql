-- Single-row advisory lock for the scheduled canonical sync.
--
-- The scheduled handler's only overlap protection was a 5-minute cooldown
-- read from the last PERSISTED canonical_sync_runs row (written at run
-- completion). One slow run therefore disabled the cooldown entirely: while
-- it ran, every 2-minute cron tick saw a stale last-run timestamp and started
-- another concurrent sync, and the resulting D1 contention kept every run
-- slow — a self-sustaining pile-up first observed 2026-08-18 (runs pinned at
-- ~7 min in a loop that normally completes in ~12 s).
--
-- The lock is claimed atomically via
--   UPDATE ... SET locked_at = ?now WHERE id = 1 AND locked_at < ?now - 15min
-- (claim succeeds iff meta.changes = 1) and released by setting locked_at
-- back to 0 on completion. A run that dies without releasing self-heals
-- after the 15-minute expiry.
CREATE TABLE IF NOT EXISTS canonical_sync_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO canonical_sync_lock (id, locked_at) VALUES (1, 0);
