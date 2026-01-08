-- Remove legacy wallet tracking, alerting, and cron state tables.

DROP TABLE IF EXISTS alert_deliveries;
DROP TABLE IF EXISTS alert_events;
DROP TABLE IF EXISTS wallet_watchers;
DROP TABLE IF EXISTS wallet_poll_state;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS email_contacts;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS wallet_positions_snapshot;
DROP TABLE IF EXISTS wallet_pnl_snapshots;
DROP TABLE IF EXISTS wallet_results;
DROP TABLE IF EXISTS wallet_sizing_snapshot;
DROP TABLE IF EXISTS position_alert_state;
DROP TABLE IF EXISTS position_alert_bucket;
DROP TABLE IF EXISTS cron_state;
