# Charter — Tennis sharp-signal verdict (ATP / WTA promotion)

Written 2026-08-31 under the `sports-modeling-doctrine` schema
(`.agents/skills/sports-modeling-doctrine`). This is the user-owned contract
for the test pre-registered 2026-08-23 in `docs/STRATEGY.md` ("Tennis
sharp-signal verdict"). Written BEFORE its read but AFTER data existed
(216 settled rows at charter time): every criterion below restates the
2026-08-23 STRATEGY row and the promotion rule already frozen as code
(`src/lib/gate-verdict.ts`, pre-registered 2026-07-30, amended 2026-08-28) —
nothing was chosen in view of the data. Changing population, criteria, or
read trigger after this point means a NEW charter version; the prior result
is then labelled exploratory.

## question
Does the holder-quality sharp signal, as expressed by the five vector gates,
earn ATP and/or WTA promotion from `<tour>_league_probation` (shadow-only)
to live picking — under the standard checkpoint, with no tennis-specific
tuning?

## sport_and_competition
ATP and WTA evaluated SEPARATELY, never pooled (the 2026-08-23 diagnosis
found tour-level behavior differs; WTA inverts outright). Tournament mix is
whatever Polymarket lists (Majors + ATP/WTA tour events).

## population_and_exclusions
`shadow_candidates` rows with:
- `reject_reason = 'atp_league_probation'` / `'wta_league_probation'`
  (probation live since 2026-08-18, d8f87b7);
- all five vector gates passing per `SOLE_BLOCKER_SQL`
  (`src/server/api/shadow-sql.ts`): `price_edge`, `edge_rating`,
  `signal_score`, `score_differential`, `grade_vs_base` all `pass = 1`
  (`pass = null` counts as NOT passing) — the would-have-bet cohort;
- `status ∈ {win, loss}`; pushes reported as a count, excluded from ROI.
No additional filters: the population is exactly what the /shadow verdict
machinery (`getShadowBookSummaryFn` sport cut) computes, because the
pre-registered rule IS that code. Rows with `price < 0.25` are inside the
cohort when the probation gate fired before the era-v9 entry floor; they are
reported as a diagnostic slice, not removed (removing them post hoc would be
a population change).

## grain_and_natural_key
One row = one (market, side): `condition_id + sharp_side`, first sighting.
Verified at charter time: 216/216 settled probation rows are already
distinct on this key, so dedup is currently a no-op; the read must still
assert it.

## analysis_type
Predictive (prospective shadow record). No causal claim.

## decision_time_and_horizon
T = sighting (`created_at`); the gate vector, price, and reject reason are
computed at T. Horizon = match settlement. `roi`, `clv`, `pin_clv` are
post-T evaluation metrics, never features.

## target_or_estimand
Per-row ROI at sighting price (win → `(1 − price)/price`, loss → `−1`).
Estimand: mean ROI of the per-tour sole-blocker cohort.

## base_rate_or_null
Null: the holder signal carries no information in the tour → cohort ROI ≈ 0
minus spread costs, and Pinnacle prices the entries at or below fair
(`pin_clv ≤ 0`).

## naive_and_strong_baselines
- Naive: all settled probation rows in the tour (first-fired raw cut —
  DIRECTIONAL ONLY, never a promotion input; the twice-made mistake).
- Strong: MLB's live-book record does NOT transfer (per the season plan,
  2026-08-27) — there is no cross-sport baseline; the tour must clear the
  absolute checkpoint.

## primary_metric_and_direction
The standard promotion rule, verbatim from `gate-verdict.ts`:
`n ≥ 50` settled sole-blocker rows AND event-clustered `z ≥ 2` on ROI
(clusters = match: title-before-":" + event_time; fewer than 5 clusters
fails the criterion, no per-row fallback) AND `pin_clv > 0` (Pinnacle
source once ≥ 10 rows carry it; Polymarket self-close fallback below that).
Higher ROI is better. Per tour.

## secondary_metrics
Diagnostics only, never for acceptance: raw-cut W-L/ROI per tour;
`pin_move` (offset-free close-vs-anchor drift); anchor coverage
(anchored ÷ eligible); the `price < 0.25` slice; clean rate (sole-blocker ÷
settled) — the checkpoint-reachability number.

## validation_design
No fitted model. Read reports per-tour totals plus chronological 2-week
blocks when a block has n ≥ 20 (at charter-time volume, blocks will be
degenerate — report and say so). ONE read at the trigger; the next read at
2× the trigger or at a tour reaching `n ≥ 50` sole-blocker rows, whichever
comes first.

## data_requirements_and_provenance
- Read trigger: n ≈ 200 TOTAL settled tennis probation rows (both tours
  combined) — the 2026-08-23 registration, projected then for ~mid-Sept.
- Pinnacle provenance: OddsPapi (US Open per-tournament ids, session-time
  anchors — tennis `pin_clv` is "vs Pinnacle at session time", a weaker
  proxy than a true close; carries the ≈ −0.3%/side PM-spread offset).
- Anchor coverage is NOT gating for this read (the verdict's CLV criterion
  has its own n ≥ 10 pin-row switch), but is reported.

## uncertainty_plan
Event-clustered z per the 2026-08-28 amendment (match = cluster). Report n,
W-L, ROI, z (clustered and row), CLV source and n per tour. Two tours = two
tests; do not read one tour early because the other qualified.

## acceptance_rule
A tour meeting the primary metric → `READY`: grounds to design promotion to
a probation live tier (era bump, own gates review first). Anything short →
`HOLD`, tennis stays shadow-only. `WATCH` (informational) per
`gate-verdict.ts` requires n ≥ 25, z ≥ 1, ROI > 0, CLV > 0.

## failure_and_stop_conditions
- Clean rate so low that `n ≥ 50` is unreachable within a season at
  observed volume → record "checkpoint unreachable", keep shadow-only, and
  route further tennis hypotheses through their own charters (WTA fade,
  pin_edge combined rule) — do NOT loosen this checkpoint to make tennis
  readable.
- Any post-T feature in the cut → read void, repair, rerun.
- No criterion change after a read; a changed rule is charter v2.

## out_of_scope_and_prohibited_uses
- Not a test of the fade/inversion hypothesis (that is
  `docs/charters/fade-inversion.md`, WTA instance).
- Not a test of `pin_edge` (that is `docs/charters/pin-edge-gate.md`; its
  clause (b) combined rule is a separate promotion path for probation
  sports).
- No live tennis bet on any cut of this data before an era bump.

## required_artifacts
`docs/audits/<date>-tennis-verdict.md`: per-tour verdict with all criterion
values, clean rate, raw directional cut (labelled), price-floor and
coverage diagnostics, leakage stub, decision. STRATEGY row updated with the
outcome; memory updated.

## Leakage pre-audit (`leakage-audit`, run at charter time)
| item | finding |
|---|---|
| target lineage | `roi`/`status` written at settlement from Gamma resolution; not present at T; not an input |
| feature availability | gate vector, `price`, `reject_reason` computed at sighting and stored per row (migration 0027); no re-derivation at read time |
| temporal transform | none |
| joins | none in the primary read (no book join needed; `pin_clv` is evaluation-only). Tennis PM-title parsing quirks affect anchor COVERAGE, not the cohort |
| preprocessing / tuning | none; every threshold inherited from the 2026-07-30/08-28 pre-registered rule, none tennis-tuned |
| split | chronological blocks only; no training set |
| duplicates / groups | (market, side) dedup asserted at read; match-level clustering handles sibling markets in z |
| **verdict** | `CLEAN` — with the standing caveat that the charter postdates data existence; mitigated because every criterion is inherited verbatim from rules frozen before the cohort existed (gate-verdict.ts 2026-07-30, STRATEGY row 2026-08-23) |
