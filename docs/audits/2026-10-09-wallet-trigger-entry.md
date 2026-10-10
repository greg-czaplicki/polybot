# Wallet signals: entry timing + NBA combination pass — 2026-10-09 (exploratory)

> **RETRACTED the same evening — lookahead.** The "conflict-free side of ALL pregame triggers"
> signal below drops games where the wallet type later bought the other side — information
> not available at entry. Point-in-time version (`research/sharp/first_trigger_read.py`: follow
> the FIRST trigger of the type, entry ≥ 60 s / 600 s later, one bet per game):
> NBA square-follow +1.5–3.0 % (z ≤ 0.9, n ≈ 860), CFB +8.3 % (z 1.2; 2025 +3.5 %, 2026 +11.4 %),
> NFL −2.5 %; team-specialist first trigger NBA +2.7 %, CFB +12 % (n 52), NFL ≈ 0.
> **No early-entry lane.** The live CFB/NFL lanes use A-cells (state from fills strictly before
> T) and are not affected.

Script: research/sharp/trigger_entry_read.py (records/qualifiers from totals_wallets.py).
One bet per game. Signal = the conflict-free side of all pregame wallet triggers (first BUY
≥ $100 per wallet/side, 0–24 h out) of the given type. "trigger" entry = first fill on that side
≥ 60 s after the signal's first trigger; "window" entry = first fill in [start−180m, start−60m)
priced 0.35–0.65 after the trigger (where the bot bets today).

## Follow SQUARE wallets' first buy (S6: ≥ 30 settled positions, ROI ≤ −15 %)
| sport | trigger entry | window entry |
|---|---|---|
| NBA 2025-26 (split 2026-02-01) | 216-180 +10.0 % z 2.0, $4 → +$158; disc +7.4 % n276, hold +16.0 % n120 | 159-138 +6.8 % z 1.2 |
| CFB 2025 + 2026 | 94-69 +14.7 % z 1.9, +$96; 2025 +11.6 %, 2026 +17.2 % | 48-40 +9.6 % |
| NFL 2025 + 2026 | 50-47 +3.6 % | 28-35 −9.4 % |
Positive in both halves in NBA and CFB; most of the edge is gone by the bot window → needs an
EARLY-ENTRY lane (bet at the signal, hours before the game), which the lane machinery does not
support yet (lanes see only in-window entries).

## Other
- Team specialists' first buy: NFL +18 % trigger / +36 % window (n 39 / 22), CFB +31 % / +35 %
  (n 26 / 15) — positive, small.
- Fading sharp (S1) first buys: ≈ 0 everywhere one-per-game (the NBA S5 consensus fade lane is a
  different, pre-registered rule and stands).
- NBA A-cell unions (HT, GOOD, NET, S3SQ): positive Oct–Jan, flat/negative Feb–Jun → no NBA
  union lane (GOOD +20 % disc z 2.0 → −5 % hold).
