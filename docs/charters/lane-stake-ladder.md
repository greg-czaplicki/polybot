# Charter — lane stake ladder (2026-10-08)

Owner decision 2026-10-08, after the CS2 forward lane failed z ≥ 2 at n 162:
"I think z > 2 for anything other than MLB would be a miracle, we need
different criteria" → offered a stake ladder → "Looser level 1 and
automatic". Rule is code: `src/lib/lane-ladder.ts` (app) and
`BOT_LANE_MAX_STAKE` in the bot. Thresholds below are frozen; changing them
is a new charter version.

## why
z grows with √n. Bets needed for z = 2 near even money: ~1,600 at a real
+5 % edge, ~400 at +10 %, ~100 at +20 %. A single lane produces a few hundred
bets a season, so a z ≥ 2 bar on every stake increase means nothing short of
an MLB-sized outlier ever scales. The ladder makes the bar rise with money
at risk instead.

## rule (applies to every second-family lane: cs2_pickem_dog,
## ncaaf_totals_pilot, nfl_totals_pilot, nba_totals_fade, and any later lane)
| level | stake | reached when (lane bets PICKED ≥ 2026-10-08T12:00Z only) |
|---|---|---|
| 0 | $4 | default |
| 1 | $6 | ≥ 100 settled, ROI > 0, event-clustered z ≥ 0.8 |
| 2 | $8 | ≥ 250 settled, z ≥ 1.5 (= the main book's flat stake) |
| — | > $8 | ≥ 250 settled, z ≥ 2 → flagged on the dashboard; owner decides |

- Step down one level while the last 100 settled are net negative.
- Recomputed from the pick rows on every bot tick (no stored state); the app
  sends `laneStakeUsd` on each lane candidate and the bot applies it
  automatically, capped by `BOT_LANE_MAX_STAKE` (8).
- The lane's daily notional cap scales with the stake (picks/day unchanged).
- Unchanged: each lane's −$40 realized-PnL kill and trailing-z kill, the
  bot's global `BOT_DAILY_NOTIONAL_CAP`.
- Supersedes the per-lane charters' "scaling needs lane PASS + fill rate /
  slippage" clauses for stakes up to $8.

## honesty
- Forward rows only: pilot rows before the ladder start never count, so no
  lane starts above level 0 (CS2's +$15 / z 0.4 history does not carry).
- A lane with no edge reaches level 1 roughly 1 time in 5; the step-down
  rule and the −$40 kill bound the cost of that false promotion to tens of
  dollars. That trade is the point of the ladder.
