-- Sharp-wallet fill alerts pushed by the VPS polysharp pipeline (POST /api/bot/sharp-alerts).
-- One row per (market, tx, wallet, side, price); the terminal shows upcoming markets only.
CREATE TABLE sharp_alerts (
	id TEXT PRIMARY KEY,
	condition_id TEXT NOT NULL,
	question TEXT,
	sport TEXT,
	side_label TEXT,
	start INTEGER NOT NULL,
	ts INTEGER NOT NULL,
	wallet TEXT NOT NULL,
	side INTEGER NOT NULL,
	price REAL,
	usd REAL,
	wallet_roi_t REAL,
	wallet_markets INTEGER,
	wallet_roi REAL,
	streak REAL,
	sq_opp_usd REAL,
	received_at INTEGER NOT NULL
);
CREATE INDEX sharp_alerts_start ON sharp_alerts(start);
