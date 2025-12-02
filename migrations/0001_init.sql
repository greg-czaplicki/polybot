-- Users represent anonymous or future-authenticated people who configure alerts
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Each watched wallet has customizable thresholds per user
CREATE TABLE IF NOT EXISTS wallet_watchers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  nickname TEXT,
  single_trade_threshold_usd REAL,
  accumulation_threshold_usd REAL,
  accumulation_window_seconds INTEGER NOT NULL DEFAULT 3600,
  min_trades INTEGER NOT NULL DEFAULT 1,
  notify_channels TEXT NOT NULL DEFAULT '[]',
  last_triggered_at INTEGER,
  last_seen_trade_timestamp INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT wallet_watchers_unique UNIQUE(user_id, wallet_address)
);

CREATE INDEX IF NOT EXISTS wallet_watchers_user_idx
  ON wallet_watchers(user_id);

-- Persist recent alerts for audit + duplicate suppression
CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_value REAL NOT NULL,
  trade_count INTEGER NOT NULL,
  payload TEXT NOT NULL,
  triggered_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY(watcher_id) REFERENCES wallet_watchers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS alert_events_watcher_idx
  ON alert_events(watcher_id);

-- Track delivery outcomes (push/email/etc)
CREATE TABLE IF NOT EXISTS alert_deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  response TEXT,
  sent_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(alert_id) REFERENCES alert_events(id) ON DELETE CASCADE
);

-- Store push notification endpoints for web push fan-out
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT push_subscriptions_unique_endpoint UNIQUE(endpoint)
);

-- Optional email delivery targets
CREATE TABLE IF NOT EXISTS email_contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT email_contacts_unique_email UNIQUE(email)
);

-- Maintain per-wallet polling cursor to avoid reprocessing fills
CREATE TABLE IF NOT EXISTS wallet_poll_state (
  wallet_address TEXT PRIMARY KEY,
  last_trade_timestamp INTEGER,
  last_run_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
