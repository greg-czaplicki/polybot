-- Small key-value store for bot-reported runtime state (bankroll, stake
-- mode). The bot is the only writer (POST /api/bot/status); the dashboard
-- reads it. Kept generic so future bot-side status fits without migrations.
CREATE TABLE bot_runtime_status (
	key TEXT PRIMARY KEY,
	value_json TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
