# Charter — NBA totals sharp-consensus FADE, capped live execution pilot (era v19)

Written 2026-10-07, before the first live row. Owner decision the same day,
after the pre-registered wallet backtest found the cell: "Money pilot". The
rule is code: signal `research/sharp/nba_fade_live.py` (VPS, every 10 min),
lane `src/lib/nba-totals-fade-lane.ts`. Changing the signal definition, side
rule, band, caps, kill rule or metric after the forward start means a NEW
charter version; prior rows become exploratory.

## question
1. **Evidence**: does fading NBA-sharp consensus on game totals keep beating
   the price in 2026-27? Read from ALL signals (`nba_fade_signals`, not only
   the ones the bot took) at the fade side's price in the bot window, one per
   game — the same rule as the backtest, forward.
2. **Execution** (the $4 picks): fill rate, slippage, rejections.

## origin
`docs/audits/2026-10-07-nba-wallet-backtest.md`, cell `S5_consensus/total`
of the charter `docs/charters/nba-wallet-backtest.md` (pre-registered
a2e7b37): follow ROI discovery −10.9 % z −2.1 / holdout −13.2 % z −2.4 →
FADE candidate. One bet per game at the executable fade price: discovery
181-145 +11.6 % z 2.1, holdout 151-133 +7.7 % z 1.3, season 332-278 +9.8 %
z 2.4. Entry in the bot window (60-180 min out) instead of at the trigger:
+7.1 % z 1.5 on 447 games (the same games entered at the trigger +7.5 %);
expect ~+5-8 % forward, ~1.5 bets/day.

## signal (frozen; = the backtest cell)
- Wallet records: pregame positions (fills ≥ $50, maker + taker) in settled
  NBA markets from 2025-10-21 onward (`/root/polysharp/data/nba/nba_2025.db`,
  kept current by the daily NBA backfill); stake ≥ $50; a position counts
  once its start + 4 h has passed.
- NBA sharp = ≥ 30 settled positions, record ROI ≥ +10 % at the trigger.
- Trigger = a wallet's first pregame BUY ≥ $100 on a token, 0-24 h out.
- Consensus = the 2nd distinct sharp on a side while none is on the other
  side. Consensus on both sides → voided.

## population_and_exclusions
Bot pre-filter survivors (not already picked, market group free, event time
known, inside the bot window), `sport_tag = nba`, game-total market, a
non-voided signal whose trigger is before now, fade side priced in
[0.40, 0.60), event NOT NBA preseason (`isNbaPreseasonTime`). Alt lines:
one per game via the market-group key.

## sizing_caps_and_kill (the contract)
| parameter | value |
|---|---|
| stake | $4 fixed (`BOT_LANE_STAKES=…,nba_totals_fade=4`) |
| picks per UTC day | ≤ 5 |
| notional per day | ≤ $20 |
| price band | [0.40, 0.60) on the fade side |
| kill: drawdown | realized lane PnL ≤ −$40 → stop |
| kill: z | ≥ 30 settled AND clustered z of trailing 100 < −1 → stop |
| forward start | 2026-10-20T00:00Z (opening night) |
| manual off | `enabled=false` (era bump) or bot stake unset |

## validation_and_acceptance
Evidence read at 150 signal-games (≈ mid-December) and at season end: pass =
ROI > 0 and game-clustered z ≥ 2. Scaling needs that pass plus fill rate ≥
80 % and slippage < 150 bps over ≥ 30 fills (new charter + era bump). Kill is
final for this version. Readout `docs/audits/<date>-nba-totals-fade-pilot.md`
at 30 settled picks or 2026-12-15, whichever first.

## leakage pre-audit (2026-10-07)
- Records use settled positions only (start + 4 h before the trigger).
- The lane acts only on signals whose trigger_ts < now; `first_seen_at`
  records when the app first had the signal.
- The live job reads the full tape with the same $50 floor as the backtest.
- Lane rows carry `manual_picks.lane = 'nba_totals_fade'`; holder-book reads
  filter `lane IS NULL`.
