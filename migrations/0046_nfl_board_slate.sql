-- NFL board slate (2026-09-19): the week's games with their main spread,
-- game total and moneyline straight from Polymarket's Gamma API, so the
-- board shows every game regardless of the holder pipeline's $10k volume
-- floor. Refreshed on demand (stale > 20 min) by src/server/api/nfl-board-slate.ts.
CREATE TABLE nfl_board_slate (
	event_slug TEXT PRIMARY KEY,
	season INTEGER NOT NULL,
	week INTEGER NOT NULL,
	kickoff INTEGER NOT NULL,
	title TEXT NOT NULL,
	away_abbr TEXT,
	home_abbr TEXT,
	away_name TEXT,
	home_name TEXT,
	spread_condition_id TEXT,
	spread_question TEXT,
	spread_line REAL,
	spread_a_label TEXT,
	spread_b_label TEXT,
	spread_a_price REAL,
	spread_b_price REAL,
	spread_alts INTEGER NOT NULL DEFAULT 0,
	total_condition_id TEXT,
	total_question TEXT,
	total_line REAL,
	total_a_price REAL,
	total_b_price REAL,
	total_alts INTEGER NOT NULL DEFAULT 0,
	ml_condition_id TEXT,
	ml_a_label TEXT,
	ml_b_label TEXT,
	ml_a_price REAL,
	ml_b_price REAL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX nfl_board_slate_week ON nfl_board_slate(season, week, kickoff);
