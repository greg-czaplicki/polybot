# 2026-09-11 — Counterparty cells per sport: MLB, ATP, WTA, CS2

Follow-on to `2026-09-11-exchange-frame-reads.md`. Question: in which cells of
the exchange do small takers ($5–$100 fills) cross the spread for free or
better, i.e. where are the makers' quotes stale? Method fixed before the
read:

- one observation per (market, side): the mean ROI of the small taker-BUY
  fills on that side, at their actual fill price (executable by construction);
- z clustered by `event_key` (a game's moneyline, total and run line settle
  together);
- fills from T-6h to start, price 20–95c; cells = price band × minutes to
  start × market type, plus minutes since the last trade; spread/depth from the
  polybook recorder where a snapshot exists (September only);
- older/recent halves split at the median start date (2026-07-10 for MLB);
- "our selection on top": each MLB shadow/live pick priced at the first small
  taker-BUY fill of its token within 60 min after the pick, compared with the
  mean of the cell it lands in.

Script: `research/sharp/cell_read.py <sport>` (14 s per sport on the VPS).
Raw outputs: `research/sharp/reads/2026-09-11-cell_<sport>.txt`.
Sports with < 50k small fills (NBA, NHL, NFL, soccer leagues) were not read.

## Summary table (one obs per market-side, event-clustered z)

| sport | obs | whole market | cell that survives both halves | z | n |
|---|---|---|---|---|---|
| MLB | 7,402 | −0.5% | run-line (spread) dogs 20–40c **+18.0%** | +2.0 | 255 |
| MLB | | | totals 60–80c **−12.2%** | −2.3 | 229 |
| MLB | | | totals 60–180 min −2.9% | −3.2 | 2,606 |
| ATP | 3,990 | +0.9% | moneyline dogs 20–40c **+11.7%** | +2.5 | 1,080 |
| ATP | | | moneyline favourites 60–80c **−6.5%** | −3.2 | 1,185 |
| WTA | 2,321 | −1.6% | nothing (dogs 20–40c +6.7% older, −9.3% recent) | | |
| CS2 | 1,711 | −1.4% | 40–50c **+5.5%** / 50–60c **−6.4%** | +1.4 / −2.5 | 562 / 590 |
| CS2 | | | favourites 80–95c −9.0% | −2.0 | 122 |

Minutes-since-last-trade carries no structure in any sport. The polybook
spread/depth cells have n ≤ 109 and are not readable yet.

## MLB

The MLB book is efficient at cell level. Moneylines cost small takers −1.1%
(z −2.4) in every time band and both halves; totals are flat except that
buying the 60–80c side of a total loses −12.2% (z −2.3, −17.1% older / −8.6%
recent) and the 60–180 min window on totals is −2.9% (z −3.2, recent −5.0%).
No price × time cell is positive with |z| ≥ 1.2. The one exception is
**run-line dogs at 20–40c: +18.0% (z +2.0, n=255; +20.5% older, +14.9%
recent)**. Run lines are currently rejected by the `spread_market_excluded`
gate, so no live or shadow evidence exists on our side for that cell.

**Our selection on top of the cell.** Live matched MLB picks, priced at the
next executable small fill after the pick: +19.2% (z +2.1, n=122) against a
cell baseline of −1.9% — the selection adds ≈ +21 pts. All shadows: +2.3%
(z +0.7, n=2,605) vs −1.2% baseline, +3.5 pts. Quality-clean shadows: +4.0%
(n=146), +4.6 pts. The live book's edge is selection, not the cell it trades
in; that is consistent with the 60–180 min window being the *worst* cell for
random small takers on totals and the best for our picks.

## ATP

The clearest reverse favourite–longshot structure in the data. Small takers
buying moneyline dogs at 20–40c earn +11.7% (z +2.5, n=1,080; +13.7% older,
+9.2% recent), in every time band (0–15 min +12.8% z 2.1, 3–6 h +13.7% z 2.5).
Small takers buying favourites at 60–80c lose −6.5% (z −3.2, n=1,185; −8.6% /
−3.8%). Props are −3.8%. The favourite side is the more robust half (it does
not depend on tail wins).

## WTA

Nothing. The whole market is −1.6%, moneylines −2.3% (z −2.0), and the dog
cell flips sign between halves. Consistent with the WTA-inversion charter:
whatever structure existed in the first half is gone.

## CS2

The coin-flip zone is asymmetric: buying the slight dog at 40–50c earns +5.5%
(+6.8% / +4.1%) and buying the slight favourite at 50–60c loses −6.4% (z −2.5,
−7.9% / −4.8%). Heavy favourites 80–95c lose −9.0% (z −2.0). This matches the
esports "underdog bias at mid" read from 0873d62 and is now measured on
executable fills with clustered z.

## What this changes

- The only cells positive for a random small taker with z ≥ 2 in the right
  direction and both halves agreeing are **ATP moneyline dogs 20–40c** and
  **MLB run-line dogs 20–40c**. Both are tail-heavy (a dog cell's ROI is
  carried by wins at 3–5×), so the next test must be forward, not another
  cut of the same data.
- The robust *negative* cells (ATP favourites 60–80c, CS2 favourites ≥ 50c,
  MLB total sides at 60–80c) are the cheaper finding: a favourite-side pick in
  those cells starts 5–12 pts behind before any signal. They belong in the
  gate vector as a price-band guard per sport, era-gated.
- The MLB live book's edge is selection on top of an efficient cell, so the
  counterparty map does not explain it and cannot replace it.

## Pre-registered forward test (from 2026-09-12)

Record-only lanes, one row per market-side that meets the cell, entry = first
small taker-BUY fill after the row is written, held to settlement:

1. `atp_dog_cell`: ATP moneyline, price 0.20–0.40 at write time, any time band.
   Read at n ≥ 150 market-sides; pass if ROI > 0 with event-clustered z ≥ 2.
2. `mlb_runline_dog_cell`: MLB spread market, dog side 0.20–0.40. Season ends
   2026-09-28 plus postseason; read whatever accrues, expect n < 100 — this is
   a 2027 read unless postseason volume surprises.
3. Negative guards (no lane needed): re-cut ATP 60–80c, CS2 50–95c, MLB total
   60–80c on 2026-10-01 with the same script; if still ≤ −4% in the recent
   half, add as price-band gates.

Nothing above is a live rule. NBA and NHL get the same read once ~300
settled markets exist (late November).
