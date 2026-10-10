# Charter — NFL totals wallet FOLLOW pilot (`nfl_wallet_follow`, era v22)

Written 2026-10-09, before deploy and before any live row. Rule is code:
`src/lib/nfl-wallet-follow-lane.ts` + `research/sharp/wallet_lane_live.py`
(VPS, every 10 min, `RULE=S3SQ`) + `research/sharp/wallet_records.py`
(desktop, daily, `nfl-daily.sh`).

## origin
Owner 2026-10-09: "go, start NFL tonight"; "you have $50 and your life
depends on it to turn it into substantial money". The pre-registered NFL
wallet read (`nfl-wallet-backtest.md`) passed 0/30 and the CFB HT rule did
not replicate; in the constructive pass after it, S3SQ was the strongest
union (audit docs/audits/2026-10-09-nfl-wallet-backtest.md). Exploratory
selection: an execution pilot, not a promotion.

## evidence at registration (one bet per game, first in-window fill)
53-30, +26.8 %, game-clustered z 2.5, $4 → +$89 over 83 games; 2025 +25 %
(n 73), 2026 +38 % (n 10); months 25-09 +$18, 10 +$11, 11 +$27, 12 +$14,
26-01 +$4, 26-09 +$11, 26-10 +$4 (7/7 positive). Does not transfer to CFB.

## rule (the contract)
- Records (point-in-time, full maker+taker NFL tape, fills ≥ $50, pregame
  positions, stake ≥ $50, settled at start + 4 h): TEAM = ≥ 10 settled NFL
  positions in markets naming one of the game's teams at ROI ≥ +15 %;
  SQUARE = ≥ 30 settled NFL positions at ROI ≤ −15 %.
- ON a side = pregame BUY cash on Over (Under) summed over all the game's
  total lines ≥ $100 and greater than on the other side.
- Support for side X = TEAM wallets on X + SQUARE wallets on the other side.
  Support on exactly one side → bet it; on both → no bet.
- Execution: in-window regular-season NFL game total, side price in
  [0.35, 0.65), $4, one bet per game, ≤ 5 open, kill −$40 realized or
  trailing-100 game-clustered z < −1 after 30 settled, stake ladder
  (`lane-stake-ladder.md`). Runs before `nfl_totals_pilot`.
- Forward start 2026-10-11T12:00Z. Gamma series 12185 (`nfl-2026`).

## read
Forward rows `lane = 'nfl_wallet_follow'`; first look n ≥ 30 (~mid-Nov at
~4/week), promotion beyond the ladder needs n ≥ 100 and z ≥ 2 forward.
