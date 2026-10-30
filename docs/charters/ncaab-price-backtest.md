# Charter — NCAAB price-rule backtest on the 2025-26 season (`ncaab_price_backtest`)

Written 2026-10-30 after the wallet backtest (0/24) and before any price
result was computed. Owner: "Go for it". Rule is code:
`research/sharp/ncaab_prices.py` on the desktop DB
`polywhaler-data/ncaab/ncaab_2025.db` (same population as
`ncaab-wallet-backtest.md`: `cbb-` moneyline/total/spread markets ≥ $5k,
fills ≥ $50, maker + taker).

## question
Are there simple price rules on college basketball — which side, at what
price, when, in which kind of game — that a $4 bot betting in its window
would have profited from, consistently across a time holdout?

## entry (what the bot can do)
Per (market, side): the first BUY fill of that token in
[start − 180 min, start − 60 min), price 0.05–0.95. ROI = won / price − 1.
One row per market side; z clustered by game (both teams + start).

## cells (fixed list, 24)
A. Moneyline side by its price: 05-20, 20-40, 40-50, 50-60, 60-80, 80-95 (6).
B. Totals: Over, Under (2).
C. Spreads: favourite (the team named in "Spread: A (−x)", token0), dog (2).
D. Moves — side's bot-window price vs its first fill at/after start − 6 h
   (both must exist): shortened ≥ 3c ("steam") / drifted ≥ 3c, for
   moneyline and for totals (4).
E. Season phase: moneyline dogs 20-40 and favourites 60-80, each in
   Nov–Dec vs Jan+ (4).
F. Market size: game pregame notional (all its markets, fills before start)
   ≥ $50k "big" vs < $50k "small", for moneyline dogs 20-40, favourites
   60-80, Overs, Unders (8)... capped to the first 6 in this order:
   big dogs, small dogs, big favs, small favs, big Overs, small Overs (6).

## split and acceptance
DISCOVERY start < 2026-02-01, HOLDOUT ≥ 2026-02-01 (conference tournaments
+ March Madness). CANDIDATE = discovery n ≥ 50, |z| ≥ 2 AND holdout same
sign, |z| ≥ 1, n ≥ 30; ~1.1 chance passes. Negative candidate = a guard /
fade. Candidate → re-read one bet per game, then a $4 pilot proposal from
2026-12-01 on the owner's go. Nothing passing → no price edge recorded;
not re-cut.

## known_leakage_risks
- Entry is a real fill at the bot's time, not the prices-history series.
- $50 fill floor; bot buys $4–6 at the ask (slippage unmodelled, live lanes
  ≈ −70 bps).
- Market-size split uses the whole pregame tape (includes fills after the
  bot's entry); size is roughly known in advance from listing/hype, but this
  is a mild lookahead — a candidate there is re-checked with notional before
  start − 180 min.
