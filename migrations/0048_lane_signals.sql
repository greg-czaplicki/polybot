-- Era v21 (2026-10-09): generic pushed wallet signals for second-family
-- lanes (first user: cfb_hot_follow). A VPS job pushes the CURRENT state
-- for its lane; rows of that lane for upcoming events not re-pushed are
-- cleared (bet_label NULL). bet_label = the side the lane bets; voided =
-- signal on both sides (no bet). first_seen_at = first push (when the app
-- could first act). Charter: docs/charters/cfb-hot-follow-pilot.md.
CREATE TABLE lane_signals (
	lane TEXT NOT NULL,
	condition_id TEXT NOT NULL,
	question TEXT,
	event_start INTEGER NOT NULL,
	bet_label TEXT,
	trigger_ts INTEGER,
	voided INTEGER NOT NULL DEFAULT 0,
	detail_json TEXT,
	first_seen_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (lane, condition_id)
);
CREATE INDEX lane_signals_lane_start ON lane_signals(lane, event_start);
