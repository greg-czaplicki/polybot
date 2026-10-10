# Charter — NHL + soccer wallet backtests (`nhl_wallet_backtest`, `soccer_wallet_backtest`)

Written 2026-10-09 while both desktop backfills were still discovering markets, before any
wallet result for either sport. Rule is code: `research/sharp/totals_wallets.py` (cells A/B,
qualifiers S1–S6, HT, GOOD) plus the union rules of the NFL pass, read by
`research/sharp/totals_wallets.py` output and the S3SQ/HT lines of the combo pass. Owner
2026-10-09: "Open whatever lanes you think makes sense and let's keep going. Check soccer and NHL."

## populations (desktop, `fast_tape.py`, fills ≥ $50)
- NHL: `SPORTS=nhl`, 2025-10-01 … 2026-06-30 + 2026-09-28 … 2026-10-08.
  Split (as NBA): discovery start < 2026-02-01, holdout ≥ 2026-02-01 (`SPLIT=1769904000`).
- Soccer: `SPORTS=epl,lal,bun,sea,fl1,ucl,uel,mls,elc`, 2025-08-01 … 2026-10-08, binary
  markets only (3-way moneylines are negRisk and skipped by backfill). One pooled population;
  records per wallet across all listed leagues. Split: discovery < 2026-07-01 (2025-26 season),
  holdout ≥ (2026-27 + MLS 2026 late season).
Bet cells: game totals (token0 = Over), A cells at the first in-window fill 60–180 min out.

## PRIMARY (per sport): replication of the live wallet rules
- `A HT FOLLOW` (CFB lane rule) and `S3SQ` (NFL lane rule: team specialist on a side OR square
  on the other). A rule REPLICATES in a sport if ROI > 0 in both halves AND pooled
  game-clustered z ≥ 1.5 AND n ≥ 60. Replicates → $4 pilot lane for that sport (owner has
  pre-authorised pilot lanes, 2026-10-09).
- Every other cell: CANDIDATE rule as in `ncaaf-wallet-backtest.md` (disc n ≥ 50 |z| ≥ 2, holdout
  same sign |z| ≥ 1 n ≥ 30); anything else is exploratory.

## known_leakage_risks
As `ncaaf-wallet-backtest.md`. "No conflict" signals must be point-in-time (state from fills
before T) — the trigger-entry lookahead of 2026-10-09 is not repeated.
Soccer: totals lines other than 2.5 exist; team names carry suffixes ("FC") — parsed as-is.
