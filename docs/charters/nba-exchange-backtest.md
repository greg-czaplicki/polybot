# Charter — NBA exchange backtest on the 2025-26 season (`nba_exchange_backtest`)

Written 2026-10-07, before any 2025-26 NBA tape was read, under the
`sports-modeling-doctrine` / `validation-design` schema. The rule is code:
`research/sharp/nba_backtest.py` (committed with this charter; run on the VPS
against `/root/polysharp/data/nba/nba_2025.db`). Changing a cell, band, split
date, entry definition or pass rule after the first run makes the result
exploratory and needs a new charter version.

## question
On last season's Polymarket NBA tape, are there price × time × market-type
cells (or NBA-specific situations) where a small taker who crossed the spread
made money, consistently enough to survive a time holdout — so that they can
be run as forward lanes from opening night 2026-10-20?

Context: the holder signal inverts in NBA (2026-05-11 forensic); the 9/11
exchange read saw a maker edge against 15m-3h taker buys in NBA (+13 c/$,
22k fills, mostly playoffs) — a lead, not evidence. Wallet-identity
follow/fade is NOT retested (dead across sports at executable prices,
2026-09-11). The holder-based fade stays with `fade-inversion.md` (live
top-holder data, forward from 2026-10-20); it is not reconstructed here.

## population_and_exclusions
`markets` rows in nba_2025.db (backfill of Gamma closed NBA moneyline / total
/ spread markets with volume ≥ $25k, tapes from data-api, prices from CLOB
prices-history), `status='done'`, `winner0 ∈ {0,1}`.
- Excluded: start < 2025-10-21T00:00Z (preseason); any market whose teams are
  not two of the 30 NBA franchises (All-Star / celebrity games).
- Fills: taker BUY fills with notional $5–$100 at fill price 0.20 ≤ p < 0.95,
  0–6 h before scheduled start (pregame only; no in-play cells).
- Big-taker cells: taker BUY notional > $500, same window.

## grain_and_natural_key
One observation = one (market, side, cell): the mean ROI of that side's
qualifying fills held to settlement. Clustered z by GAME (both teams +
start), so a game's moneyline, spreads and every alt total count as one
cluster. n printed in sides and in games.

## decision_time_and_horizon
Entry = the fill itself (an executable price somebody paid — never the
prices-history series, which is a bid/ask artifact). Features legal at the
fill: fill price, minutes to start, market type, side, the side's price 2 h
earlier (prices series, for the move cells), rest days (schedule is known in
advance). Horizon = settlement.

## cells (fixed list)
1. type; type × price band (20-40 / 40-50 / 50-60 / 60-80 / 80-95c);
   type × price × time (0-15m / 15-60m / 60-180m / 3-6h).
2. totals side (Over/Under), × time.
3. spread side (favourite = token0 / dog), × price.
4. moneyline 2-h move (shortening > 3c / drifting > 3c / flat) × price.
5. Rest: moneyline side on a back-to-back vs rested opponent, and the
   mirror; totals Over/Under when at least one team is on a back-to-back
   (B2B = the team's previous game started < 30 h earlier).
6. Big taker (> $500) × type × price.
Diagnostic only (no pass/fail): price drift fill → start for moneyline cells.

## split
DISCOVERY = start < 2026-02-01T00:00Z. HOLDOUT = start ≥ 2026-02-01
(includes the play-in and playoffs; a holdout-regular-season-only figure is
printed for information, never used to pass or fail).

## baselines
Zero ROI (the cell is efficient). The number of cells tested is printed with
the chance false-hit count.

## primary_metric_and_acceptance
Mean ROI per observation, game-clustered z.
CANDIDATE = discovery n ≥ 50 and |z| ≥ 2, AND holdout same sign with
|z| ≥ 1 and n ≥ 30. Everything else is noise and is not re-cut.
- A positive candidate becomes a forward paper lane in `cell_lanes.py`
  (start 2026-10-20T00:00Z), read at n ≥ 150 with ROI > 0 and clustered
  z ≥ 2. Real money only on the user's explicit go, as a capped pilot charter
  like `cs2-pickem-dog-pilot.md`.
- A negative candidate is a guard (a price band the live NBA book must avoid),
  read forward the same way before any era-gated gate.
- No candidate → the read is recorded as NO EDGE FOUND and NBA stays
  shadow-only apart from the fade-inversion test.

## data_requirements
Backfill complete (log `/root/polysharp/data/nba/backfill.log` reaches
2026-06-30 and no `pending` markets remain). The script prints coverage:
markets per month, share with prices, share with fills.

## known_leakage_risks
- Scheduled start from Gamma `gameStartTime`; a mis-recorded start would turn
  late pregame fills into in-play ones. Checked: fills in the 0-15m band are
  printed separately and the count of fills after start is reported.
- Alt totals/spreads share a game: handled by game clustering, not by
  counting each line as a bet.
- Survivorship: only markets with ≥ $25k volume were backfilled; the bot
  trades the same liquid set, so the population matches the use.
- The playoffs sit entirely in the holdout (different market regime); this
  can only make passing harder.
