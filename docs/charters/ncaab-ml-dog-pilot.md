# Charter — NCAAB moneyline underdog, $4 live pilot (era v28, `ncaab_ml_dog`)

Written 2026-10-30 before the first live row. Owner: "Yes please". Rule is
code: `src/lib/ncaab-ml-dog-lane.ts`. Evidence (POST-HOC):
`docs/audits/2026-10-30-ncaab-price-backtest.md`.

## rule
College basketball (`sport_tag = ncaab`) game-winner market in the bot window
(60–180 min out); bet the side priced [0.30, 0.50); none or both in band →
no bet. No holder or wallet signal. The lane only sees markets in the app's
cache (≥ $10k volume).

## sizing_caps_and_kill
$4 (`BOT_LANE_STAKES` += `ncaab_ml_dog=4`; stake ladder applies), ≤ 10 open,
kill realized −$40 or trailing-100 clustered z < −1 after 30 settled.
Forward start 2026-11-02T00:00Z.

## validation
Read at 150 settled or 2027-02-01: pass = ROI > 0 and game-clustered z ≥ 2.
Backtest expectation +9 %; a realistic forward +3–5 %. Scaling beyond the
ladder needs a new charter.

## leakage pre-audit
Entry is the bot's own fill at its time; band uses only the price at that
moment. Lane rows carry `manual_picks.lane = 'ncaab_ml_dog'`.
