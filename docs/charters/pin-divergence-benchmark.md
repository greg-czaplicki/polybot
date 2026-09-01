# Charter — Pin-divergence benchmark lanes (`pin_div_paper`)

FINAL 2026-09-01 (owner: "do what you think is best, same for soccer").
Extends tennis-v2 R1 (`tennis-ground-up-addendum-1.md`) verbatim to the
team sports, as a paper lane. Nothing here changes after a sport's first
`pin_div_paper` row is recorded.

## Purpose (two roles)

1. **Benchmark**: the transparency-blind baseline for every wallet-signal
   probation read. When a probation sport (NCAAF, NFL, soccer leagues)
   reaches its holder-signal read (~n=100-150, late Nov for football),
   the wallet signal's cohort is compared against this lane's cohort on
   the same sport and window — the moat thesis predicts the wallet
   signal adds value beyond price divergence; this lane measures the
   divergence baseline from week 1 so that comparison is possible.
2. **Standalone candidate**: a sport's lane cohort may itself meet the
   promotion bar and go live on its own merits.

## Rule (identical to tennis R1; one lane, per-sport verdicts)

- Lane: `shadow_candidates.reject_reason = 'pin_div_paper'`; sports:
  nfl, ncaaf, mlb, epl, mls, laliga, bundesliga, seriea, ligue1, ucl,
  championship. (Tennis stays in its own `tennis_v2_paper` lane under
  its own charter.) Verdicts are per sport_tag, never pooled.
- Fire when ALL hold at evaluation time: moneyline market; fresh cached
  Pinnacle quote (≤ 20 min); |pm − pin_devigged| ≥ **0.05**; PM price in
  [0.25, 0.75]; ≥ 30 min to event; fire-once per condition. Side = the
  PM side Pinnacle prices higher.
- Soccer de-vig is THREE-WAY (draw mass included): each side's fair prob
  computed independently; the two sides' fairs sum to < 1. Draw-question
  markets are props and never enter the lane.
- Totals are EXCLUDED (exact-line matching gives a biased ~30% sample —
  2026-08-24 audit); moneyline keeps the lane comparable across sports.
- Rule inputs stamped in warnings_json; sharp_side = the lane's side,
  NOT the holder signal's; top_holders_json NULL.

## Reading rules

- Promotion bar per sport: n ≥ 50 settled, event-clustered z ≥ 2, mean
  pin_clv > 0 — the standard bar, never loosened.
- Benchmark comparison at each probation sport's wallet-signal read:
  pre-registered as cohort-vs-cohort on the same window; overlap
  expected; neither cohort's rows are ever mixed into the other.
- Live sports caveat (mlb, epl, mls): the lane sees only markets the
  picker did NOT bet (picked markets never reach the shadow scan), so
  live-sport lanes are diagnostics-grade, not clean promotion cohorts;
  probation sports have no such bias.
- Quote-window caveat: fetch caps mean fresh-quote windows cluster near
  slates (football ~1-2 windows/day at best); expected volume is low and
  that is accepted — no budget increase for this lane.
- Quarterly per-sport review from a sport's first row: continue or stop.

## Out of scope

Totals/spreads/props; live betting; any bot execution (paper only); any
change to existing gates, eras, or the tennis-v2 charter.
