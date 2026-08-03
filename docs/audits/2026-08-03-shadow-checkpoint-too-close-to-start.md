# Shadow-book checkpoint: too_close_to_start at n=100 (2026-08-03)

Pre-registered checkpoint (2026-07-30 shadow-book launch: judge each gate at
n≈100 settled, don't act early). First gate to reach it.

## Verdict: KEEP the gate unchanged

| Population (2026-07-30 → 2026-08-03) | n | Record | Units | ROI | Avg CLV |
| --- | --- | --- | --- | --- | --- |
| too_close_to_start rejects | 100 | 52-48 | +0.21 | +0.2% | **+0.02%** |
| Live book, same window | 14 | 9-5 | +5.31 | +37.9% | +0.43% |

- The early read (+16% at n=17 on 2026-07-31) fully regressed; final is
  break-even.
- CLV ≈ 0 is the decisive number: inside 60 min to start the market has
  priced the whale signal. No edge is being forfeited, and betting there
  would add fill risk for nothing.
- Live picks outperform the reject pool on both ROI and CLV — populations
  order correctly.

## Sub-buckets (informational, not actionable)

- The gate is the bot's `minMinutesToStart=60` (env-driven), NOT the 15m
  figure quoted in early shadow-book notes. By first-sighting time: 45-60m
  n=78 (41-37, +0.03% CLV), 15-30m n=17 (10-7, +0.13%), 30-45m n=3,
  0-15m n=2 — every band break-even with CLV ≈ 0, so the conclusion holds
  across the whole excluded hour, not just its edge. (A first version of
  this doc mislabeled the population "10-15m" via a bad bucket CASE;
  corrected same day.)
- MLB totals rejects 23-18 (+2.91u) vs ML 19-22 (-2.53u) — echoes the
  standing totals>ML pattern; n=41 each, no action.

## Caveat discovered: timing shadows are ungraded

`too_close_to_start` (and `outside_window`) fire in the candidate pre-filter,
BEFORE grading (`src/server/api/bot.ts` prefilter stage), so all their shadow
rows have `grade = NULL`. These gates' shadow books therefore test the raw
sharp-side signal in the excluded window, not "picks that would have passed
every other gate." With CLV at zero the distinction is unlikely to matter
(no sub-population retains edge once price has converged), but any future
proposal to loosen a timing gate must grade its shadow population first.

## Other pre-registered tests — status, do not act yet

- Zero-warning vs warned (within below_policy_grade): n=87 of ~100. Current
  read REVERSED from launch: zero-warning 23-32 (-14.3%), warned 17-15
  (+2.0%). Early +41.5% zero-warning edge looks like noise.
- price_edge_below_floor: 9-2 (+57.7%) at n=11. Interesting vs the deep
  n=97 evidence for the 0.25 floor (2026-06-25 audit). Re-run the priceEdge
  bucket analysis if still positive at n≈50 — do not delete the floor.
- below_policy_grade overall: 40-47 (-8.3%) at n=87 — gate saving money so far.
