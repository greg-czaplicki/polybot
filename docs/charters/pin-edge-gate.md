# Charter — Pinnacle price edge as a gate (`pin_edge`)

Written 2026-08-25 under the `sports-modeling-doctrine` schema
(`.agents/skills/sports-modeling-doctrine`). This is the user-owned contract
for the pre-registered test listed in `docs/STRATEGY.md`. Changing target,
grain, decision time, threshold, or metric after data exists means a NEW
charter version; the prior result is then labelled exploratory.

## question
Does a Polymarket price that sits below Pinnacle's de-vigged probability at
sighting (`pin_edge = pin_fair_prob − price ≥ 0.03`) identify positive-ROI
candidates — per sport — independently of the holder-quality signal?

## sport_and_competition
Evaluated per sport, never pooled: MLB first (only sport with near-complete
Pinnacle coverage), then ATP, WTA, EPL, MLS, La Liga, Serie A, Ligue 1, UCL,
NHL (from 2026-27 opening night). A sport enters evaluation only when it
meets `data_requirements`.

## population_and_exclusions
`shadow_candidates` rows with:
- `created_at ≥ 2026-08-25T13:17Z` (migration 0035 deploy; nothing earlier
  carries an anchor);
- `pin_fair_prob IS NOT NULL` (anchor captured AND matched);
- `market_type ∈ {moneyline, total}`;
- `price ≥ 0.25` (era v9 floor — sub-floor rows are phantom-edge rows);
- `reject_reason NOT IN (outside_window, too_close_to_start, not_ready)`
  (never anchored: not a would-have-bet at that sighting);
- `status ∈ {win, loss}`; pushes excluded from ROI and reported as a count;
- draw-question markets excluded (never anchored).
Rows whose anchor was stamped without a match (`pin_captured_at` set,
`pin_fair_prob` NULL) are the coverage denominator, not the sample.

## grain_and_natural_key
One row = the FIRST anchored sighting of one (market, side):
`condition_id + sharp_side`, earliest `created_at`. Mirrors the shadow book's
"1u at first-sighting price" convention. Later sightings of the same
market/side are dependent rows and are dropped, not averaged.

## analysis_type
Predictive (prospective). Decision at T, outcome after T. No causal claim.

## decision_time_and_horizon
T = sighting (`created_at`). Horizon = market settlement (hours to a day).
Feature legality at T:
- `price` — Polymarket price at sighting. Legal.
- `pin_fair_prob` — Pinnacle de-vigged probability from a feed fetched at
  `pin_feed_at ≤ T`, at most `SHADOW_ANCHOR_FEED_TTL_SECONDS` (20 min) old.
  Legal (pre-T, staleness recorded per row). A feed fetched AFTER T is not
  possible by construction (the sweep only anchors rows created before it
  runs, and reads a cache written at or before the sweep).
- gate vector (`gates_json`), `reject_reason` — computed at T. Legal.
- `pin_clv`, `pin_close_fair_prob`, `roi`, `resolved_outcome` — post-T.
  Evaluation only; never a feature.

## target_or_estimand
Per-row ROI at the sighting price: win → `(1 − price)/price`, loss → `−1`.
Estimand = mean ROI of the edge bucket minus mean ROI of the no-edge bucket.

## base_rate_or_null
Null: pin_edge carries no information → the two buckets have equal expected
ROI, both ≈ the sport's overall anchored-shadow ROI in the same window.

## naive_and_strong_baselines
- Naive: all anchored rows in the sport, no split.
- Strong simple: the holder signal alone — all-five-vector-gates-pass rows
  (the would-have-bet cohort) without regard to pin_edge. The combined read
  (holder-pass AND pin_edge ≥ 3¢) must beat THIS, not just the naive rate,
  before pin_edge earns a place beside the holder gates.

## primary_metric_and_direction
`Δ = mean ROI(pin_edge ≥ 0.03) − mean ROI(pin_edge < 0.03)`, higher is
better, with `z = Δ / SE(Δ)` (Welch SE from per-row ROI variance). Threshold
0.03 is FIXED by this charter; it was not tuned on data.

## secondary_metrics
- `pin_clv` of the edge bucket (must be > 0 for acceptance; uses the
  Pinnacle close, so it is a post-T evaluation metric).
- Hit rate vs `pin_fair_prob` implied rate.
- Calibration of `pin_fair_prob` against PM-settled outcomes, 5 fixed-width
  bins, per `calibration-check` — a sanity check that Pinnacle's number is a
  usable probability on this population (`well-calibrated` /
  `usable-with-caveats` required; `poorly-calibrated` blocks acceptance).
- Diagnostics only, never for acceptance: Δ at 0.01 and 0.05 thresholds;
  ML vs total split.

## validation_design
No model is fitted, so there is no training fold — but the read still follows
`validation-design`: report in chronological 2-week blocks per sport (block
= fold), with n, W-L, Δ, z per block and the pooled result. Acceptance needs
the pooled criterion AND Δ > 0 in a majority of blocks that have n ≥ 20.
One read per sport at the data threshold; a second read only at 2× n. No
threshold, bucket, or population change after a read (see `failure_and_stop`).

## data_requirements_and_provenance
- n ≥ 100 rows in `population_and_exclusions` for the sport.
- Anchor coverage ≥ 50% of eligible sightings in that sport (anchored ÷
  eligible); below that the read is `inconclusive — coverage`, not a result,
  because the matched subsample is biased toward book/PM agreement.
- Median `pin_captured_at − pin_feed_at` ≤ 20 min (TTL honoured).
- Provenance: Pinnacle via The Odds API (`bookmakers=pinnacle`,
  `markets=h2h,totals`), de-vigged by `extractPinnaclePrices` (proportional
  for two-way, three-way incl. draw for soccer); totals matched on exact
  line only — a documented biased subsample (docs/KNOWN-ISSUES.md).

## uncertainty_plan
Per-row ROI variance → SE → z, reported with n per bucket and per block.
Report the interval, not just the point. Multiple sports = multiple tests:
each sport is its own pre-registered test with its own n; do not read a
sport before it qualifies because another sport looked good.

## acceptance_rule
For a sport: `n ≥ 100` AND `Δ > 0` AND `z ≥ 2` AND edge-bucket
`pin_clv > 0` (on ≥ 10 rows carrying it) AND majority-of-blocks positive AND
`pin_fair_prob` calibration not `poorly-calibrated`.
- Met on the naive split → `pin_edge ≥ 0.03` joins that sport's gate vector
  (strategy era bump, `docs/STRATEGY.md` table row, `git tag`).
- Met on the combined split (holder-pass AND pin_edge) in a probation sport
  → grounds to promote that sport to live on the combined rule (shadow-run
  the combined policy a further n ≥ 50 first).

## failure_and_stop_conditions
- `Δ ≤ 0` at n ≥ 200 → hypothesis rejected for that sport; record it.
- Coverage < 50% at n ≥ 100 → inconclusive; fix coverage, do not read.
- Any post-T feature found in the split (leakage audit `NOT CLEAN`) →
  result void, repair, rerun from scratch.
- Re-tuning the 0.03 threshold after seeing results is prohibited; a new
  threshold is a new charter (v2) and its prior read is exploratory.

## out_of_scope_and_prohibited_uses
- No live bet is placed on pin_edge alone before the era bump.
- No claim that Polymarket prices beat Pinnacle in general; the population
  is sharp-signal candidates only.
- Not a test of the holder signal (that is the tennis/sport verdicts).
- Soccer totals (quarter-line mismatch) and any sport with < 50% coverage.

## required_artifacts
`docs/audits/<date>-pin-edge-<sport>.md` containing: population counts and
coverage, fold/block table, Δ/z/pin_clv, calibration bins, the leakage-audit
stub verdict, and the decision. Plus the memory/STRATEGY updates on an era
bump.

## Leakage pre-audit (`leakage-audit`, run at charter time)
| item | finding |
|---|---|
| target lineage | `roi` written by settlement from Gamma resolution; not present at T; not an input |
| feature availability | `price` at T; `pin_fair_prob` from feed at `pin_feed_at ≤ T` (TTL 20 min, recorded per row) |
| temporal transform | none (no rolling stats) |
| joins | Polymarket title → Odds API event is a **display-name join** (`parseTitleTeams` + `matchOddsApiEvent`, team-name normalisation + 45-min / 6-h time gap). Failure mode is NON-capture (coverage), not contamination. Flagged `REVIEW REQUIRED` for coverage bias until the first read reports the anchored ÷ eligible ratio |
| preprocessing / tuning | none; threshold fixed a priori |
| split | chronological blocks; no training set |
| duplicates / groups | dedup to first sighting per (market, side); paired rows of the same game (over/under, both ML sides) can both appear — reported, not deduped, because each is its own would-have-bet decision |
| **verdict** | `REVIEW REQUIRED` (coverage-bias item open) — becomes `CLEAN` when the first read documents coverage ≥ 50% and staleness ≤ TTL |
