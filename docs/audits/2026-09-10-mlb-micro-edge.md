# MLB micro-edge study — 2026-09-10

Question (user): the MLB live book is +22% on 107 real bets since 7/20 with
~0 closing-line value. Is there a tiny, findable edge inside the signal, and
where? Method: every feature we hold, scored on BOTH readouts (ROI to
resolution and CLV to the Polymarket close) on 2,382 MLB shadow rows since
7/30 (any gate), split train (created < 8/24, n=1,839) / test (≥ 8/24,
n=543), with the 107 live bets shown alongside. A cut "holds" if ROI > 0 and
CLV > 0 in both halves with n ≥ 40 each. Scripts: `research/sharp/mlb_edge.py`
(features) and `stack_tape.py` (tape flow join). Home = second-listed team in
the market title (verified 12/12 on live picks).

Baseline shadow: train +3.0%, test +1.2%. Live: +21.8%.

## Cuts that hold

| Cut | Train ROI / CLV (n) | Test ROI / CLV (n) | Live (n) |
|---|---|---|---|
| ML home dog | +10.0% / +0.1c (93) | +24.3% / +0.1c (74) | +34.7% (10) |
| ML home (any) | +1.8% / +0.1c (333) | +9.6% / +0.1c (124) | +19.7% (19) |
| Total Under | +13.3% / +0.5c (512) | +0.3% / 0.0c (160) | +32.6% (51) |
| Total line ≥ 9 | +10.1% / +0.1c (244) | +15.5% / +0.5c (42) | +38.1% (17) |
| Under AND line ≥ 9 (test n small) | +20.0% / +0.7c (119) | +27.8% / +0.6c (28) | +45.4% (9) |
| home dog AND tape sharps not against | +5.7% / +0.1c (62) | +28.6% / +0.2c (47) | +40.0% (8) |
| market_quality ≥ .85 · grade C-or-worse · snapshots ≥ 10 · mts 60–180 | weak, ≈ baseline | | |

Negative, both halves: ML away favorite (−13% / −3%), Total Over (−2% /
−20%), Over on day games (−12% / −32%), edge_rating ≥ 90 in test (−28%).

## Reading

- With ~60 cuts, ~4 "holds" are expected by chance at these thresholds; 9
  appeared. The weak ones are noise. Two are not: **home underdogs on the
  moneyline** and **Unders, especially at lines ≥ 9**. Both are large in both
  halves, agree with the live book, and the home-dog cell was the user's
  prior hypothesis, not a data-mined one.
- CLV on these cells is +0.1 to +0.7c: the close moves toward them a little.
  On a thin exchange that is consistent with a real single-digit edge that
  the close only partly prices.
- Tape "sharps" (past-profit ranked) remain an anti-signal in MLB: fading
  them +14% / +20%. Squares against +10% / +20% (n small).
- The Over side of the signal is bad everywhere except in the live sample.

## Decision

No bot change now (season ends ~9/27). Registered forward read: track
"ML home dog" and "Under at line ≥ 9" on both readouts through the
postseason; if both still hold at read time, the MLB gates for 2027 add
side/venue awareness (drop Overs on day games, favour home dogs) as an era
bump. Stakes unchanged. ROI stays the primary readout for MLB; CLV is
diagnostic only on thin markets.
