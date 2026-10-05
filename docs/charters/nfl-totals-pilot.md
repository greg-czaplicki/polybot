# Charter — NFL totals lane, capped live execution pilot (era v18)

Written 2026-10-05 ~16:00Z, before the first live row. Owner decision the
same day, after the week-4 NFL totals re-read: "Yes, open nfl lanes". The
rule is code (`src/lib/nfl-totals-lane.ts`); every threshold below is a
constant there. Changing the side rule, band, caps, kill rule or metric
after the forward start means a NEW charter version; prior rows become
exploratory. The template is the NCAAF totals pilot
(`docs/charters/ncaaf-totals-pilot.md`); every section not restated here
applies verbatim with `ncaaf` → `nfl` and Saturday → Sunday/primetime.

## question
1. **Evidence** (NOT this pilot): does the holder pipeline's sighted side on
   NFL game totals beat the price? Read from the `nfl_league_probation`
   shadow rows by the standard promotion rule (n ≥ 50 sole-blocker rows,
   event-clustered z ≥ 2). The shadow keeps being written regardless.
2. **Execution** (this pilot): $4 fills on that side inside the bot window —
   fill rate, slippage vs sighted price, rejections, settlement quirks.

## origin
`nfl_league_probation` totals shadow, regular season only (event ≥
2026-09-10), FIRST row per game (alt lines dedupe — the 9/28 overcount
lesson), weeks 1-4: 56 games 37-19, +29.8 % at the sighted price, z 2.36 (CORRECTED 2026-10-05: 9 games had several alt lines first sighted at the same timestamp; 37-19 z 2.36 was the favourable tie-break. Averaging tied lines: ≈35-21, +25.2 %, z 2.02; worst/best tie-break +16.9 % z 1.28 / +31.4 % z 2.46.)
Weekly 5-5 / 13-3 / 9-7 / 10-4; excluding week 2, 24-16 ≈ +18 %. Week 4
(10-4) is the only block not seen at the 2026-09-28 read. Under 23-11,
Over 14-8 — both positive; neither is a filter. All-gates-pass (the
official sole-blocker cohort) is 4 rows 3-1, so the promotion rule is NOT
met: this is an execution pilot, not a promotion. Comparable: the NCAAF
pilot opened on z ≈ 1.35 and its population edge later regressed from
+22 % to +6.6 % — expect regression here too.

## population_and_exclusions
Bot pre-filter survivors (not already picked, market group not taken, event
time known, inside the bot window, holder history ready), `sport_tag =
nfl`, game-total market, sighted sharp side priced in [0.25, 0.75), event
time NOT NFL preseason (`isNflPreseasonTime`). No holder gate. Team totals,
half/quarter totals and alternate lines are props or dedupe away.

## sizing_caps_and_kill (the contract)
| parameter | value |
|---|---|
| stake | $4 fixed (`BOT_LANE_STAKES=…,nfl_totals_pilot=4`) |
| picks per UTC day | ≤ 5 |
| notional per day | ≤ $20 (app UTC day; bot rolling 24h `BOT_LANE_DAILY_CAPS`) |
| price band | [0.25, 0.75) on the taken side |
| kill: drawdown | realized lane PnL ≤ −$40 → stop |
| kill: z | ≥ 30 settled AND clustered z of trailing 100 < −1 → stop |
| forward start | 2026-10-05T17:00Z |
| manual off | `enabled=false` (era bump) or bot stake unset |

Note: Sunday 17:00Z/20:25Z slates carry ~13 games; the 5/day cap binds and
the lane takes the closest-to-start games first. Reported, not a filter.

## validation_and_acceptance
Identical to the NCAAF pilot: never promotes; scaling needs the shadow
PASS plus fill rate ≥ 80 % and slippage < 150 bps over ≥ 30 fills (new
charter + era bump); kill is final for this version. Readout:
`docs/audits/<date>-nfl-totals-pilot.md` at 30 settled picks or end of the
regular season (2027-01-10), whichever first.

## leakage pre-audit (2026-10-05)
- Lane rows carry `manual_picks.lane = 'nfl_totals_pilot'`; holder-book
  reads filter `lane IS NULL`. The lane emits after the holder pipeline has
  rejected and shadow-recorded the same entry.
- Side rule and band copied from the NCAAF pilot, not fitted; the Under
  and week splits seen at registration are not filters.
- Forward start is after every row examined.
