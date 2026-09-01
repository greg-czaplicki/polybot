# tennis-v2 Addendum 1 — Stage 2 thresholds (FINAL 2026-09-01)

Written after Stage 1 completed (validation read + one-shot 2026 test,
`docs/audits/2026-09-01-tennis-v2-stage1.md`; leakage audit passed).
FINAL: the clause-(b) fold-in was decided by the owner 2026-09-01
(fold into R1). Per the charter, nothing here changes after the first
`tennis_v2_paper` row is recorded.

## R2 (model edge) — WTA only; ATP R2 is dead per Stage 1

- Model: `stage1_elo.py` LOCKED params (blend w=0.25, shrink a=0.95),
  ratings maintained forward from the full snapshot; as-of date recorded
  per evaluation.
- Fire when ALL hold at decision time T (≥30 min pre-session):
  - no fresh Pinnacle quote for the match (else R1 owns it);
  - both players ≥ 5 rated matches (cold-start never fires);
  - PM mid-price vs model: |pm − p_model| ≥ **θ2 = 0.16** (the p90 of
    the model's own disagreement with sharp books, replicated 2022-25
    and 2026 at .160–.170 — divergence below the model's error band is
    noise);
  - PM entry price ≥ 0.25 (era-v9 floor) and ≤ 0.75 (symmetric cap: a
    16-cent model edge at extreme prices is dominated by calibration
    tail error, ECE bins are thinnest there).
- Side: the PM side the model prices higher than the market does.
- Expected volume: LOW (tail-catcher by design).

## R1 (pin edge) — θ1 pending the open decision

- Proposed: fire when |pm − pin_devigged| ≥ **θ1 = 0.05** at T, both
  tours, entry price in [0.25, 0.75], Pinnacle quote ≤ 20 min stale.
  Rationale: Pinnacle tennis vig ≈ 2.6–2.9% (audit finding 6), so 5¢
  clears the vig band ~2× and is far above PM tick noise; unlike θ2 it
  needs no model-error buffer because the reference is a sharp quote,
  not an estimate.
- **DECIDED (owner, 2026-09-01): folded.** `pin-edge-gate.md` clause
  (b)'s tennis read is retired with a cross-reference note; all tennis
  pin-divergence verdicts come from R1's cohort under this charter.
  θ1 = 0.05 is FINAL.

## Bookkeeping (both rules)

- Lane: `shadow_candidates.reject_reason = 'tennis_v2_paper'`; rule and
  inputs stamped in `warnings_json` (`{rule, theta, pm, ref, model_asof}`).
- One row per (condition_id, rule); one pick per market group; existing
  probation lanes untouched — the legacy tennis population stays clean.
- Promotion bar per charter: n ≥ 50 settled, match-clustered z ≥ 2,
  mean pin_clv > 0, per rule per tour; never loosened.
- Duration cap (charter open decision 2, adopted): one calendar quarter
  per rule from its first row → mandatory continue/stop review.
- Thesis verdict: R3-vs-R1 comparison rules to be pre-registered in
  Addendum 2 (R3 blocked on the ~mid-Oct specialization read + Stage 1b
  liquidity-filter design).
