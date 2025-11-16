ALTER TABLE wallet_watchers
  ADD COLUMN last_position_value_notified REAL NOT NULL DEFAULT 0;

