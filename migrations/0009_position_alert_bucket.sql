ALTER TABLE position_alert_state
  ADD COLUMN last_alerted_bucket INTEGER NOT NULL DEFAULT 0;
