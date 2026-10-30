# Charter — NBA totals fade v2 (era v27, `nba_totals_fade_v2`)

Written 2026-10-30, the day v1 (`nba-totals-fade-pilot.md`) stopped on its
z kill at 12-19 (`docs/audits/2026-10-30-nba-totals-fade-pilot.md`). Owner
the same day: "Sure" to a v2 pilot from December 1 with November paper
tracking. Rule is code: lane `src/lib/nba-totals-fade-lane.ts`
(`NBA_TOTALS_FADE_V2_LANE`), signals unchanged (`research/sharp/nba_fade_live.py`).

## evidence (POST-HOC — read after the losses, not pre-registered)
Six slices fixed before scoring, on the 2025-26 tape (discovery < 2026-02-01
/ holdout) and the 2026-27 forward games, one bet per game at the
bot-window fade price in [0.40, 0.60):
- Oct–Nov never worked: 2025 11-17, 2026 10-17; pooled 21-34, −23 %, z −1.8.
- Consensus within 6h of tip: +18 % / +12 %, forward 7-7. Earlier signals weak.
- Fade side 0.50–0.60: +11 % / +15 %, forward 8-10.
- Over/Under side and 2-vs-3+ sharps flip sign between halves (noise; not used).
- Both filters: 44-18 +36 % z 3.2 / 43-26 +20 % z 1.8 / forward 5-4.
Stacked post-hoc filters: expect far less forward (low single digits to +10 %).

## rule
v1's signal (≥ 2 NBA sharps on a total side, none opposite), plus:
consensus trigger ≤ 360 min before the event start; fade side priced
[0.50, 0.60); bot window (60–180 min out); regular season only; no bets
before 2026-12-01T00:00Z.

## sizing_caps_and_kill
$4 (`BOT_LANE_STAKES` += `nba_totals_fade_v2=4`), ≤ 5 open, kill −$40 or
trailing-100 clustered z < −1 after 30 settled — same as v1. Own pick rows.

## paper tracking (November)
At 2026-12-01 re-run the slice backtest (`nba_s5_botwin.py` derivative,
desktop DB) restricted to 2026-11 games and report the v2 rule's paper
record beside the live start. Informational: the live start does not wait
on it (owner bias to small live pilots), but a paper record worse than
−$20 at $4/bet is flagged to the owner before December 1.

## validation
Read at 50 settled bets or season end: pass = ROI > 0 and game-clustered
z ≥ 2. Scaling needs a new charter.
