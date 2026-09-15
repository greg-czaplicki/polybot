# Charter — MLB policy grade floor, one notch down (B → C)

Written 2026-09-15 under the `sports-modeling-doctrine` schema, BEFORE any
confirmatory row exists. Owner decision the same day: two-block design.
The rule is code (`src/lib/grade-floor-test.ts`); the forward start and
every threshold are constants in that file. Changing the cohort, the
blocks, the thresholds or the metric after 2026-09-16 means a NEW charter
version; the prior result is then labelled exploratory.

## question
Does lowering the MLB live-book policy floor from grade B to grade C — one
notch on the existing ordinal grade ladder, no other change — add picks that
make money?

## origin (why this is a hypothesis, not a result)
The MLB `below_policy_grade` sole-blocker cohort read +17.7 % at row z 1.56
on 103 rows (WATCH). Exploring it on 2026-09-15
([audit](../audits/2026-09-15-mlb-depth-and-watch-cohorts.md)) showed it is
two populations: grade C 32-20 +34.7 % (clustered z 2.3, positive in both
months and both market types, top-5 wins 45 % of units) and grade D 22-29
+0.3 %. That split was made AFTER seeing the rows. The 52 grade-C rows are
therefore block 1 (in-sample, sign and volume only) and cannot be the test.

## sport_and_competition
MLB only. Regular season ends 2026-09-27; the forward block spans the last
regular-season weeks and the postseason (fewer games, deeper markets).

## population_and_exclusions
`shadow_candidates` rows with `sport_tag = 'mlb'`, `reject_reason =
'below_policy_grade'`, `grade = 'C'`, settled win/loss, that pass
`SOLE_BLOCKER_SQL` (every other vector gate passed; the grade was the only
blocker). Grade D rows are excluded by construction and are never part of
a promotion. Pushes excluded.

- Block 1: `created_at < 2026-09-16T00:00:00Z` (1789516800).
- Block 2: `created_at ≥ 2026-09-16T00:00:00Z`.
- Pooled: both.

## grain_and_natural_key
One row = one shadow candidate. z event-clustered (`eventClusterKey`: series
+ matchup + event time), the same clustering as the promotion verdict.

## analysis_type
Predictive, prospective for block 2. No causal claim.

## decision_time_and_horizon
The candidate's own sighting (`created_at`, inside the 60–180 min window);
horizon = settlement; ROI = the shadow row's stored `roi`.

## baselines
- Zero.
- The live book's out-of-sample ROI (+26.7 % on 127 picks since 2026-07-20)
  — for context only; the test does not require grade C to match it.

## primary_metric_and_others
Primary: mean ROI per row and event-clustered z, per block and pooled.
Secondary: wins/n, rows per week, moneyline vs total split (display only).
No CLV term (2026-09-15 promotion-rule amendment).

## validation_and_acceptance
PASS requires BOTH:
1. Block 2 (forward): n ≥ 30, clustered z ≥ 1.5, ROI > 0.
2. Pooled: n ≥ 80, clustered z ≥ 2.

Read from the `/shadow` panel "MLB grade floor B→C" (verdict computed by
`gradeFloorRead`), never from an ad-hoc cut. PASS → era bump: MLB policy
floor B → C (`strategy-vN`, STRATEGY.md era row), live picks at base stake.
Block 2 at n ≥ 30 with ROI ≤ 0 → recorded "cannot make money", dropped, no
re-cut. Block 2 not reaching n = 30 by the end of the 2026 postseason →
the test carries into April 2027 unchanged (the constants do not move).

Expected volume ≈ 7 rows/week (10, 5, 6, 8, 16, 5, 2 over the seven weeks
to 2026-09-14), so block 2 reaches n = 30 around the end of the regular
season or early postseason.

## data_requirements
Shadow book recording (every 2-min sync), `grade` stamped on every row
(it is), settlement running. Nothing new to collect.

## known_leakage_risks
- Selection after the fact — the reason for the two-block design. Block 1
  is printed for sign; the decision needs block 2 on its own AND pooled.
- Multiple comparisons: this is one of two WATCH cohorts examined and one of
  two grade notches; block 2's own z ≥ 1.5 at n ≥ 30 is the control.
- Postseason composition shift (fewer, sharper markets) can move both ROI
  and volume; no adjustment — the rule is read as written.
- Grade is computed from the same holder snapshot as the other gates, so
  rows are correlated with the live book's picks on the same game; the
  event-clustered z handles same-game siblings, not the shared signal.
