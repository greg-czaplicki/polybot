-- Backfill historical wallet_results rows that never captured the true event end
-- timestamp. Many Polymarket slugs embed the settlement date as -YYYY-MM-DD, so
-- use that pattern when available.
UPDATE wallet_results
SET
  event_end_timestamp = strftime(
    '%s',
    substr(event_slug, instr(event_slug, '-20') + 1, 10) || ' 00:00:00'
  ),
  resolved_at = strftime(
    '%s',
    substr(event_slug, instr(event_slug, '-20') + 1, 10) || ' 00:00:00'
  )
WHERE event_end_timestamp IS NULL
  AND event_slug LIKE '%-20__-__-__%'
  AND instr(event_slug, '-20') > 0
  AND LENGTH(event_slug) >= instr(event_slug, '-20') + 10
  AND resolved_at > strftime(
    '%s',
    substr(event_slug, instr(event_slug, '-20') + 1, 10) || ' 00:00:00'
  ) + 21600;
