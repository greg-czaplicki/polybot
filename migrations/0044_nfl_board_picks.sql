-- NFL board (2026-09-19): the operator's own against-the-spread picks on the
-- weekly Polymarket NFL slate. Nothing here reaches the bot; the table is a
-- season-long record of a human picker graded through the same Gamma
-- resolution path as picks and shadows. One pick per game per week
-- (event_slug unique) — re-picking before kickoff replaces the row.
CREATE TABLE nfl_board_picks (
	id TEXT PRIMARY KEY,
	season INTEGER NOT NULL,
	week INTEGER NOT NULL,
	event_slug TEXT NOT NULL UNIQUE,
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
	last_checked_at INTEGER
);
CREATE INDEX nfl_board_picks_week ON nfl_board_picks(season, week, event_time);
CREATE INDEX nfl_board_picks_status ON nfl_board_picks(status, event_time);
