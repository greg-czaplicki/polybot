# NCAAF wallet backtest — 2026-10-09

Charter: docs/charters/ncaaf-wallet-backtest.md (4b97acf, pre-registered before data).
Script: research/sharp/ncaaf_wallets.py. Data fetched on the DESKTOP: backfill.py discovery
(SPORTS=cfb MIN_VOL=5000) + new research/sharp/fast_tape.py (24 threads; 4,307 markets, full
maker+taker tape ≥$50, 0 failed, 0 capped, 4 min, 569 MB). 4,450 CFB markets (1,330 totals),
613k fills, 13,136 wallets, 571 games with totals (346 with an in-window main-line fill).
Raw output: ~/Documents/Projects/polywhaler-data/ncaaf/reports/ncaaf_wallets_2026-10-09.txt

## Result: 0 / 26 candidates (standalone follow/fade)
Discovery = 2025 season, holdout = 2026 to date. Baseline: 2025 Unders +11% (z1.6), 2026 flat.
The sharp-type cells FLIP sign between seasons: S4 totals specialists follow −31.6% (z−2.5) in
2025 → +15.3% in 2026; S5 consensus −57% → +21%; S1 −7% → +18%. Same pattern as NBA: season-level
swings, not stable wallet skill. Only cells positive in both seasons: S2 hot-streak follow
(+19.4% z1.5 / +11.6% z0.9) and S3 team specialist (+20% / +21%, n 25/12) — neither passes.

## C. overlay on our own shadow rows (2026 only, context, no acceptance)
159/167 shadow games matched. All: 87-72 +9.7%.
| wallet type vs our sighted side | agrees | opposes | neither |
|---|---|---|---|
| S1 sharp | 37-20 +30.5% z2.4 | 8-15 −31.4% z−1.6 | 42-37 +6.7% |
| S4 totals specialist | 36-24 +21.7% | 8-12 −21.5% | 43-36 +8.5% |
| S5 consensus | 25-15 +25.7% | 5-10 −35.5% | 57-47 +10.1% |
| S6 square | 24-13 +31.7% z2.0 | 24-26 −3.9% | 39-33 +7.9% |
Caveats: one season (2026, when sharp-follow cells were positive across the board); "square agrees"
is as good as "sharp agrees", so part of the effect is "a ≥$100 record-holding wallet on our side",
not sharpness; S1 wallets overlap the holders that build our signal. Descriptive only — any filter
needs a forward paper read under its own charter.
