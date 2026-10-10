# Charter — Soccer totals hot / team-specialist FADE pilot (`soccer_hot_fade`, era v23)

Written 2026-10-09, before deploy and before any live row. Rule is code:
`src/lib/soccer-hot-fade-lane.ts` + `research/sharp/wallet_lane_live.py` (VPS, every 10 min,
`RULE=HTFADE`) + `research/sharp/wallet_records.py` (desktop, daily, `wallet-daily.sh soccer`).
Owner 2026-10-09: "Open whatever lanes you think makes sense and let's keep going. Check
soccer and NHL." Audit: docs/audits/2026-10-09-nhl-soccer-wallet-backtest.md.

## evidence (one bet per game, first in-window fill on the main line)
323-282 +8.7 % z 2.1 (out-of-sport replication of the NHL rule; 2025-26 +6.1 % n472, 2026-27 +17.6 % n135), $4 → +$211.

## rule (the contract)
- Records (point-in-time, full maker+taker tape, fills ≥ $50, pregame positions, stake ≥ $50,
  settled at start + 4 h): HOT = ≥ 9 of the last 12 settled positions won; TEAM = ≥ 10 settled
  positions in markets naming one of the game's teams at ROI ≥ +15 %.
- ON a side = pregame BUY cash on Over (Under) summed over all the game's total lines ≥ $100
  and greater than on the other side.
- HOT-or-TEAM wallets on exactly one side → bet the OTHER side; on both sides → no bet.
- Execution: in-window game total, side price in [0.35, 0.65), $4, one bet per game, ≤ 5 open,
  kill −$40 realized or trailing-100 game-clustered z < −1 after 30 settled, stake ladder.
  App eligibility via LaneConfig.sportTags (8 league tags). Forward start 2026-10-10T12:00Z. Gamma series: 10188,10189,10355,10193,10194,10203,10195,10204 (EPL, MLS, Championship, La Liga, Bundesliga, Serie A, Ligue 1, UCL; totals sit in '… - More Markets' events, merged by title + kickoff).

## read
Forward rows `lane = 'soccer_hot_fade'`; first look n ≥ 50; promotion beyond the ladder needs
n ≥ 100 and z ≥ 2 forward.
