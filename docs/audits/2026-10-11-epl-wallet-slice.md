# EPL wallet slice — 2026-10-11

Exploratory slice of the 2026-10-09 soccer wallet backtest (docs/audits/2026-10-09-nhl-soccer-wallet-backtest.md),
owner request "run a back test" on EPL. Same frozen script, `research/sharp/totals_wallets.py`, plus a new
`BET_SPORT` option (records stay league-pooled, bet population EPL only). Desktop tape `polywhaler-data/soccer/soccer_2025.db`,
338 EPL games with totals (264 discovery 2025-26, 54 holdout 2026-27 through 10/10). EPL tape only has totals + spreads (no 1X2).
Raw: `polywhaler-data/soccer/reports/epl_{pooled,only}_2026-10-11.txt`.

## Result: 0 candidates either way — no EPL-specific lane
The holdout is far too small (8-21 qualifying games per cell, need ≥ 30). Baseline Over −2.7 %, Under +0.8 % (flat).

- **Pooled records (= the live `soccer_hot_fade` rule):** A HT FADE on EPL 80 games +23.4 % z 2.0, $4 → +$75
  (disc +18.4 % n72, holdout +68.6 % n8). The EPL slice supports the existing lane — it already covers EPL.
  A S2 (hot-only) FADE 96 games +40.6 % z 4.1 (holdout n 11) — same direction as all-soccer S2 FADE (+10.8 %);
  magnitude is small-sample, not a reason to size up EPL (chosen after seeing data).
- **EPL-only records:** nothing holds. S1/S4 fade look strong in discovery (+18-28 %) but S4 flips in holdout (−24 %).
  EPL-specialist histories are too thin (~1 season); pooling leagues is the better record.

Re-read when EPL holdout cells reach n ≥ 30 (≈ 15 more matchweeks, ~January 2027).
