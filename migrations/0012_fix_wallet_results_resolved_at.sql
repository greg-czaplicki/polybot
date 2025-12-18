-- Align historical wallet result timestamps with their underlying event end
-- when they were previously defaulted to the cron execution time.
UPDATE wallet_results
SET resolved_at = event_end_timestamp
WHERE event_end_timestamp IS NOT NULL
  AND resolved_at > event_end_timestamp + 21600;
