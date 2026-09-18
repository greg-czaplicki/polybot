# Charter — CS2 near-pickem dog lane, capped live execution pilot (era v14; v1.1 amendment era v15)

Written 2026-09-17 under the `sports-modeling-doctrine` schema, before the
first live row. Owner decision the same day: "Let's do both" — the
polysharp forward lane (`cell-lanes.md` v1.2, `cs2_pickem_dog_cell`) AND
a capped live pilot of the same rule. The rule is code
(`src/lib/cs2-pickem-lane.ts`); every threshold below is a constant there.
Changing the band, the window, the caps, the kill rule or the metric after
2026-09-18 means a NEW charter version; prior rows become exploratory.

## question
Two questions, deliberately separated:
1. **Evidence** (forward lane, NOT this pilot): do small takers who buy the
   40–50c side of CS2 match-winner markets keep making money after the rule
   was frozen? Read from the polysharp daily report, `FORWARD CELL LANES`,
   lane `cs2_pickem_dog_cell`, at n ≥ 150, ROI > 0, clustered z ≥ 2.
2. **Execution** (this pilot): when *we* buy that side at $4 inside the bot
   window, what do we actually get — fill rate, slippage vs the sighted
   price, order rejections, settlement lag, and Polymarket's resolution
   behaviour on forfeits, map-count changes and rescheduled matches — in
   thin tier-2/3 CS2 books?

## origin (why this is a hypothesis, not a result)
2026-09-17 read: the holder signal does not fire on CS2 (would-have-bet
cohort 3 rows in a week; price_edge / edge_rating / grade fail on ≥ 38 of
48 probation rows). The exchange-frame cell audit
(`docs/audits/2026-09-11-counterparty-cells.md`, `cell_cs2.txt`) showed
CS2 moneyline 40–50c +5.5 % (z 1.4, n 562, +6.8 % / +4.1 % by half) and
its mirror 50–60c −6.4 % (z −2.5, n 590, both halves negative); every
band above 50c negative. The pilot's cell is therefore BELOW the owner's
own significance rule (z ≥ 2) — the significant finding is the favourite
side's loss. The pilot is an explicit, sized-to-be-harmless exception made
to buy execution truth early; it is not a promotion and it produces no
evidence about the edge.

## sport_and_competition
CS2 (`cs2`, series 10310) match-winner markets only. Map winners, map
handicaps and totals are props/other under era v13 classification and are
outside the lane. All tournament tiers and formats (BO1/BO3/BO5) are in;
format and tier are reported sub-cuts of the forward lane, never a filter
added after seeing rows.

## population_and_exclusions
Sharp-money cache entries that pass the bot's pre-filter (not already
picked, market group not taken, event time known, 60–180 min to start,
not started), `sport_tag = cs2`, market type moneyline, exactly one side
with sighted price in [0.40, 0.50). Both sides in band → skipped (ambiguous
coin-flip with a wide spread). `not_ready` entries (holder history too
short) are excluded because they never reach the candidate scan; expected
≈ 5 % of CS2 markets.

## grain_and_natural_key
One live pick per (market). Cluster key for the kill z = matchup title +
event time. Picks carry `manual_picks.lane = 'cs2_pickem_dog'`; every
holder-book read filters `lane IS NULL` (dashboard, P&L series) so the two
families never pool.

## decision_time_and_horizon
T = sighting inside the bot window (60–180 min pre-start), the app emits
closest-to-start first. Entry = the bot's taker BUY at the live ask, subject
to its price-drift guard vs the sighted price. Horizon = settlement.

## sizing_caps_and_kill (the contract)
| parameter | value |
|---|---|
| stake | $4 fixed (`BOT_LANE_STAKES=cs2_pickem_dog=4`; app assumes 4 when a fill is unreported) |
| picks per UTC day | ≤ 3 (app-enforced from lane pick rows) |
| notional per day | ≤ $20 (app: UTC day from fills; bot: rolling 24h `BOT_LANE_DAILY_CAPS`) |
| kill: drawdown | realized lane PnL ≤ −$40 → app stops emitting |
| kill: z | ≥ 30 settled AND event-clustered z of the trailing 100 < −1 → stop |
| forward start | 2026-09-18T00:00Z |
| manual off | `enabled=false` in the lane file (era bump) or `BOT_LANE_STAKES` unset / 0 (bot skips, logged) |

Caps are enforced on both ends: the app will not emit past its caps, and a
bot without a configured lane stake never places a lane candidate.

## baselines
- Zero ROI at the sighted price, for the pilot's own rows (descriptive).
- The forward lane's own ROI on the same markets — the pilot's fills
  minus the lane's small-taker fills is the execution cost we are buying
  a number for.

## primary_metric_and_others
For the pilot: fill rate (filled / emitted), mean slippage bps vs sighted
price (`fill_slippage_bps`), rejections, unknown-fill count, settlement lag,
resolution incidents (logged by hand in the audit). ROI and PnL are
reported for the kill rule only. No CLV term (no sharp book for esports).

## validation_and_acceptance
- The pilot never promotes anything. Scaling the lane (stake, caps, or
  widening the window) requires the forward lane to PASS (n ≥ 150, ROI > 0,
  z ≥ 2) AND the pilot to show fill rate ≥ 80 % with mean slippage under
  150 bps over ≥ 30 fills; both are then an era bump with a new charter.
- Kill triggers are final for this charter version; a re-start is a new
  version with a written reason.
- Pilot readout: `docs/audits/<date>-cs2-pickem-pilot.md`, first at 30
  settled picks or 2026-11-01, whichever first.

## data_requirements
Sharp-money cache covering CS2 (series 10310 in discovery), bot online
during European daytime (CS2 starts cluster 08–17Z), `manual_picks.lane`
column (migration 0043), bot with lane stake configured, polysharp crawl
running for the forward lane.

## leakage pre-audit (2026-09-17)
- The pilot's rows are execution data, not evidence — they are excluded
  from every holder-book read by `lane IS NULL` and never enter the forward
  lane (which reads the exchange tape, not our picks).
- The forward lane's start (2026-09-18) is after the cell was chosen; the
  cell itself was cut on 2026-09-11 from data through that date. No
  post-9/12 CS2 rows were examined before freezing the band.
- Kill-rule inputs (realized PnL, trailing z) are computed from settled
  rows only; pending exposure does not feed them.

## Amendment v1.1 (2026-09-18, era v15) — one pick per team per UTC day

Decided on day 1 at ~11:30Z, before any lane pick had settled (the three
2026-09-18 picks were pending). Day 1 emitted 3DMAX @ .46 vs Inner Circle,
BBL @ .42 vs 3DMAX and BBL @ .48 vs EYEBALLERS — all Logitech G Play
Connect Group B BO1s, two stakes on BBL and 3DMAX both for and against.
Match outcomes are near-independent, but the shared factor is team-level
mispricing: three stakes carried roughly one and a half stakes of
independent risk while the kill z (cluster = match) counted three clusters.

Rule added: a team that appears on **either** side of a market the lane
already picked in the current UTC day is excluded for the rest of that day
(`CS2_PICKEM_DOG_LANE.oneTeamPerDay`, team keys from `matchTeamKeys(title)`:
game prefix, `(BOn)` tag and ` - <event>` suffix stripped, lower-cased).
Applied to picks already placed today and to picks emitted earlier in the
same tick; skip reason `team_taken_today`. Per-tournament dedupe was
rejected: CS2 volume sits in one or two events per day and the cap would go
unused, starving the fill/slippage measurement the pilot exists for.

Everything else is unchanged: band, stake, caps, kill rule, forward start,
metric, and the polysharp evidence lane `cs2_pickem_dog_cell` (which records
every qualifying market-side and is not deduped — it is the read). This is a
structural exposure rule, not a threshold moved after seeing results; the
day-1 rows stay in the pilot cohort. Rows from 2026-09-18 onward carry
`strategy_version` v15. Open follow-up (not adopted): the closest-to-start
ordering spends the daily cap on the 08–13Z tier-3 slate; revisit a
time-of-day spread only if first-week slippage is non-zero.
