# 2026-09-11 — Exchange-frame reads on the polysharp tape

Context: the user's 2026-09-09 pivot is "stop outcome/CLV betting research; the
edge, if any, is in the two-sided exchange data (who buys, who sells, who holds)".
Today's session re-ran the question from that frame. All reads use
`/root/polysharp/data/sharp.db` on the VPS (14,456 settled markets, 13.9M fills,
6.3M 1-minute prices, weekly as-of wallet tiers). Scripts: `research/sharp/`
(`polysharp.py`, `fade_read.py`); the ad-hoc cell reads are reproducible from
the queries quoted below.

Every number here is held to settlement. Nothing in this note is a strategy;
it is a map of where the counterparty is dumb and where it is informed.

## 0. Yardstick check: is the Polymarket close efficient?

- On MLB moneylines the Polymarket close is within 0.5 pt of Pinnacle's
  de-vigged close across the 0.3–0.6 buckets (D1 `shadow_candidates`,
  n=110–281 per bucket). For MLB, CLV vs the Polymarket close is CLV vs
  Pinnacle. The user's point — "Polymarket is as sharp as Pinnacle" — holds.
- **Artifact warning.** The CLOB `prices-history` series is NOT an
  executable price. Using its last pre-start value, "buy the dog at 10–40c"
  showed +13.2% (z +5.9, n=6,486), robust at T-60 and in both time halves.
  Priced at the last taker-BUY fill of the same token (what a buyer actually
  paid), it collapses to +2.3% (z +0.8). September top-of-book confirms: spreads
  average 5–17c at mid prices, dogs at the ASK −8.1%. Never read a close edge
  off `prices-history` again.
- Residual, real: favorites 50–90c are 1.5–3 pt rich at the ask (each bucket
  z −2.1…−2.6; favs 60–90c ROI −3.4%, z −3.8, n=5,394; moneylines −3.2%,
  totals −6.5%, spreads/props flat). Dogs are fair. CLV against the Polymarket
  close therefore flatters favorite-leaning strategies by ~2 pt.

## 1. Maker-side P&L vs taker flow (1,389,431 pre-start fills ≥ $5, T-6h…T-0)

Maker = counterparty of the taker, notional-weighted, cents per dollar.

| cut | maker c/$ | fills |
|---|---|---|
| taker BUY, 1–3 h before start | +3.6 | 390k |
| taker BUY, 15–60 min | −1.7 | 357k |
| taker BUY, last 15 min | −1.3 | 257k |
| taker BUY, 3–6 h | −0.8 | 292k |
| price 40–60c / 60–80c | +1.1 / +1.1 | 710k / 275k |
| price 20–40c (dog buyers) | −7.4 | 184k |
| price 80–95c | −2.9 | 79k |
| moneyline / total | +1.4 / +1.5 | 543k / 391k |
| spread / prop | −3.9 / −3.2 | 251k / 105k |
| MLB | +2.4 | 339k |
| ATP / CS2 / WTA / LoL | −3.4 / −1.9 / −0.4 / −1.3 | 109k / 104k / 67k / 53k |
| NBA / NHL / WNBA (thin) | +13.1 / +9.8 / +7.0 | 22k / 9k / 24k |
| EPL / La Liga / UCL / UFC / NFL (thin) | −9.5 / −17.5 / −8.3 / −6.7 / −3.6 | 13k / 11k / 13k / 8k / 8k |

Favorite asks 60–80c by time: 1–3 h +4.5, 15–60 min +3.1, last 15 min −4.0.
The maker edge on favorites exists 15 min–3 h out and is eaten by late informed
flow. Heavy favorites 80–95c are negative for the maker in every window but the
last 15 min.

Taker SELL flow is small (~100k fills): makers bidding 20–40c earn +20.7c/$,
bidding 60–80c lose −10.4c/$.

Caveats: held to settlement (the paper maker flattens at T-15), notional-weighted
(a few big fills dominate thin cells; trust cells ≥ 50k fills only), and it says
nothing about queue position, which was the paper maker's real blocker.

## 2. Flow imbalance predicts nothing

Net taker-buy notional on token0 over T-6h…T-60m, quintiles across 7,930
markets (≥ $2k traded): drift T-60→T-1 is −0.16c…+0.12c and outcome-minus-price
is −2.1c…+1.6c with no monotone pattern (|z| ≤ 1.7, wrong sign where largest).
Which way the crowd leans carries no information; the structure is in which
flow you stand against and when.

## 3. Small-taker cells ($5–$100 fills, 994,674 taker BUYs)

Equal-weighted per fill. Per-fill z-scores are inflated by market clustering
and are deliberately not quoted; effective n is markets (low thousands per cell).

| cell | taker ROI |
|---|---|
| 40–60c / 60–80c / 80–95c | −1.0% / −3.0% / −3.1% |
| 5–20c / 20–40c | +6.5% / +0.3% |
| totals / moneylines / spreads / props | −2.8% / −0.1% / −0.8% / −0.2% |
| 3–6 h / 1–3 h / 15–60 min / last 15 min | 0.0% / −1.7% / −1.1% / −1.2% |
| 40–60c × 3–6 h / × 1–3 h / × 15–60 min | +1.2% / −0.9% / −3.0% |
| MLB / ATP / WTA / CS2 | +0.1% / +0.9% / −2.6% / −0.9% |
| NBA / UFC / MLS / NHL | −15.7% / −11.3% / −15.2% / −5.6% |

Small takers as a class break even on MLB moneylines, lose ~3 pt on favorites
and totals, and pay more the closer to start they cross.

## 4. Does the bot's timing window sit in the wrong cell? — NO

Hypothesis from §3: crossing 3–6 h out is free, so move the bot earlier.
Test on our own data (D1):

- Live MLB picks, matched and settled: 60–120 min n=53 ROI +25.5%;
  120–180 min n=85 ROI +23.8% (83–55 overall, +24.6%, market-level z ≈ 2.9).
- Quality-clean shadows (every `gates_json` gate passes), blocked only by
  timing: 3–6 h moneylines n=13 +21%, totals n=24 −1%; 6 h+ moneylines n=23 +2%,
  totals n=30 +18%. Quality-clean any-reason: 60–180 min +28–31% (n=36),
  3–6 h +15% (n=44), 6 h+ +5% (n=76), 0–60 min −1…−37% (n=36).

The bot's picks are not random small-taker flow; their best cell is the window
they already use. Keep 60–180 min. (Cells are tiny; re-read at n≈100 each.)

## 5. Wallet identity is dead at executable prices (`fade_read.py`, 14 s)

Weekly as-of tiers (bottom/top 10% by `roi_t`, n ≥ 20), fills T-6h…T-1h, entry
= last executable taker-BUY of the chosen side in the last 30 min, one obs per
market.

Persistence (forward realized ROI on the week after the snapshot, per fill):
square −5.9% (36k fills, 1,201 wallets), **mid +1.1%** (335k), sharp −5.0%
(63k, 1,615 wallets), unlabelled −2.4%. Both tails revert; ranking wallets by
past ROI selects noise in both directions.

| rule (min net $200) | ROI | z | n |
|---|---|---|---|
| FADE net square money | −0.0% | −0.0 | 2,029 |
| FADE net square, sharps not with them | −6.4% | −1.9 | 1,124 |
| FOLLOW net square money | −3.7% | −1.6 | 2,133 |
| FOLLOW net sharp money | −2.6% | −1.5 | 4,024 |
| FADE the crowd (≥ 60 % one-sided, ≥ $2k) | −1.3% | −0.5 | 3,467 |

No sport/type/price cut of any rule clears z 2 in the right direction with
n ≥ 100 (WNBA follow-sharp +26.8% z 2.8 n=94 is one cell out of ~60; treat as
the multiple-comparisons tail). Squares do lose (follow −3.7%), but the spread
eats the fade.

## What this changes

- The counterparty map is real and stable across halves; the wallet-identity
  signal is not. Exchange-native edge, if any, lives in cells (price × minutes
  to start × market type × sport), not in who is on the other side.
- `paper_mm` should be constrained to the paid cells (moneyline + totals,
  40–80c, MLB/NBA/WNBA/NHL, quote from ~T-3h, pull at T-15) before its fill
  problem is worth solving.
- CLV stays a diagnostic, calibrated by §0; realized P&L with its variance is
  the ground truth. Neither is the edge.

## Not done / open

- Per-wallet maker roles are not observable from `data-api /trades` (taker
  side only); would need on-chain `OrderFilled` maker/taker pairs.
- Holder-concentration at T-60 vs outcome (D1 `top_holders_json` on shadows)
  and cancel/pull behaviour in the last 15 min (`polybook.events`, Sept only,
  ~400 markets) remain unread.
- All §1/§3 cells should be re-cut equal-weighted per market with
  event-clustered z before any of them becomes a rule.
