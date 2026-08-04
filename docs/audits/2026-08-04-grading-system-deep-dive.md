# 2026-08-04 — Grading System Deep Dive

Motivation: reconstruct how the grading/gating system actually works and where
its thresholds came from, since the pre-Jul-20 calibration decisions were never
documented in-repo. Code map verified against source at `3d4cab3`; data pulled
live from D1 the same day.

## 1. What the sharp signal actually is

**Holder-snapshot based, not trade-flow based.** Per tracked market
(`sharp_money_cache`, 17 active on audit day):

- Top **20 holders per side** are fetched from the Polymarket data API
  (`/holders` per outcome token), converted to USD position sizes.
- Each wallet gets **PnL (day/week/month/all)** from the leaderboard API
  (cached in `wallet_pnl_cache`, 1h TTL — **34,229 wallets** cached to date,
  15,417 profitable all-time) and a **unit size** (typical stake, from open +
  closed positions; `wallet_unit_size_cache`, 6h TTL — 34,140 wallets).
- Per-wallet weight = positionWeight × momentumWeight × pnlTierWeight:
  - **momentum** (the "streak" proxy): 1.5 hot (day+week positive) … 0.5 cold.
  - **pnl tier**: unit-normalized 2.0 → 0.5 (dollar fallback 2.0 ≥ $100k).
- Side sharpScore = normalized weighted sum; **fade boost**: big losers on
  cold streaks boost the *opposite* side up to +30%.
- Sharp side needs a >5-point score gap, else EVEN.
- Order-book L2 data is fetched **after** a pick for diagnostics only; no
  trade/fill stream is ingested anywhere.
- Subrequest budget: only ~6 wallets/market get full 4-period PnL; up to 20
  get ALL-only.

Legacy per-wallet tracking tables (`wallet_watchers`, etc.) were dropped in
migration 0002 — the system does not follow named wallets across markets; it
re-discovers top holders per market snapshot.

## 2. Derived scores

- **edge_rating** = `95·(1−e^(−scoreDiff/25)) + 5·(1−e^(−volume/100k))`,
  × coverage/holder-count penalty. **`qualityBonus` is hard-coded to 0** —
  edge_rating is effectively a monotone transform of scoreDifferential plus
  ≤5 pts of volume. Consequence: the `low_score_differential` (≥20) gate and
  the edge band-pass gate are strongly correlated, not independent signals.
- **signal_score** = 0.7·edgeScore + 0.2·diffScore + trend terms + volume
  delta (±15) + **noveltyScore** (1st snapshot +4 … ≥6th −5; replaced
  stability 2026-04-23 after stale signals saturating at 95–100 showed −12%
  ROI).
- **market_quality (microstructure)** = 0.45·complement + 0.35·depth +
  0.20·priceBand.
- **canonicalScore** = team-trend factor sum (ATS/OU trend, splits, streaks,
  venue/fav-dog, data quality), normalized per bet-type denominator.
- **Letter grade** (`sharp-grade.ts`): ss≥92 → A+ (needs edge≥80 & diff≥30)
  else A; ss≥85 → A (needs edge≥72 & diff≥20) else B; ss≥75 → B.

**A+ is extinct by construction since v4**: A+ requires ss≥92 but the
saturation gate rejects ss≥90, so the live ladder is A/B only. Confirmed in
data — zero A+ picks in v4/v5.

## 3. The gate stack (thresholds as of v5)

Universe: Game-Bets tag, registered series, start ∈ (now, +24h], volume ≥
$10k, main markets only. Pre-filter: not_ready (pnl_coverage ≥ 0.6 and ≥10
holders/side), 15–60 min to start window. Policy: NFL preseason, NHL (all),
NBA >90 min, NCAAB spreads, all spreads excluded; min grade A (loosened to B
for moneyline/total segments). Score gates in order: grade ≥ policy floor →
scoreDiff ≥ 20 → ss < 90 (saturation) → edge band-pass [66,72)∪[80,90) →
microstructure ≥ 0.9 (policy-capped 0.95) → priceEdge ≥ 0.25. Python bot
re-checks price ≤ 0.72, drift ≤ 300 bps, stake 1–50, ≤5 bets.

## 4. Where the thresholds came from (decision archaeology)

| Threshold | Origin |
|---|---|
| edge band-pass [66,72)∪[80,90) | 2026-05-11 calibration round (66–72 profitable +4.5%, 72–80 dead zone, ≥90 saturation) — superseded 2026-03-29 audit |
| scoreDiff ≥ 20 | 2026-05-11 (scoreDiff <20 excluded) |
| ss ≥ 90 saturation gate | 2026-06-25 audit: ss≥90 was a hard anti-signal (−20%/−11% ROI); v3 A+ went 8–15 (−28%) |
| priceEdge ≥ 0.25 | v4 realized-edge gates (2026-06-25) |
| noveltyScore | 2026-04-23 saturation fix |
| NBA >90 min, NHL gate | 2026-05-11 / 2026-03-19 forensics |
| Grade cut-points 92/85/75, weights 0.7/0.2, momentum/pnl tiers | **v1 baseline choices — never calibrated against outcomes** |

## 5. Data verdict (settled picks, by era)

| Era | A+ | A | B |
|---|---|---|---|
| v1 | 7–5 (+18%) | 10–15 (−17%) | 27–18 (+20%) |
| v2 | 4–2 (+40%) | 10–9 (+8%) | 20–34 (−27%) |
| v3 | 8–15 (−28%) | 10–13 (−15%) | 40–31 (+16%) |
| v4 | — | 9–6 (+21%) | 15–10 (+26%) |
| v5 | — | 6–2 (+59%) | 3–2 (+29%) |

Post-gate (v4+v5, n=53): ladder correctly ordered, both grades positive.
Signal-score bands 75–80 (+36%) and 85–90 (+38%) strong; 80–85 flat (n=10).
Moneyline (+49%, n=19) currently ahead of totals (+19%, n=34) — reverses the
2026-06-25 "totals >> ML" observation; small n, keep watching.

## 6. Red flags / follow-ups

1. **edge_rating ≈ scoreDifferential** (qualityBonus=0): the grade's two
   "independent" floors (edge, diff) are one signal counted twice, and
   signal_score is 0.9-weighted on that same signal. The whole grade rests
   more heavily on the holder-score gap than its structure suggests.
   Consider either wiring holder-quality back into edge_rating or collapsing
   the redundant gates.
2. **Duplicated implementations** that can silently diverge: microstructure
   score (`sharp-money.ts:727` vs `bot.ts:348`), signal-score window variant
   (`sharp-grade.ts:173`, unused in prod), `minPriceEdgeForConfidence`
   (re-implemented in `manual-picks.ts:924`).
3. **Momentum/pnl-tier weights and grade cut-points are uncalibrated v1
   constants.** The shadow book now provides the apparatus to test them.
4. **price_edge_below_floor shadow is 9–2 (+58%) at n=11** — the 0.25 floor
   is the most likely too-strict gate. Recheck at n≈50 (existing watch item).
5. A+ dead by construction — either retire the label or re-earn it via a
   calibrated path.
