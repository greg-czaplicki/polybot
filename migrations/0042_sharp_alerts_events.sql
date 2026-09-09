-- Sharp alerts are now aggregated per (market, wallet, side) and grouped by event.
ALTER TABLE sharp_alerts ADD COLUMN event_key TEXT;
ALTER TABLE sharp_alerts ADD COLUMN market_type TEXT;
ALTER TABLE sharp_alerts ADD COLUMN fills INTEGER;
ALTER TABLE sharp_alerts ADD COLUMN hedge INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sharp_alerts_event ON sharp_alerts(event_key);
