# Charter — NBA wallet backtest on the 2025-26 season (`nba_wallet_backtest`)

Written 2026-10-07 before any wallet-level NBA result was computed. Rule is
code: `research/sharp/nba_wallets.py`, run on the VPS against
`/root/polysharp/data/nba/nba_2025.db` table `fills_all` (full maker + taker
tape, fills ≥ $50, fetched by `research/sharp/nba_full_tape.py`).

Why this exists: the price-cell backtest (`nba-exchange-backtest.md`, 0/123)
asked whether NBA *prices* are wrong. The user's question is whether
specific *bettors* are right: sharp NBA wallets, hot streaks, team
specialists, over/under specialists. The 2026-09-11 "wallet identity is dead"
read pooled all sports and used taker-only tapes; it did not test
sport-, team- or market-type-specific records, and could not see wallets that
bet by posting orders.

## population
NBA markets as in the price backtest (regular season from 2025-10-21 +
play-in/playoffs, 30-franchise games, resolved 0/1, moneyline/total/spread).

## wallet records (point-in-time)
A wallet's *position* in a market = its pregame fills (ts < start): per token
net shares and net cash. PnL = Σ net_shares × (1 if that token won) − net cash.
Stake = pregame BUY cash. Side = the token with more BUY cash. Positions with
stake < $50 are ignored. A position enters the wallet's record only once
settled: start + 4 h < the moment the record is consulted. No other
information about a wallet is used.

## signals (fixed list)
Trigger = a wallet's first pregame BUY fill ≥ $100 on a token, 0–24 h before
start. The trigger qualifies if, at the trigger time, the wallet meets:
- `S0_any` — no condition (baseline: what following any $100+ buyer earns).
- `S1_nba_sharp` — ≥ 30 settled NBA positions, record ROI ≥ +10%.
- `S2_hot` — last 12 settled NBA positions ≥ 9 winners.
- `S3_team_specialist` — ≥ 10 settled positions in games involving one of
  this game's teams, ROI ≥ +15% on them.
- `S4_type_specialist` — ≥ 20 settled positions of this market type
  (moneyline / total / spread), ROI ≥ +10% on them.
- `S5_consensus` — ≥ 2 distinct S1 wallets triggered on the side and none on
  the other side; trigger time = the second wallet's trigger.

## follow (entry) and grain
Entry = the first fill of the same token by a different wallet at or after
trigger + 60 s and before start (an executable price after we could have seen
the trade), price 0.05–0.95; no such fill → dropped. One row per
(signal, market, side), earliest qualifying trigger. If a signal triggers
both sides of a market, the market is dropped for that signal. ROI =
win / entry − 1. z clustered by game.

## cells
Each signal × {all types, moneyline, total, spread} = 24 cells.
A negative cell is a FADE candidate (same pass rule, sign negative).

## split and acceptance
DISCOVERY start < 2026-02-01, HOLDOUT ≥ 2026-02-01. CANDIDATE = discovery
n ≥ 50 and |z| ≥ 2 AND holdout same sign, |z| ≥ 1, n ≥ 30 — identical to the
price backtest. Candidate → forward paper lane from 2026-10-20 (live wallet
records need the full tape, so the forward lane is built on polysharp's live
crawl switched to takerOnly=false for NBA); real money only on the user's go.
Nothing passing → recorded as no edge, not re-cut.

## known_leakage_risks
- Records use only positions settled before the trigger (start + 4 h).
- Early-season records are thin; that only makes discovery harder.
- `fills_all` floors fills at $50 (API offset cap) — small bettors are not
  in records; the bot copies at ~$4-8, so entry prices remain realistic for
  it. The 60 s latency is a floor; the live alert loop is slower (reported
  as a sensitivity: entry at trigger + 10 min).
