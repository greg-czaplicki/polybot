# NBA exchange backtest, 2025-26 season — 2026-10-07

Charter: `docs/charters/nba-exchange-backtest.md` (committed 6aa133d before
the first read). Script: `research/sharp/nba_backtest.py`. Full output:
`research/sharp/reads/2026-10-07-nba_backtest.txt`.

## Verdict: NO EDGE FOUND — 0 candidates from 123 cells

## Data
7,066 NBA markets (moneyline / total / spread, Gamma volume ≥ $25k) in 1,188
games, 2025-10-21 → 2026-06; 3.34M taker BUY fills; prices for 7,054. Discovery
729 games (< 2026-02-01), holdout 459 games. Backfill DB
`/root/polysharp/data/nba/nba_2025.db` (separate from the live polysharp DB).

## Results
- Market as a whole: small taker buys lose about what crossing the spread
  costs — moneyline +1.0% / −1.7%, spread −0.6% / −0.6%, total −2.1% / −0.2%
  (discovery / holdout). The drift diagnostic shows every moneyline band losing
  0.4–0.6c between fill and tip-off, which is the spread a taker pays.
- 15 cells hit |z| ≥ 2 in discovery (≈ 6 expected by chance at 123 tests).
  None held in the holdout. Most flipped sign: Over −12.1% → +7.1%, Under
  +8.1% → −7.6%, spread dogs +6.6% → −8.8%, totals 40-50c −8.9% → +2.5%,
  totals 50-60c 60-180m +5.5% → −3.4%, B2B Over −12.0% → +28.0%.
  Season-wide sign flips on Over/Under and favourite/dog are what
  league-wide scoring and favourite streaks do to correlated games; they are
  not a cell edge.
- Several holdout-only figures reach z ≥ 2 (moneyline 60-80c 3-6h +9.2%,
  B2B Over +28%, totals 20-40c +35.8%). They failed discovery, so by the
  charter they are noise and are NOT re-cut or forwarded.
- The 2026-09-11 lead (makers +13 c/$ against NBA taker buys) does not
  replicate on the full season: taker buys lose ~1%, so makers earn ~1 c/$,
  the spread.
- Moneyline back-to-back cells: ±10–14%, z ≤ 1.4 — nothing.

## Consequences
- No NBA forward cell lanes; no NBA guards. Nothing goes to `cell_lanes.py`.
- NBA stays shadow-only. The only open NBA test is the pre-registered
  holder-signal fade (`docs/charters/fade-inversion.md`), forward from opening
  night 2026-10-20, first read at n ≥ 100 (~mid-Nov).
- Do not re-cut this tape for new NBA cells. A second season (2026-27) can be
  run through the same script unchanged as a replication.
