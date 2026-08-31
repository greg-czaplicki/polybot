# Tennis sharp-signal verdict — first read (2026-08-31)

Read taken under `docs/charters/tennis-verdict.md` (written earlier the same
day, before this read; criteria inherited verbatim from `gate-verdict.ts`
2026-07-30/08-28 and the 2026-08-23 STRATEGY registration). Read trigger:
n ≈ 200 total settled tennis probation rows — met at 216 (136 ATP + 80 WTA,
2026-08-18 → 2026-08-30), ~2 weeks ahead of the mid-Sept projection because
the US Open accelerated volume.

## Verdict: HOLD both tours. Tennis stays shadow-only.

Sole-blocker cohort (all five vector gates pass, the only promotion input);
dedup asserted: 216/216 settled rows distinct on (condition_id, sharp_side).

| criterion | ATP | WTA | required |
|---|---|---|---|
| n (settled sole-blocker) | **4** (1-3) | **4** (3-1) | ≥ 50 |
| event-clustered z | **null** (4 clusters < 5) | **null** (4 clusters < 5) | ≥ 2 |
| CLV (source) | **−3.25%** (polymarket, pin_n=2 < 10) | **−0.75%** (polymarket, pin_n=2 < 10) | > 0 |
| cohort ROI | −26.5% | +88.0% | — |

Every criterion fails on both tours. WTA's +88% is 4 rows — noise by
construction (z null), and its CLV is negative.

## The real finding: the checkpoint is structurally unreachable

Clean rate (sole-blocker ÷ settled): ATP 4/136 = **2.9%**, WTA 4/80 =
**5.0%**, pooled 3.7% — matching the 2026-08-23 diagnosis (~1–4%). Reaching
n = 50 needs ~1,700 settled ATP rows / ~1,000 WTA rows. Volume during the
US Open fortnight — the season's PEAK — was ~17 settled rows/day across
both tours; at that unsustainable ceiling ATP is ~4 months away, and
off-Major volume is far lower. Per the charter's pre-registered stop
condition this is recorded as **checkpoint unreachable**: tennis stays
shadow-only, the checkpoint is NOT loosened to make tennis readable, and
further tennis hypotheses route through their own charters:

- **WTA fade** (`docs/charters/fade-inversion.md`) — n ≥ 100 would-have-bet
  WTA rows, ≈ mid-Oct.
- **pin_edge combined rule** (`docs/charters/pin-edge-gate.md`, clause (b))
  — a probation-sport promotion path that does not depend on the holder
  vector's clean rate.

## Diagnostics (never promotion inputs)

Raw first-fired cut, DIRECTIONAL ONLY: ATP 68-68, +3.1% ROI, avg pin_clv
−0.28% (n=19) — flat. WTA 33-47, **−27.4%** ROI, avg pin_clv −0.72% (n=14)
— consistent with the inversion the fade charter is built on.

Why the clean rate is so low — vector-gate failure counts on settled
probation rows (rows fail several at once): grade_vs_base 114/136 ATP,
65/80 WTA; edge_rating 105 / 60; price_edge 93 / 57; score_differential
68 / 35; signal_score 9 / 2. The MLB-calibrated grade ladder simply does
not fire on tennis holder patterns.

Price-floor slice: 19/216 settled rows priced < 0.25 (probation fired
before the era-v9 floor), including 2 of the 8 sole-blocker rows (ATP
loss @0.15, WTA loss @0.21) — both losses, consistent with the v9
phantom-edge mechanism; noted, not removed (population is charter-fixed).

Anchor coverage at read time: 35/136 ATP, 23/80 WTA settled rows anchored
(~27%) — thin; the US Open tennis-boost (0d7b103, through 9/13) raises it
prospectively. Tennis pin_clv remains "vs Pinnacle at session time".

## Next read
At 2× trigger (~430 total settled rows) or a tour reaching n ≥ 50
sole-blocker rows, whichever comes first — expected only if the clean-rate
picture changes, which nothing here predicts.
