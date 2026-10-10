# NFL wallet backtest — 2026-10-09

Charter: docs/charters/nfl-wallet-backtest.md (fcfc512, pre-registered before data).
Script: research/sharp/totals_wallets.py SPORT=nfl. Desktop data: 3,330 NFL markets
(2025 season + playoffs, 2026 wk 1-5), 1.25M fills ≥ $50, 25,569 wallets, fetched in 230 s
(fast_tape.py, 0 failed, 1 capped). 330 games with totals; 307 with an in-window main line
(2025: 241, 2026: 66 — the 2026 holdout is small).
Raw: ~/Documents/Projects/polywhaler-data/nfl/reports/nfl_wallets_2026-10-09.txt

## Pre-registered result: 0/30 candidates; PRIMARY (CFB HT rule) does NOT replicate
`A HT FOLLOW` 34-25 +15.6 % pooled z 1.2 (< 1.5); 2025 +19.3 % (n 52), 2026 −12.5 % (n 7).
Fails the both-seasons-positive clause on n = 7. No NFL HT lane.
Notable cells: S6 square FADE +12.9 % (2025, n 91) / +31.2 % (2026, n 18), pooled +15.9 % z 1.7;
S3 team FOLLOW +22.9 % z 2.0 (2025) / −5.6 % (n 21); GOOD FOLLOW +34 % z 2.2 (2025, n 35).
Baseline Over/Under ≈ flat both seasons.

## Constructive pass (exploratory, owner rule)
Unions with the square fade (bet a side when the wallet types support it, none support the other):
| rule | W-L | ROI | z | $4 | 2025 | 2026 | months |
|---|---|---|---|---|---|---|---|
| **S3SQ: team specialist on side OR square on the other** | **53-30** | **+26.8 %** | **2.5** | **+$89** | +25 % n73 | +38 % n10 | **7/7 +** |
| SQ: square on the other side | 64-45 | +15.9 % | 1.7 | +$69 | +13 % | +31 % | 6/7 + |
| NET: any good on side OR square on other | 24-11 | +34.8 % | 2.2 | +$49 | +37 % | +20 % n5 | 6/6 + |
| HTSQ: hot/team on side OR square on other | 27-17 | +21.9 % | 1.5 | +$39 | +22 % | +20 % n5 | 5/6 + |
The same unions in CFB: S3SQ +28 % (2025) / −12 % (2026) — does NOT transfer; CFB keeps HT.
S3SQ → era v22 $4 pilot lane `nfl_wallet_follow` (charter nfl-wallet-follow-pilot.md).
Caveat: ~6 unions tried after the 0/30 read; expect the forward edge well below +27 %.

## C. overlay on our NFL totals shadow (context; 67/93 games matched)
All 40-27 +18.5 %. S4 totals specialist present on EITHER side 16-3; absent 24-24 (−1.4 %).
Too small to act on; noted for the next NFL read.
