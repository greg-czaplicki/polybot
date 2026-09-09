# polysharp — sharp-money pipeline on the exchange tape (deployed 2026-09-09)

Replaces the shadow book as the instrument for wallet/sharp-money questions.
Code: `research/sharp/polysharp.py`; VPS `/root/polysharp` (uses polyarb venv);
timers `polysharp-daily` (11:45 UTC) and `polysharp-live` (every 10 min);
reports in `/root/polysharp/data/reports/`. Seeded with the 3,378-market crawl.

## What it does

- **Universe:** every pregame market the book recorder tracks (Gamma top-2100
  by volume with a game start in the next 24h) plus the seed.
- **Crawl:** once a market is 4h past start, pull its full Data-API tape,
  1-min prices (start−6h..+1h) and the CLOB winner.
- **Wallet scores, weekly as-of snapshots (Mondays 00:00 UTC):** per wallet,
  on settled pregame fills collapsed to ONE observation per market
  (usd-weighted): n markets, ROI mean and t, CLV mean and t, $ traded,
  trailing-20-market form, 7d/30d $ P&L, median fill size, per-sport record.
  Sharp = top decile of ROI t among wallets with ≥ 20 markets; square = bottom
  decile. A fill is scored with the latest snapshot at or before its own time.
- **Signals:** one row per market = first sharp fill ≥ $100 more than 15 min
  before start, with features at that moment: wallet t, streak, size vs the
  wallet's median, square $ on the opposite side, crowd net flow, minutes to
  start. Settled with follow ROI (entry = fill + 0.5c, fee observed 0 on the
  wire) and CLV to the start price.
- **Live:** polls markets starting within 3h every 10 min; sharp fills become
  alerts with the same features.

## Lessons baked in

- Per-fill t-stats are degenerate (a wallet with 24 identical fills in one
  market scored t ≈ 10^16). Scoring is per market. The earlier fill-level
  feature results (squares-opposite +29%, hot & big +33%) were partly this.
- Report only one bet per market; show last-14d vs before as the OOS check.

## First report (9/9, 1,892 signals, per-market scoring)

ALL: ROI −1.5% (z −0.6), CLV +0.4c (z 5.3). MLB −0.4% / +0.5c (z 6.3). No
feature cut is positive and stable; squares-opposite is −27% (n=57). Sharp
list: 276 wallets, ROI t 1.2–4.3, top wallet 21 markets +74% ROI, another 103
MLB markets +26% and +$115k 30d. First live pass: 47 upcoming markets, 17
sharp alerts (MLB ML/totals, ATP, CS2).

The standing read: sharp wallets carry ~0.5c of closing-line edge and no
bettable ROI at these samples. The pipeline exists to detect the moment
that changes, per sport, within weeks (NFL regular season is the registered
cell), and to feed a passive-entry executor if it does.

## Same-day fix: events, repeat fills, hedgers

The first tape showed one wallet's seven fills on Seahawks −4.5 as seven rows
and one game as nine markets, including a wallet running a totals middle
(Over 42.5 + Under 44.5/46.5). Changes:

- **Events.** Markets are grouped into events by (sport, start) plus shared
  team tokens (surname/team word parsed from the question; spreads and team
  totals carry one team, moneylines and totals both). 3,759 markets → one
  event key each; 732 events have several markets.
- **Market types.** moneyline / total / spread / team_total / period / prop
  from the question text (old crawl had only ML/total).
- **Signals are one per EVENT**, on main lines only (moneyline, or the
  event's largest-volume total). A wallet holding opposing directions inside
  the event (both teams, or Over and Under across the totals ladder) is a
  hedger and cannot fire a signal. Signal count fell 1,892 → 835; ALL ROI
  +0.4%, CLV +0.3c (z 2.6).
- **Live alerts are aggregated** per (market, wallet, side): total $, fill
  count, VWAP, latest time, hedge flag. Pushed as an upsert; D1 id =
  market:wallet:side (migration 0042 adds event_key, market_type, fills,
  hedge). The terminal groups rows by event with a header line and dims
  hedged positions.

Patriots–Seahawks on 9/9: 19 positions across 9 markets; 12 flagged hedge.
