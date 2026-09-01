# tennis-v2 Stage 1 — baselines + Elo, validation-years read (2026-09-01)

Under `docs/charters/tennis-ground-up.md`. Data: tennis-data.co.uk
snapshot 2015–2026 (`data/tennis/`, committed, checksummed; see README
caveats — odds are "late pre-match" quotes, and Pinnacle coverage
collapses in the 2026 files). Script: `data/tennis/stage1_elo.py`.
Boundaries held: warmup ≤2020, tuning on 2021 only, validation
2022–2025. **2026 has not been scored** — it stays untouched until the
leakage pre-audit passes; that read happens once.

## Locked models

- null — market favorite at expanding constant base rate.
- market — de-vigged implied, PS else Avg (locked before fitting).
- elo — surface-blended (w=0.25 both tours, tuned 2021), K=250/(5+n)^0.4,
  probability shrinkage toward 0.5 (ATP a=0.90, WTA a=0.95, tuned 2021).

**Revision disclosure**: shrinkage was added after the first validation
pass showed systematic overconfidence (ECE 4.6%/3.8%, favorites
overrated). Its parameter was tuned on 2021 only, but the *decision* to
add it was motivated by validation-fold results — mild reuse, disclosed
here; the 2026 test is unaffected and will arbitrate.

## Results (held-out log-loss; n excludes cold-start ~8% and no-odds rows)

| | n | null | market | elo | elo beats null |
|---|---|---|---|---|---|
| ATP 2022 | 2423 | .6329 | .5886 | .6177 | yes |
| ATP 2023 | 2455 | .6352 | .5951 | .6353 | no (dead even) |
| ATP 2024 | 2501 | .6231 | .5880 | .6247 | no |
| ATP 2025 | 2429 | .6322 | .6035 | .6353 | no |
| **ATP all** | 9808 | .6308 | .5937 | **.6282** | pooled only, 1/4 folds |
| WTA 2022 | 2103 | .6342 | .6009 | .6347 | no (hair) |
| WTA 2023 | 2258 | .6297 | .5987 | .6244 | yes |
| WTA 2024 | 2303 | .6423 | .5985 | .6267 | yes |
| WTA 2025 | 2281 | .6314 | .6041 | .6310 | yes (hair) |
| **WTA all** | 8945 | .6345 | .6005 | **.6291** | pooled + 3/4 folds |

Calibration after shrinkage: ECE 2.9% (ATP) / 3.0% (WTA), residual
favorite-bias small. |elo − market| gap: median .06, p90 .16–.17 both
tours.

## Verdicts per the charter's acceptance rule

- **ATP: R2 (model edge) is DROPPED.** The candidate beats null in 1 of
  4 folds (pooled margin +.003 is not a "meaningful majority"). The
  market baseline dominates by .035 — as the charter predicted, but the
  model doesn't even clear the null bar on ATP. Valid result, recorded.
- **WTA: R2 conditionally survives** to the thresholds addendum (3/4
  folds + pooled, acceptable calibration). Fold margins are small
  (.003–.016); the addendum must set θ2 conservatively.
- **R1 (pin edge) is unaffected** — it never used the model.
- **θ2 floor, from the gap distribution**: the model's own typical
  disagreement with a sharp book is ~.06 median / ~.16 p90. A PM-vs-model
  divergence smaller than the model's own error band is noise; any WTA
  R2 threshold must sit ≳ p90 (≈ .16), which will fire rarely. R2 is a
  tail-catcher, not a volume strategy — consistent with its charter role
  (extend R1 past the quote budget, nothing more).
- The 2026 read (post leakage-audit) also inherits the documented
  baseline source-shift (mostly Avg, not Pinnacle) — comparisons vs
  2021–2025 must carry that caveat.

## Remaining before Stage 2 shadow rows

1. Leakage pre-audit (`leakage-audit` skill) → then the single 2026 test read.
2. Thresholds addendum: θ1 (R1) — blocked on the clause-(b) coordination
   decision; θ2 (WTA-only R2) per above; R3 blocked on the ~mid-Oct
   specialization read per Stage 1b (`2026-09-01-tennis-holder-composition.md`).
3. Implement the `tennis_v2_paper` shadow lane + per-rule stamping.
