-- Recon 2026-07-23 follow-up: book_source was hardcoded 'espn_draftkings'
-- even when ESPN's pickcenter had no DraftKings entry and a fallback
-- provider's odds were used. Pick-time source now reflects the actual
-- provider, and the close sweep records its provider separately so
-- mixed-book book_clv rows can be filtered in analyses.

ALTER TABLE manual_picks ADD COLUMN book_close_source TEXT;
