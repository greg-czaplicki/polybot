# CS2 wallet backtest — 2026-10-09

Charter: `docs/charters/cs2-wallet-backtest.md` (committed 53a20b1 before data).
Script: `research/sharp/cs2_wallets.py`. Output: `research/sharp/reads/2026-10-09-cs2_wallets.txt`.
Data: VPS `/root/polysharp/data/cs2/cs2_2025.db` — 7,239 settled CS2 markets (6,412 match winners,
volume ≥ $5k, 2025-10-01 … 2026-10-07), full maker + taker tape ≥ $50 (2.41M fill rows, 24,670 wallets).

## Question
Owner: can a wallet filter (who is on each side) trim the CS2 pickem-dog lane to a better record?

## Result: NO EDGE — 0 of 15 cells pass
| cell | discovery (< 6/1) | holdout (≥ 6/1) |
|---|---|---|
| lane baseline (dog 40–50c, 60–180m) | +10.4% z2.7 n878 | **+1.1% z0.3 n961** |
| winning-record wallet on dog | +11.8% z1.0 n90 | −9.6% z−0.9 n110 |
| winning-record wallet on fav | +28.5% z2.6 n105 | −1.1% z−0.1 n132 |
| hot wallet on dog | +17.1% z1.5 n94 | +4.1% z0.4 n115 |
| team specialist on dog | +18.1% z1.2 n55 | +9.9% z1.1 n151 |
| team specialist on fav | +8.8% z0.5 n50 | −18.2% z−1.9 n128 |
| 2+ winning wallets on dog | +22.4% n29 | −25.6% n48 |
| lane minus "winning wallet on fav" | +5.0% z1.0 n519 | −0.6% z−0.1 n469 |
| follow cells S0–S5 | +1.7…+3.8% | −3.0…+4.7%, all |z| < 2 |

Three discovery hits (lane baseline, S1 on fav, S2 on fav) all died in holdout — about what
chance predicts for 15 cells (~0.7) plus a strong early-season tailwind shared by every lane row.

## Finding that matters more
The lane's own baseline decayed: +10.4% (Nov–May) → +1.1% (Jun–Oct 7) on 961 backtest rows.
This matches the 10/2 deep-dive holdout (+3.9% z0.7) and the forward cell read
(cs2_pickem_dog_cell FAIL, +3.8% z0.4 n162). The live pilot's +$23.78 (25-24-6) sits inside noise.

## Disposition
No filter, no paper lane, no re-cut (charter). Live lane unchanged: $4 execution pilot with its
existing kill rule. Wallet records + tape are on the VPS if a 2026-27 replication is wanted.
