-- Sportsbook anchor columns (de-vigged DraftKings via ESPN pickcenter).
-- Diagnostic only — no picking behavior reads these (no strategy era bump).
--
-- Pick-time snapshot (book_*) is captured inline at pick creation from a live
-- ESPN summary fetch; close snapshot (book_close_*) is captured post-game by
-- the scheduled sweep in pipeline/book-odds.ts. book_fair_prob is the
-- two-way multiplicative de-vig of the picked side's moneyline; it is only
-- populated for moneyline picks. book_clv = book_close_fair_prob - entry
-- price (same sign convention as clv: positive = beat the close).

ALTER TABLE games ADD COLUMN espn_event_id TEXT;
CREATE INDEX IF NOT EXISTS idx_games_espn_event ON games(espn_event_id);

ALTER TABLE manual_picks ADD COLUMN book_source TEXT;
ALTER TABLE manual_picks ADD COLUMN book_captured_at INTEGER;
ALTER TABLE manual_picks ADD COLUMN book_ml_side INTEGER;
ALTER TABLE manual_picks ADD COLUMN book_ml_opp INTEGER;
ALTER TABLE manual_picks ADD COLUMN book_fair_prob REAL;
ALTER TABLE manual_picks ADD COLUMN book_ev REAL;
ALTER TABLE manual_picks ADD COLUMN book_spread_line REAL;
ALTER TABLE manual_picks ADD COLUMN book_total_line REAL;
ALTER TABLE manual_picks ADD COLUMN book_close_captured_at INTEGER;
ALTER TABLE manual_picks ADD COLUMN book_close_ml_side INTEGER;
ALTER TABLE manual_picks ADD COLUMN book_close_ml_opp INTEGER;
ALTER TABLE manual_picks ADD COLUMN book_close_fair_prob REAL;
ALTER TABLE manual_picks ADD COLUMN book_close_spread_line REAL;
ALTER TABLE manual_picks ADD COLUMN book_close_total_line REAL;
ALTER TABLE manual_picks ADD COLUMN book_clv REAL;
