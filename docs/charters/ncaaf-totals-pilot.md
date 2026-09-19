# Charter — NCAAF totals lane, capped live execution pilot (era v16)

Written 2026-09-19 ~22:00Z under the `sports-modeling-doctrine` schema,
before the first live row. Owner decision the same evening, after the CFB
status read: "let's allow the bot to place $4 bets on Totals for now." The
rule is code (`src/lib/ncaaf-totals-lane.ts`); every threshold below is a
constant there. Changing the side rule, the band, the caps, the kill rule
or the metric after 2026-09-20 means a NEW charter version; prior rows
become exploratory.

## question
Two questions, deliberately separated:
1. **Evidence** (NOT this pilot): does the holder pipeline's sighted side on
   NCAAF game totals beat the price? Read from the `ncaaf_league_probation`
   shadow rows by the standard promotion rule (n ≥ 50 sole-blocker rows,
   event-clustered z ≥ 2, `docs/STRATEGY.md`). The shadow keeps being
   written for every NCAAF market regardless of this lane.
2. **Execution** (this pilot): when *we* buy that side at $4 inside the bot
   window on Saturday CFB slates, what do we get — fill rate, slippage vs
   the sighted price, rejections, settlement lag and resolution quirks
   (overtime totals, cancelled games, weather) — in Polymarket CFB books?

## origin (why this is a hypothesis, not a result)
The 2026-09-19 CFB read (four weekends): NCAAF totals shadow 80 settled
rows 49-31 +22 % (later recount 84 rows on 49 market-sightings / 44
events, +19.3 %, event-clustered z ≈ 1.35). Cuts, all small: Under 37-18
+33 % vs Over 16-13 +13 %; sighted price 40–50c 23-5 +75 % vs 50–60c 30-26
+2 %; by reject reason: `not_ready` 17-15 +4 %, `too_close_to_start` 15-8
+31 %, `outside_window` 13-6 +40 %, `ncaaf_league_probation` (= the
bettable cohort: in window, ready) 8-2 +61 %. The holder-GATED cohort
(every gates_json key passes) is 4 rows, 0-3 settled, all `not_ready`.
Every one of these is below the owner's own n ≥ 50 / z ≥ 2 rule; the
40–50c and Under splits were seen before registration and are reported
sub-cuts, never a filter. The pilot is an explicit, sized-to-be-harmless
exception made to buy execution truth on CFB totals early; it is not a
promotion and produces no evidence about the edge.

## sport_and_competition
NCAAF (`ncaaf`, FBS series in discovery), game-total (O/U) markets only.
Team totals, half/quarter totals and alternate totals are props under era
v7 classification and outside the lane. Every FBS game and time slot is
in; conference/tier and Over/Under are reported sub-cuts.

## population_and_exclusions
Sharp-money cache entries that pass the bot's pre-filter (not already
picked, market group not taken, event time known, 60–180 min to start, not
started, holder history ready — `not_ready` entries never reach the scan),
`sport_tag = ncaaf`, market type total, with a sighted sharp side whose
price is in [0.25, 0.75). No holder gate is applied: grade, edge rating,
price_edge and score are carried on the pick row for the record only.
Markets whose group is already taken by the holder book or another lane
this tick are skipped.

## grain_and_natural_key
One live pick per game (market-group key; alternate total lines of the
same game dedupe to one). Cluster key for the kill z = matchup title +
event time. Picks carry `manual_picks.lane = 'ncaaf_totals_pilot'`; every
holder-book read filters `lane IS NULL`, so the families never pool.

## decision_time_and_horizon
T = sighting inside the bot window (60–180 min pre-start), closest-to-start
first. Entry = the bot's taker BUY at the live ask, subject to its
price-drift guard vs the sighted price. Horizon = settlement.

## sizing_caps_and_kill (the contract)
| parameter | value |
|---|---|
| stake | $4 fixed (`BOT_LANE_STAKES=…,ncaaf_totals_pilot=4`; app assumes 4 when a fill is unreported) |
| picks per UTC day | ≤ 5 (app-enforced from lane pick rows) |
| notional per day | ≤ $20 (app: UTC day from fills; bot: rolling 24h `BOT_LANE_DAILY_CAPS`) |
| price band | sighted price of the taken side in [0.25, 0.75) |
| kill: drawdown | realized lane PnL ≤ −$40 → app stops emitting |
| kill: z | ≥ 30 settled AND event-clustered z of the trailing 100 < −1 → stop |
| forward start | 2026-09-20T00:00Z (registered with the 2026-09-19 evening slate already inside the window; it is excluded on purpose) |
| manual off | `enabled=false` in the lane file (era bump) or `BOT_LANE_STAKES` entry unset / 0 (bot skips, logged) |

Caps are enforced on both ends: the app will not emit past its caps, and a
bot without a configured lane stake never places a lane candidate.

## baselines
- Zero ROI at the sighted price, for the pilot's own rows (descriptive).
- The `ncaaf_league_probation` shadow rows on the same markets — the
  pilot's fills minus the shadow's sighted price is the execution cost.
- Pinnacle closing total (`pin_close_*` on the shadow rows) once the
  football feed pause lifts on 2026-11-02; not a criterion (owner rule).

## primary_metric_and_others
For the pilot: fill rate (filled / emitted), mean slippage bps vs sighted
price (`fill_slippage_bps`), rejections and unknown-fill count, settlement
lag, resolution incidents (logged by hand in the audit). ROI and PnL are
reported for the kill rule only.

## validation_and_acceptance
- The pilot never promotes anything. NCAAF totals join the live book only
  through the standard shadow rule (n ≥ 50 sole-blocker, clustered z ≥ 2).
- Scaling the lane (stake, caps, window) requires that PASS AND fill rate
  ≥ 80 % with mean slippage under 150 bps over ≥ 30 fills; both are then
  an era bump with a new charter.
- Kill triggers are final for this charter version; a re-start is a new
  version with a written reason.
- Pilot readout: `docs/audits/<date>-ncaaf-totals-pilot.md`, first at 30
  settled picks or 2026-12-01, whichever first.

## data_requirements
Sharp-money cache covering NCAAF (FBS series), bot online on Saturdays
(US afternoon/evening slates 16–04Z), `manual_picks.lane` column
(migration 0043), bot with the lane stake configured, shadow book writing
`ncaaf_league_probation` rows for the read.

## leakage pre-audit (2026-09-19)
- The pilot's rows are execution data, not evidence — excluded from every
  holder-book read by `lane IS NULL`; the shadow book is unaffected because
  the lane emits AFTER the holder pipeline has rejected and recorded the
  same entry.
- The side rule (sighted sharp side) and the band were fixed from the
  existing pipeline's definitions, not fitted: the 40–50c / Under splits
  seen at registration were NOT turned into filters.
- Kill-rule inputs (realized PnL, trailing z) are computed from settled
  rows only; pending exposure does not feed them.
- The forward start (2026-09-20) is after every row examined.
