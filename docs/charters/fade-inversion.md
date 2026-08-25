# Charter — Fade the inverted sharp signal (`fade-inversion`)

Written 2026-08-25 under the `sports-modeling-doctrine` schema. One charter,
parameterized by sport; each **instance** below fixes its own conditioning
hypothesis, population, and n before its data exists. Adding an instance
later is allowed (it is a new pre-registration); changing an existing
instance after its read is not.

## question
In sports where the holder-quality ("sharp") signal is systematically on the
WRONG side, is betting the opposite side of the signal positive-ROI — and
cheap against Pinnacle — under the conditioning named per instance?

## why this can be real (mechanism, stated up front)
"No signal" and "inverted signal" are different. No signal → both sides run
at ≈ −spread; nothing to fade. Inverted → the holders we score as sharp are
systematically wrong, most plausibly because in that sport the metric is
picking up **large public money** (retail whales on favorites) that the
market then fades. The 2026-05-11 NBA forensic found exactly this shape
(anti-signal concentrated in favorites picked 90+ min out). A fade is only
credible when the instance names such a mechanism AND the fade side is
priced below Pinnacle — otherwise it is betting into fair prices and paying
spread.

## grain_and_natural_key
First sighting per (`condition_id`, `sharp_side`), earliest `created_at`,
on a two-way market (`moneyline` or `total`; soccer three-way ML and
draw-question markets are excluded — "the other side" is not one outcome).

## analysis_type
Predictive (prospective). Decision at T = sighting.

## decision_time_and_horizon
T = sighting. Features legal at T: `price`, gate vector, `reject_reason`,
sport, `minutes_to_start`, favorite/underdog role (= price ≥ 0.5 at T),
`pin_fair_prob` where anchored (`pin_feed_at ≤ T`). Post-T, evaluation
only: `status`, `roi`, `pin_clv`, `pin_close_fair_prob`.

## target_or_estimand
Fade ROI per row, derived from the recorded signal-side result:
- signal side `loss` → fade wins: `fade_roi = price / (1 − price)`
- signal side `win` → fade loses: `fade_roi = −1`
- push → excluded, counted.
Fade Pinnacle CLV: `fade_pin_clv = (1 − pin_close_fair_prob) − (1 − price)
= −pin_clv` (two-way identity). Fade entry edge, where anchored:
`fade_pin_edge = (1 − pin_fair_prob) − (1 − price) = price − pin_fair_prob`.

## base_rate_or_null
Null: the signal is uninformative in the sport → fade ROI ≈ −spread (≈ −2 to
−4% at Polymarket touch), fade_pin_clv ≈ 0.

## naive_and_strong_baselines
- Naive: fade every eligible row in the sport (no conditioning).
- Strong simple: fade only where `fade_pin_edge ≥ 0.03` (the Pinnacle-edge
  rule from `pin-edge-gate.md` applied to the fade side). The conditioned
  instance must beat the naive fade, and the case for a fade policy is
  strongest if it also beats — or is subsumed by — the plain Pinnacle-edge
  rule. If pin_edge alone explains the fade, ship pin_edge, not a fade.

## primary_metric_and_direction
Mean fade ROI of the instance cohort, higher is better, `z = mean / SE`
(per-row variance). Locked.

## secondary_metrics
`fade_pin_clv` mean (must be > 0 on ≥ 10 rows carrying it); hit rate;
favorite/underdog and ML/total splits (diagnostic only); per-block table.

## validation_design
No fitted model. Chronological 2-week blocks per instance; acceptance needs
the pooled criterion AND positive fade ROI in a majority of blocks with
n ≥ 20. One read at the instance's n, a second only at 2× n. Conditioning
is fixed by the instance text; discovering a better conditioning after a
read is a NEW instance with its own n, not a revision.

## data_requirements_and_provenance
Per instance n ≥ 100 rows; `pin_clv` coverage ≥ 50% of the cohort's settled
rows (else "inconclusive — coverage"); shadow-book provenance as in
`pin-edge-gate.md`.

## acceptance_rule
Instance: `n ≥ 100` AND fade ROI > 0 AND `z ≥ 2` AND `fade_pin_clv > 0`
(n ≥ 10) AND majority of blocks positive AND the conditioned cohort beats
the naive fade. Then: design the `<sport>_fade` policy (side flip at
sighting, same stake sizing, same timing gates), **shadow-run it a further
n ≥ 50** with its own reject reason, and only then promote via the standard
verdict. A fade is an era bump when it goes live.

## failure_and_stop_conditions
- Fade ROI ≤ 0 at n ≥ 200 → instance rejected; record it.
- `fade_pin_clv ≤ 0` with fade ROI > 0 → "lucky, not cheap" — do not
  promote; re-read at 2× n only.
- Coverage < 50% → inconclusive.
- Leakage audit `NOT CLEAN` → void and rerun.

## out_of_scope_and_prohibited_uses
No live fade before the shadow-run of the designed policy. Not applicable to
three-way markets, props, or spreads. Not a claim about the sport — a claim
about our holder metric in that sport.

## required_artifacts
`docs/audits/<date>-fade-<sport>.md` with cohort counts, block table, fade
ROI / z / fade_pin_clv, naive-vs-conditioned comparison, leakage stub.

---

## Instance: WTA (registered 2026-08-25)
- **Mechanism hypothesis:** WTA holder books are thin and dominated by a
  few large positions on favorites; our quality metric reads them as sharp.
- **Cohort:** WTA rows, `reject_reason = wta_league_probation`, all five
  vector gates pass (the would-have-bet cohort), `price ≥ 0.25`,
  `market_type ∈ {moneyline,total}`, dedup first sighting.
- **Conditioning:** none beyond the would-have-bet cohort (any side, any
  price). Favorite/underdog split reported as a diagnostic only.
- **Evidence at registration (NOT a read):** 2026-08-25 direction cut,
  price ≥ .25: every gate's pass side ≤ fail side; all-pass rows −17..−60%
  ROI, n ≈ 12–17 per cell.
- **n:** 100 would-have-bet rows (≈ mid-Oct at current volume; the US Open
  main draw from ~8/31 should accelerate it). Pinnacle coverage depends on
  an active WTA key that week.

## Instance: NBA (registered 2026-08-25)
- **Mechanism hypothesis:** the May 2026 forensic — sharp side inverts on
  FAVORITES picked 90+ minutes before tip (public money on favorites, market
  moves against it late). The 60–90 min slice was ≈ break-even.
- **Cohort:** NBA rows, `reject_reason = nba_timing_excluded` (the >90-min
  gate, moved below the market-type gates 2026-08-25 so the cohort is
  ML/totals only), `price ≥ 0.25`, dedup first sighting. Season 2026-27
  from opening night (~2026-10-21); no earlier rows exist.
- **Conditioning:** signal side is the favorite (`price ≥ 0.5` at T) AND
  `minutes_to_start > 90`. The unconditioned >90-min cohort is the naive
  baseline; the ≤90-min live cohort is NOT part of this test.
- **n:** 100 conditioned rows (≈ 3–5 weeks into the season at 2026-04
  volume).
