-- Add event_time column to sharp_money_cache
-- Stores the ISO date string for when the event starts/ends

ALTER TABLE sharp_money_cache ADD COLUMN event_time TEXT;
