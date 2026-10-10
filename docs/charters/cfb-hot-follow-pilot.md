# Charter — CFB totals hot / team-specialist FOLLOW pilot (`cfb_hot_follow`, era v21)

Written 2026-10-09, before deploy and before any live row. Rule is code:
`src/lib/cfb-hot-follow-lane.ts` (lane, side, band, caps, kill) +
`research/sharp/cfb_hot_live.py` (VPS signal, every 10 min) +
`research/sharp/cfb_records.py` (wallet records, desktop, daily).

## origin
Owner 2026-10-09: the edge is WHO is betting — follow or fade wallets as a
signal; "One hot or specialist wallet alone … I believe this is one of the
edges. Some bettors know what they're doing and can get hot"; "live at $4,
set it up for tomorrow". The pre-registered NCAAF wallet backtest
(`ncaaf-wallet-backtest.md`, 4b97acf) passed 0/26 cells; in the
constructive pass after it, the UNION of its S2 (hot) and S3 (team) follow
cells — positive in both seasons separately — was the strongest scenario.
Post-hoc (exploratory) selection: an execution pilot, not a promotion.

## evidence at registration (one bet per game, first in-window fill)
72-50, +19.1 %, game-clustered z 2.1, $4 → +$93 over 122 games;
2025 season 42-27 +23 % (z 1.9), 2026 to date 30-23 +14 % (z 1.0);
months 2025-10 −$6, 11 +$31, 12 +$31, 01 +$7, 2026-09 +$17, 10 +$13;
Over 36-21 +29 %, Under 36-29 +11 %; one HT wallet 51-33 +23 %, 2+ 21-17.

## rule (the contract)
- Records (point-in-time, full maker+taker CFB tape, fills ≥ $50, pregame
  positions, stake ≥ $50, settled at start + 4 h): HOT = last 12 settled CFB
  positions ≥ 9 winners; TEAM = ≥ 10 settled positions in markets naming one
  of the game's teams at ROI ≥ +15 %.
- ON a side = pregame BUY cash on Over (Under) summed over all the game's
  total lines ≥ $100 and greater than on the other side.
- Signal = HOT-or-TEAM wallets on exactly one side → bet that side. On both
  sides → no bet.
- Execution: in-window NCAAF game-total entry (bot window), that side's price
  in [0.35, 0.65), $4, one bet per game, ≤ 5 open (≤ 10 from 2026-10-10, era v25), kill at −$40 realized or
  trailing-100 game-clustered z < −1 after 30 settled (shared lane
  machinery), stake ladder per `lane-stake-ladder.md`.
- Lane order: before `ncaaf_totals_pilot` — a game with a signal goes to this
  lane; from v21 the NCAAF pilot's population is "games without a signal".
- Forward start 2026-10-10T12:00Z.

## read
Forward live record only (rows `lane = 'cfb_hot_follow'`). First look at
n ≥ 50 settled (≈ mid-Nov). Promotion beyond the ladder needs n ≥ 100 and
z ≥ 2 on forward rows. The kill rule is the only automatic stop.

## known_leakage_risks / differences from the backtest
- Live state is computed at each 10-min push and consulted at the bot tick;
  the backtest used the state at the first in-window fill. The lane bets
  the first in-window tick where the signal holds.
- Live sums every total line Gamma lists (backtest: lines with ≥ $5k
  volume); extra low-volume lines add few ≥ $100 buyers.
- Records refresh daily from the desktop (`cfb-daily.sh`); if the desktop is
  off they go stale (summary `recordsAgeH` in bot_runtime_status
  `lane_signals:cfb_hot_follow`).
- Gamma series id for 2026 is 12756 (`CFB_SERIES_ID`); the 2027 season mints
  a new one.
