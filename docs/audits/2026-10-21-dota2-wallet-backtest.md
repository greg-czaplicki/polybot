# Dota 2 wallet backtest — 2026-10-21

Charter `docs/charters/dota2-wallet-backtest.md` (pre-registered 44bf9b3, CS2
design verbatim). Data: desktop `polywhaler-data/dota2/dota2_2025.db`, 2,305
markets discovered 2025-10-01 … 2026-10-20, 2,083 match winners with full
tape, 998k fills ≥ $50, 10,994 wallets. Split = median start 2026-05-06.

## Pre-registered result: 0 / 15 candidates
Lane analogue (40-50c dog in 60-180m window) +1.1% z0.2 n501 — no Dota
pick'em-dog lane. Closest: B S1_follow disc +6.7% z0.9 / hold +16.8% z2.6 /
all +11.9% z2.3 n498 — fails the discovery leg. B S2_hot flips sign
(disc −7.9% z−1.7, hold +8.6% z2.1).

## Constructive combo pass (POST-HOC, `research/sharp/dota2_combo.py`)
One bet per match, $4.
| rule | entry | disc | hold | all |
|---|---|---|---|---|
| sharp ∪ team-specialist follow | next fill after trigger | +3.8% n299 | **+16.8% z2.9 n349** | +10.8% z2.4 n648 (+$279) |
| same | bot window 60-180m | −4.9% n180 | +10.7% z1.7 n242 | +4.0% z0.8 n422 (+$68) |
| sharp follow | bot window | −4.6% n145 | +13.5% z1.9 n178 | +5.4% z0.9 n323 |

Months (immediate, sharp ∪ team): Nov +15, Dec +18, Jan −8, Feb −7, Mar −58
(n8), Apr +3, then May +14, Jun +16, Jul +49, Aug +30, Sep +4, Oct +15 —
positive every month since May (records warm up, Dota volume grew).
Most of the edge is in entering soon after the sharp's buy; the bot's
60-180m window loses ~2/3 of it. Window bets on favourites ≥ 0.70 hold
(+8.7% z2.2, 99-15) but carry little $ per bet.

Not a promotion: failed the pre-registered rule; any lane is a $4 pilot on the
owner's go and needs a new era.
