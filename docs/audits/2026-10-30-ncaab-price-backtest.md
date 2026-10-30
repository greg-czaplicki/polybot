# NCAAB price-rule backtest — 0/24 pre-registered; underdogs 30–50c post-hoc (2026-10-30)

Charter `docs/charters/ncaab-price-backtest.md`; script
`research/sharp/ncaab_prices.py`; output
`polywhaler-data/ncaab/ncaab_prices_2026-10-30.txt`. Entry = first BUY fill
of the side in the bot window (60–180 min out).

## pre-registered: 0/24, no discovery hit
Closest consistent cells: moneyline 40–50c +5.6 % / +10.5 % (z 1.0 / 1.7),
20–40c +5.3 % / +4.2 %; favourites 50–60c −5.6 % / −4.4 %, 60–80c
−2.5 % / −1.9 %. Totals, spreads, line moves, season phase and game size:
nothing.

## constructive pass (POST-HOC)
Moneyline underdog in [0.30, 0.50): 547-689, +9.2 %, z 2.6 over the season
(+$455 at $4); discovery +7.6 % z 1.6, holdout +11.1 % z 2.1; Nov–Dec +14 %,
Jan +3 %, Feb+ +11 %; big games +6.5 %, small +10.4 %. Mirror: favourites
50–70c −4.1 % z −1.9. [0.20, 0.50): +6.2 % z 1.8. Consistent with the
2026-09-11 close-calibration finding (favourites ~2 pts rich at executable
prices) and the CS2 pickem-dog lane. Band chosen after seeing the cells →
expect less forward.

## decision
Owner 2026-10-30 "Yes please": $4 pilot `ncaab_ml_dog` (era v28), charter
`docs/charters/ncaab-ml-dog-pilot.md`.
