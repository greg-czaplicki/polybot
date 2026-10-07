-- Era v19 (2026-10-07): NBA totals sharp-consensus FADE pilot. polysharp's
-- nba_fade_live.py (VPS, every 10 min) pushes one row per upcoming NBA game
-- total where >= 2 NBA-sharp wallets (record n >= 30, ROI >= +10%) bought
-- one side and none the other. The lane bets fade_label. voided = consensus
-- on both sides (no bet). Charter: docs/charters/nba-totals-fade-pilot.md.
CREATE TABLE nba_fade_signals (
	condition_id TEXT PRIMARY KEY,
	question TEXT,
	event_start INTEGER NOT NULL,
	consensus_label TEXT,
	fade_label TEXT,
	trigger_ts INTEGER,
	wallets_json TEXT,
	voided INTEGER NOT NULL DEFAULT 0,
	s1_over INTEGER,
	s1_under INTEGER,
	first_seen_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX nba_fade_signals_start ON nba_fade_signals(event_start);
