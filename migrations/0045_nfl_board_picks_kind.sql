-- NFL board v2 (2026-09-19): totals join spreads. One pick per game per
-- market kind ('spread' | 'total'), so the unique key becomes
-- (event_slug, kind). SQLite cannot alter a UNIQUE constraint, so the table
-- is rebuilt; existing rows (none at the time) are carried as 'spread'.
CREATE TABLE nfl_board_picks_v2 (
	id TEXT PRIMARY KEY,
	season INTEGER NOT NULL,
	week INTEGER NOT NULL,
	event_slug TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'spread',
	condition_id TEXT NOT NULL,
	market_title TEXT NOT NULL,
	matchup TEXT NOT NULL,
	side TEXT NOT NULL,
	side_label TEXT NOT NULL,
	line REAL NOT NULL,
	price REAL NOT NULL,
	event_time INTEGER NOT NULL,
	picked_at INTEGER NOT NULL,
	signal_side TEXT,
	signal_price REAL,
	status TEXT NOT NULL DEFAULT 'pending',
	resolved_outcome TEXT,
	roi REAL,
	settled_at INTEGER,
	settle_attempts INTEGER NOT NULL DEFAULT 0,
	last_checked_at INTEGER,
	UNIQUE(event_slug, kind)
);
INSERT INTO nfl_board_picks_v2 (id, season, week, event_slug, kind, condition_id, market_title, matchup, side, side_label, line, price, event_time, picked_at, signal_side, signal_price, status, resolved_outcome, roi, settled_at, settle_attempts, last_checked_at)
SELECT id, season, week, event_slug, 'spread', condition_id, market_title, matchup, side, side_label, line, price, event_time, picked_at, signal_side, signal_price, status, resolved_outcome, roi, settled_at, settle_attempts, last_checked_at FROM nfl_board_picks;
DROP TABLE nfl_board_picks;
ALTER TABLE nfl_board_picks_v2 RENAME TO nfl_board_picks;
CREATE INDEX nfl_board_picks_week ON nfl_board_picks(season, week, event_time);
CREATE INDEX nfl_board_picks_status ON nfl_board_picks(status, event_time);
