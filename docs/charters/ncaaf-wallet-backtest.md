# Charter — NCAAF wallet backtest (`ncaaf_wallet_backtest`)

Written 2026-10-09 while the tape backfill was still discovering markets —
before any wallet-level NCAAF result was computed. Rule is code:
`research/sharp/ncaaf_wallets.py`, run on the owner's DESKTOP (research
backfills never run on the VPS) against
`~/Documents/Projects/polywhaler-data/ncaaf/ncaaf_2025.db`, table `fills_all`
(full maker + taker tape, fills ≥ $50, `nba_full_tape.py`).

Why this exists: owner, 2026-10-09, on the NCAAF totals lane: grade/price
cuts are "riding the basic data"; the edge is WHO is betting — follow or fade
wallets as an additional signal on top of the holder pipeline's sighted side.
Method, thresholds and acceptance rule are copied from the NBA wallet charter
(`nba-wallet-backtest.md`, which produced the NBA totals fade); the new parts
are the population, the totals-specialist and square-wallet qualifiers, and
the overlay on our own NCAAF shadow rows.

## population
College football markets (`slug` prefix `cfb`) discovered by `backfill.py`
with `SPORTS=cfb MIN_VOL=5000` over 2025-08-20 … 2026-01-25 and
2026-08-25 … 2026-10-08, resolved 0/1. Gamma did not type CFB markets until
mid-September 2025, so the first weeks of 2025 are thin (record warm-up
only). Bet cells are GAME TOTALS (`market_type = 'total'`, token0 = Over —
verified against Gamma `outcomes`); moneylines and spreads contribute
positions to wallet records only.

## wallet records (point-in-time) — NBA method
Position = pregame fills (ts < start) per wallet per market: net shares and
net cash per token; PnL = Σ net_shares × won − net cash; stake = pregame BUY
cash; stake < $50 ignored. A position enters a record only after
start + 4 h < the moment it is consulted.

Qualifiers at time t:
- `S1_sharp` — ≥ 30 settled CFB positions (any type), ROI ≥ +10%.
- `S2_hot` — last 12 settled CFB positions ≥ 9 winners.
- `S3_team` — ≥ 10 settled positions in markets naming one of this game's
  teams, ROI ≥ +15% on them.
- `S4_totals` — ≥ 20 settled CFB TOTALS positions, ROI ≥ +10%.
- `S5_consensus` — ≥ 2 distinct wallets that are S1 or S4 on a side, none
  on the other.
- `S6_square` — ≥ 30 settled CFB positions, ROI ≤ −15% (fade target).

A wallet is *on* Over (Under) if its pregame BUY cash on Over (Under) summed
over ALL total lines of the game, from fills before t, is ≥ $100 and exceeds
its BUY cash on the other side.

## A. game cells (one row per game per cell)
Game = the total markets sharing a matchup and start. T = the first fill in
[start − 180 min, start − 60 min) priced 0.35–0.65 on any of the game's
total lines; when several lines have one, the line whose first in-window
fill is closest to 0.50 is the game's line (ties → earliest). Entry: the
fill price if the bet side is the filled token, else 1 − price.
For Q ∈ {S1, S2, S3, S4, S5, S6}: if Q wallets are on exactly one side at T,
FOLLOW = bet that side, FADE = bet the other. Plus `L0_over`, `L0_under`
(every game, context).

## B. trigger cells (NBA method, every total line)
Trigger = a wallet's first pregame BUY fill ≥ $100 on a token 0–24 h before
start; qualifies under S0 (none) / S1 / S2 / S3 / S4 / S6 at the trigger;
S5 = second S1-or-S4 wallet on the side with none opposite. FOLLOW entry =
first fill of that token by another wallet ≥ trigger + 60 s, before start,
price 0.05–0.95; FADE = the other token at 1 − that price. One row per
(signal, market, side); both sides triggered → no row.

## split and acceptance — NBA rule
z clustered by game. DISCOVERY = 2025 season (start < 2026-07-01),
HOLDOUT = 2026 season to date. CANDIDATE = discovery n ≥ 50 and |z| ≥ 2 AND
holdout same sign, |z| ≥ 1, n ≥ 30, read in the FOLLOW or the FADE
direction (13 cells × 2 directions = 26 tests → ~1.2 chance discovery hits
expected; FOLLOW and FADE of one cell are not independent).

## C. overlay on our own NCAAF totals shadow rows (context, no acceptance)
Input: D1 `shadow_candidates` NCAAF totals, settled, one row per game (line
priced closest to 0.50, ties → earliest), exported 2026-10-09 to
`shadow_ncaaf_totals_2026-10-09.json`. For each, wallet state at the row's
`created_at` over the game's total lines: S1 / S4 / S5 / S6 on the sighted
side (agree), opposite (disagree), or neither. Reported as W-L / ROI per
bucket. n ≈ 160 games, all 2026: descriptive only — anything striking
becomes a separately chartered forward paper read, never a direct lane change.

## what a result means
Candidate → a paper filter beside the live `ncaaf_totals_pilot` lane
(lane keeps betting unfiltered; filtered sub-record reported) once live
NCAAF wallet records exist; changing live bets needs the owner's go and an
era bump. Nothing passing → recorded as no edge; not re-cut, no new
thresholds; replicate on 2026-27 through the same script.

## known_leakage_risks
- Records use only positions settled before T / trigger (start + 4 h).
- T, wallet state and line choice use fills strictly before T (line choice
  uses only the in-window first fill, never later volume).
- `fills_all` floors fills at $50 (API offset cap); the bot buys $2–8 at
  the ask; slippage is not modelled. Opposite-side entry = 1 − fill price
  ignores the spread (optimistic by ~1–2 c for those rows).
- The overlay's shadow rows are the holder pipeline's own picks, which is
  partly built from the same wallets — overlap is the point, not a leak,
  but it is why C carries no acceptance rule.
