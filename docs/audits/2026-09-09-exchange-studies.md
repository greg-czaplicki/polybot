# Exchange-data studies — 2026-09-09

Pivot: stop asking "who wins" and ask what the exchange itself does. No outcome
model, no Pinnacle, no holder signal. Public Polymarket data only.

## Dataset (`research/exchange/build_dataset.py`, local SQLite, not committed)

- 3,380 settled sports markets we had tracked (2026-07-30 → 09-09); MLB 1,728,
  ATP 340, EPL 219, WTA 209, La Liga 195, NCAAF 110, NFL 108, others.
- Full trade tape per market from the public Data API: 2.24M fills, $496M
  notional, every fill with wallet, side, price, size, timestamp. Retrievable
  retrospectively for closed markets.
- CLOB `prices-history` at 1-minute fidelity, 48h before start to 6h after:
  8.5M points. The docs do not say whether `p` is mid or last; the measured
  effective half-spread (~0.5c ≈ half a 1c tick) implies mid.
- Start time = CLOB `game_start_time` (481 of our cached `event_time` values
  differed by >60s; the cache falls back to resolution date, see wallet audit).

Fees (docs.polymarket.com, July 2026): makers pay nothing; sports takers pay
`0.05 × p × (1−p)` per share (max 1.25c at p=.50); 15% of sports taker fees
are rebated daily to makers.

## Results (`research/exchange/studies.py`, `studies2.py`; SEs clustered by market)

**4. Where the liquidity is.** In-play carries 53% of MLB dollars, 76–79% of
tennis, 67% NFL. Pregame is 20–45%. Per-market totals: MLB $146k, ATP $298k,
WTA $220k, NFL $97k. Pregame taker flow across our tracked markets alone runs
≈ $4–6M/day (MLB ≈ $1.8M, ATP ≈ $1.1M). Median pregame fill $9, mean $264;
top 100 wallets are 70% of pregame dollars.

**1. Order-flow drift (taker side): dead.** Signed 30-min taker flow vs next
30/60-min price change: correlation +0.01 to +0.03 in every sport (NFL +0.03).
Following flow ≥ $500 earns +0.09c gross over 30 min (NFL +0.32c, n=262).
Taker cost is ~0.5c half-spread + up to 1.25c fee each way. Nothing here
survives costs.

**2. Following large fills (taker side): dead.** Measured from the sweeper's
own last fill price, +5/+15/+60 min after a ≥$1,000 fill: −0.14c / −0.13c /
−0.07c (ALL), ≈ 0 to +0.1c MLB, negative ATP, +0.4c NFL (n=268). Below cost
everywhere. (Minute-price "continuation" of +0.5c seen in the naive cut is
the fill's own impact arriving in the next minute, not drift.)

**3. Maker economics (the finding).** Per pregame taker fill, from the
maker's side, in cents per share:

| Cut | Effective half-spread | Realized +5m | +15m | +60m | Held to start |
|---|---|---|---|---|---|
| ALL pregame (538k fills) | +0.56 | +0.38 | +0.39 (z 33) | | |
| MLB | +0.53 | +0.42 | +0.40 (z 66) | +0.26 | +0.15..0.24 (z 3–4) |
| ATP | +0.69 | +0.37 | +0.37 (z 7.5) | +0.16 | +0.28 |
| WTA | +0.69 | +0.39 | +0.46 | +0.37 | +0.25 |
| NFL | +0.56 | +0.29 | +0.18 (z 4.5) | | −0.72 (z −2.1) |
| NCAAF | +0.55 | +0.37 | +0.32 | | +0.40 |
| EPL | +0.52 | +0.40 | +0.35 (z 25) | | +0.06 |
| La Liga | +0.74 | +0.59 | +0.56 | | +0.34 |
| **In-play, ALL (1.33M fills)** | +1.07 | | **−0.19 (z −3.8)** | | |
| In-play NCAAF | +1.22 | | −0.90 | | |

Positive in every sport, every price band (5–95c), every hours-to-start
bucket, dollar-weighted (+0.40c) and out of sample (starts ≥ 8/20: MLB +0.36c,
ATP +0.37c, WTA +0.47c, EPL +0.35c). Adverse selection is only ~0.15c of the
~0.55c half-spread pregame: pregame takers are, on average, uninformed and
pay for immediacy. In-play the sign flips: takers are informed (score events)
and run makers over, worst in NCAAF.

Mirror image: pregame takers as a group lose ~0.4c/share of mark-to-market
within 15 minutes, before the 1.25c fee. Every "signal" strategy this project
has run is a taker strategy.

## What this does and does not say

- It is a realized-spread measurement, the standard market-microstructure
  test for whether liquidity provision pays. It is not a backtest of a
  quoting strategy: fill probability, queue position, inventory at start and
  latency are not in it. A maker only earns when hit, and must be flat by
  start (held-to-start is still positive but smaller and NFL is negative).
- Capital is the scale limit, not edge: ~0.4c per $1 of fills plus rebate.
  $30k of daily fills ≈ $120/day. The bankroll is $118.
- The data is our tracked markets only; the exchange's full sports book is
  larger.

## Next (not started)

1. Record live L2 books (top 5 levels, every few seconds) for active pregame
   sports markets on the VPS — the polyarb websocket feed already subscribes
   to books. Without book snapshots, queue position cannot be simulated.
2. Honest paper market-maker on that feed: join best bid/ask both sides,
   small size, flatten at T−15m; measure fill rate, realized spread, inventory.
3. Only then a live quoter at minimum size. Era bump; new charter.

## Addendum (same day): side-selection features tested on the tape

Wallet informedness (`study_wallets.py`): rank wallets by pregame fill CLV
(fill → scheduled-start price) in train (starts < 8/24), measure test (≥ 8/24).
Monotonic and persistent but small: bottom decile −0.56c, top decile +0.30c
(z 2.5, 149 wallets, $23M test flow); top decile fills ≥ $200 +0.50c; NFL
top-decile +2.0c (z 4.3, n=362, one week). Top-20 wallets: +0.29c, spread
−8.5c..+3.3c. Their 15-minute mark is negative (−0.27c): they pay spread and
are right only by the close. Takers as a group: −0.22c/−0.35c vs the close.
Following costs ≈ 1.75c/share (0.5c spread + 1.25c fee at p=.5) → no
wallet-following taker strategy clears costs; NFL is the one to watch.

Price-path features (`study_drift.py`, 3,324 markets): momentum T−6h→T−1h
does not continue (corr −0.04; sign flips by sport). Favorite-longshot:
token0 priced <20c at T−6h drifts +3.5c by start (z 4.3, n=178), 20–35c
+0.9c (z 3.5), >80c −1.1c. Likely partly a stale/wide-mid artifact on thin
longshot books — verify with the live book recorder (is the ask actually
there at T−6h?) before treating it as a signal. Median |open→close| move is
2.5–3.5c in soccer/NFL, less in MLB.

Conclusion: every side signal found is < the taker fee. The same signals cost
nothing as a MAKER (post on the favored side, earn spread + drift).

## Addendum 2: sharp-wallet follow, held to resolution (`study_sharp.py`)

Wallets ranked in train (starts < 8/24, ≥20 fills) by CLV t-stat or by
outcome-P&L t-stat; test (starts ≥ 8/24, 1,744 markets): copy each top-decile
wallet's pregame fill ≥ $200 at its price + 0.5c, hold to resolution.

| Ranking | Top-decile follow ROI | one bet per market | net sharp-minus-square flow ≥ $500 |
|---|---|---|---|
| CLV | −2.0% (z −0.5, 11,394 fills, 1,442 mkts) | −1.0% (n=1,442) | −0.1% (n=1,302) |
| Outcome P&L | +7.5% (z 1.6, 6,492 fills, 1,085 mkts) | 0.0% (n=1,085) | −2.7% (n=1,047) |

Per sport, everything is inside noise except NFL: +30% / +47% (z 2.1 / 3.6)
on ~36 markets, which in this window are PRESEASON games. All takers in the
test period: own ROI +0.4%, CLV −0.34c.

Reading: wallet skill is real (top decile CLV +0.3–0.5c, persistent OOS) but
half a cent of CLV is ≈ 1% of ROI, invisible at 1,000 markets and not
bettable. Sharp-minus-square aggregate flow is null. NFL is the only cell
worth a registered test: NFL regular-season markets accrue ~250 by week 4;
the tape crawl can score it weekly with no shadow book involved.

## Addendum 3: first paper market-maker cut (VPS recorder, evening of 9/9)

188 markets, mostly partial windows. JOIN / IMPROVE / THIN policies with
passive exits: −3.9 / −3.9 / −4.8c per $ filled, 31–35 fills. Liquid books
carry $21k (MLB), $50k (NFL), $11k (ATP) at the touch on 1c spreads → a new
order at the back never fills; thin props/spreads fill but adversely
(Chelsea −1.5: −11c/$). ATP +0.2c/$ on 6 fills. The tape's maker edge belongs
to the queue front (incumbent bots). Plain market-making at this capital is
not viable; the daily report continues for a full-window confirmation.
