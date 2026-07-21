# Strategy Versioning

Every pick is stamped with `strategy_version = <era>+<build commit>` at
creation. The **era** changes only when picking behavior changes (gates,
scoring, calibration, grading) — never for UI, infra, or data-quality fixes.
Audits should `GROUP BY` era; the commit SHA identifies the exact code.

Backfilled rows (picks created before stamping existed, assigned by
`picked_at` against deploy timestamps) carry the suffix `+backfill`.

## Eras

| Era | Active from (UTC) | Defined by |
|---|---|---|
| `v1-baseline` | 2026-04-13 (first stored picks) | Initial sharp-side model. ML-only scoring; totals not scored. |
| `v2-totals-scoring` | 2026-04-24 01:14 | Totals scoring split (side-aware OU scorers), signal-saturation fix (noveltyScore), priceEdge in ranking, L2 merge-order fix. Deployed from working tree; committed later in `8630bf8`. |
| `v3-calibration-band-pass` | 2026-05-11 22:28 | Calibration round: scoreDiff ≥ 20, edgeRating band-pass [66,72)∪[80,90), rebucketed Quality/PriceEdge, NBA >90-min timing gate. Commits `5922224`..`607584a` (tag `strategy-v3`). |
| `v4-realized-edge-gates` | 2026-06-25 22:05 | signal_score ≥ 90 hard gate, price_edge ≥ 0.25 floor, grading by realized edge, bot fill reporting. Commits `57696b3`..`cefa752` (tag `strategy-v4`). |

Era boundaries are **deploy** timestamps, not commit timestamps — early work
was sometimes deployed before being committed. The one pick created between
the two Jun 25 deploys (ss=94.3 straggler, 20:31 UTC) is classified `v3`
because it predates the gate going live.

## Bumping

1. Update `STRATEGY_VERSION` in `src/lib/strategy-version.ts`.
2. Add a row to the table above with the deploy time and what changed.
3. Tag the commit: `git tag strategy-vN <sha>`.
