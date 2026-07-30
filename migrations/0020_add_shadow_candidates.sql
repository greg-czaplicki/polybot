-- Shadow book: policy-gate-rejected candidates recorded at first sight and
-- settled like real picks (no bet placed). Exists to make hard gates
-- falsifiable — without it, excluded windows/sports never produce outcomes
-- and every gate is untestable forever.
CREATE TABLE IF NOT EXISTS shadow_candidates (
	id TEXT PRIMARY KEY,
	condition_id TEXT NOT NULL,
	reject_reason TEXT NOT NULL,
	market_title TEXT NOT NULL,
	market_type TEXT,
	sport_series_id INTEGER,
	sport_tag TEXT,
	sharp_side TEXT,
	price REAL,
	grade TEXT,
	base_min_grade TEXT,
	signal_score REAL,
	market_quality_score REAL,
	minutes_to_start REAL,
	event_time INTEGER,
	strategy_version TEXT,
	created_at INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	resolved_outcome TEXT,
	roi REAL,
	settled_at INTEGER,
	UNIQUE(condition_id, reject_reason)
);

CREATE INDEX IF NOT EXISTS idx_shadow_candidates_status_event
	ON shadow_candidates(status, event_time);
CREATE INDEX IF NOT EXISTS idx_shadow_candidates_reason
	ON shadow_candidates(reject_reason);
