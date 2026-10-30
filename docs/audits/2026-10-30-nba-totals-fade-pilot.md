# NBA totals fade pilot — readout at kill (2026-10-30)

Charter: `docs/charters/nba-totals-fade-pilot.md` (era v19). Lane
`nba_totals_fade`, $4 fixed, forward from 2026-10-20.

## outcome
Stopped by the pre-registered z kill on 2026-10-30: 31 settled (≥ 30
minimum), 12-19, realized −$26.14 on $124 staked (ROI −21.1 %), clustered
z −1.16 < −1. The drawdown kill (−$40) was not reached. Average fill
0.51 — fills were in band, so this is a results stop, not an execution one.

Per the charter the kill is final for this version: the bot places no more
`nba_totals_fade` bets. Restarting needs a new charter version and an era
bump.

## what continues
The evidence question (charter question 1) is read from ALL signals, not
only the bot's bets. `nba-fade-live.timer` keeps pushing to
`nba_fade_signals` every 10 min (69 non-voided signals on 50 games so far),
so the planned evidence read at 150 signal-games (~mid-December) and at
season end still happens. A pass there (ROI > 0, game-clustered z ≥ 2)
would be grounds for a new charter.

## context
Backtest expectation was +5–8 % forward. 12-19 at ~even prices is
≈ 3.5 wins under 50 %; z −1.16 is weak evidence against the edge, not
proof of none — the kill rule is a loss limit, deliberately loose.
