# 2026-09-15 — What would make the MLB book bigger: book depth + the two WATCH cohorts

Owner question after the hot-record reads: "what would actually make the MLB
book bigger?" Two measurements, both exploratory (no rule changed).

## 1. Book depth at pick time (polybook `tob_minute`, recording since 2026-09-09)

Script: `/root/polybook/depth_read.py` (VPS), output
`/root/polybook/data/depth_read_2026-09-15.txt`. USD fillable at the quoted
ask = best-ask size × price; 5-level depth = polybook's `ask_depth5`.

| population | n | top-of-book ask USD: p10 / p25 / median | 5-level median |
|---|---|---|---|
| live picks since 9/9, at `picked_at` | 8 | min $1,023 / $5,976 / $53,352 | $97,041 |
| would-be picks (both WATCH cohorts) since 9/9, at `created_at` | 17 | min $2,357 / $11,395 / $12,424 | $107,025 |
| all MLB sides, ask 0.35–0.65, T-90m | 535 | $165 / $2,416 / $14,388 | $74,190 |
| … moneylines only, T-90m | 159 | $1,251 / $17,676 / $49,567 | — |
| … totals only, T-90m | 279 | $99 / $1,396 / $8,215 | — |

85 % of MLB sides in the price band have ≥ $500 at the top of book at T-90m,
76 % have ≥ $2,000. The current $8 stake is ~0.1 % of a typical top level.
Conclusion: a $200 stake fills at the quote on ~85 % of picks and a $500
stake on ~75 %, without touching the second level; totals are the thin side
(p25 $1.4k). Depth is not the constraint on this book at any stake the
bankroll can currently support. Capital is.

## 2. The two WATCH cohorts (sole-blocker, MLB, all settled rows)

### below_policy_grade (54-49, +17.7 %, row z 1.56) splits on the grade ladder itself

| grade (policy floor = B) | w-l | ROI | z | Aug | Sep | ML | totals |
|---|---|---|---|---|---|---|---|
| **C** (one notch below) | 32-20 | **+34.7 %** | **2.3** | 20-10 +44 % | 12-10 +22 % | 14-11 +25 % | 18-9 +43 % (z 2.2) |
| D (two notches) | 22-29 | +0.3 % | 0.0 | — | — | 13-19 −0.2 % | 9-10 +1.1 % |

Grade C is not tail-driven (top-5 wins = 45 % of units, median winning ROI
1.17), positive in both months, positive in both market types, and its rows
sit closer to the live book on every score (signal_score 71 vs 54,
edge_rating 83 vs 73, score_differential 49 vs 33). It is "almost-B" rows.
Volume ≈ 7 rows/week (10, 5, 6, 8, 16, 5, 2 over the last seven weeks).
Grade D is dead flat and should never be promoted; it dilutes the cohort.

This split was made AFTER seeing the rows, so it is a hypothesis, not a
result. Its natural pre-registration: "lower the MLB policy floor by one
notch (B → C)", read on the grade-C sole-blocker cohort. At the standard bar
(n ≥ 100 and clustered z ≥ 2 on fresh rows) that is a 2027 read — the
regular season ends 2026-09-27 and ~7 rows/week gets to roughly n = 65 by
then. A two-block design (in-sample 52 rows as block 1; forward block from
2026-09-16 at n ≥ 30, z ≥ 1.5, ROI > 0; pooled n ≥ 80, z ≥ 2) could read
in the postseason. The bar is the owner's call and must be written before
the forward rows exist.

### signal_score_saturation (27-24, +16.9 %, clustered z 1.19): a moneyline streak that reversed

| | Aug | Sep |
|---|---|---|
| moneyline | 17-4, +88.8 % (z 4.2) | 2-7, −59.2 % |
| totals | 8-11, −14.2 % | 0-2 |

96 % of the cohort's units come from its top five wins. Totals are negative
in both months. This is the same shape the June anti-signal read had, one
hot month wide. Not a promotion candidate on this evidence; it stays WATCH
under the rule and reads itself.

## What would make the book bigger, in order
1. Bankroll. Same picks at $40 instead of $8 would have made ~5× the money
   at the same risk fraction; the book fills that size at the quote.
2. Grade C. Roughly +7 picks/week at (in-sample) about double the live
   book's ROI per pick — IF the forward block confirms.
3. Maker-side execution before stakes pass ~$100 (2026-09-11 read: +0.4 c/share).

No rule changed. Grade-C pre-registration pending the owner's choice of bar.
