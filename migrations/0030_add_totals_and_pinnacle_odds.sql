-- Totals de-vig + Pinnacle benchmark columns (2026-08-11).
--
-- (1) DK totals prices: ESPN pickcenter carries overOdds/underOdds, so the
-- existing anchor/close capture can de-vig totals picks side-aware. The
-- fair-prob/CLV columns (book_fair_prob, book_clv, ...) are shared with ML
-- and now populate for totals too — but ONLY when the book's total line
-- equals the pick market's line (an Over 8.5 fair prob says nothing about
-- Over 7.5); raw odds are stored regardless.
--
-- (2) Pinnacle (via The Odds API, env ODDS_API_KEY): sharp-book benchmark
-- for ML + totals picks. pin_* = anchor captured within ~2 min of pick
-- creation by the cron sweep; pin_close_* = last pre-start capture
-- (sweep window opens 10 min before event_time — a close PROXY, not a
-- frozen closing line). pin_clv = pin_close_fair_prob − pick price.
-- All odds stored as American prices on the PICK's side/opposite.

ALTER TABLE manual_picks ADD COLUMN book_total_over_odds REAL;
ALTER TABLE manual_picks ADD COLUMN book_total_under_odds REAL;
ALTER TABLE manual_picks ADD COLUMN book_close_total_over_odds REAL;
ALTER TABLE manual_picks ADD COLUMN book_close_total_under_odds REAL;

ALTER TABLE manual_picks ADD COLUMN pin_captured_at INTEGER;
ALTER TABLE manual_picks ADD COLUMN pin_ml_side REAL;
ALTER TABLE manual_picks ADD COLUMN pin_ml_opp REAL;
ALTER TABLE manual_picks ADD COLUMN pin_total_line REAL;
ALTER TABLE manual_picks ADD COLUMN pin_total_over_odds REAL;
ALTER TABLE manual_picks ADD COLUMN pin_total_under_odds REAL;
ALTER TABLE manual_picks ADD COLUMN pin_fair_prob REAL;
ALTER TABLE manual_picks ADD COLUMN pin_ev REAL;
ALTER TABLE manual_picks ADD COLUMN pin_close_captured_at INTEGER;
ALTER TABLE manual_picks ADD COLUMN pin_close_ml_side REAL;
ALTER TABLE manual_picks ADD COLUMN pin_close_ml_opp REAL;
ALTER TABLE manual_picks ADD COLUMN pin_close_total_line REAL;
ALTER TABLE manual_picks ADD COLUMN pin_close_total_over_odds REAL;
ALTER TABLE manual_picks ADD COLUMN pin_close_total_under_odds REAL;
ALTER TABLE manual_picks ADD COLUMN pin_close_fair_prob REAL;
ALTER TABLE manual_picks ADD COLUMN pin_clv REAL;
