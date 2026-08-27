-- Unique ESPN event id on games (2026-08-28 review; 848-dup incident of
-- 2026-07-23 had only app-level lookup as defense). espn_event_id is the
-- true natural key: doubleheaders share (teams, game_time) but carry
-- distinct ESPN ids (verified: 654/654 distinct at migration time; the one
-- (teams, time) collision is a legitimate doubleheader). Partial index —
-- rows never linked to ESPN stay NULL. A racing duplicate insert now fails
-- loudly into the sync step error counts instead of silently forking the
-- game graph.
DROP INDEX IF EXISTS idx_games_espn_event;
CREATE UNIQUE INDEX idx_games_espn_event_unique
	ON games(espn_event_id)
	WHERE espn_event_id IS NOT NULL;
